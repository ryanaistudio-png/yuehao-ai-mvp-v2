require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(tz);

const app = express();
const port = process.env.PORT || 3000;
const timezone = process.env.DEFAULT_TIMEZONE || 'Asia/Taipei';

const SHEETS = {
  week: '01 一週預約表',
  ops: '02 現場操作',
  bookings: '03 預約總表',
  services: '04 服務設定',
  artists: '05 美甲師設定',
  schedule: '06 班表休假設定',
  settings: '90 系統設定',
  slots: '91 可預約時段',
};

const lineConfig = {
  channelAccessToken: requiredEnv('LINE_CHANNEL_ACCESS_TOKEN'),
  channelSecret: requiredEnv('LINE_CHANNEL_SECRET'),
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const sessions = new Map();
const cache = { expiresAt: 0, data: null };
const ANY_ARTIST = '不指定';

app.get('/', (_req, res) => {
  res.json({ ok: true, service: '約好 AI MVP v3', webhook: '/line/webhook' });
});

app.post('/line/webhook', line.middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent).map((p) => p.catch(console.error)));
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId || event.source.groupId || event.source.roomId || 'unknown';
  const text = event.message.text.trim();
  let config = null;
  try {
    const existingSession = sessions.get(userId);
    if (text === '0' && existingSession?.step?.startsWith('staff_')) {
      resetStaffSession(existingSession);
      await safeReplyText(event, userId, buildStaffMenu());
      return;
    }

    if (isFastRestartText(text)) {
      sessions.delete(userId);
      await safeReplyText(event, userId, buildRestartMessage());
      return;
    }

    config = await loadConfig();
    let session = getSession(userId, config);
    rememberUserMessage(session, text);

    const staffAnswer = await handleStaffFlow({ userId, text, session, config });
    if (staffAnswer) {
      await replyWithMemory(event, userId, session, staffAnswer);
      return;
    }

    if (isResetText(text)) {
      sessions.delete(userId);
      cache.expiresAt = 0;
      session = getSession(userId, config);
      await replyWithMemory(event, userId, session, buildRestartMessage());
      return;
    }
    if (isRestartOptionNumber(text, session)) {
      sessions.delete(userId);
      cache.expiresAt = 0;
      session = getSession(userId, config);
      await replyWithMemory(event, userId, session, buildRestartMessage());
      return;
    }
    if (isAbandonBookingText(text) && (isActiveBookingSession(session) || session.step?.startsWith('cancel') || session.step?.startsWith('reschedule'))) {
      sessions.delete(userId);
      await safeReplyText(event, userId, '好的，已取消本次流程。之後需要預約或調整時，請再告訴我。');
      return;
    }
    const local = extractLocalBookingData(text, config);
    adjustAmbiguousTimeWithContext(local.booking, text, session.booking, config.settings);
    logBookingParse('LOCAL_PARSE', text, local.booking);

    const complexAnswer = await handleComplexOrMultiPersonRequest({ userId, text, session, config, local });
    if (complexAnswer) {
      await replyWithMemory(event, userId, session, complexAnswer);
      return;
    }

    if (isGreetingText(text)) {
      await replyWithMemory(event, userId, session, buildRestartMessage());
      return;
    }
    if (isStartBookingText(text)) {
      sessions.delete(userId);
      session = getSession(userId, config);
      session.step = 'ask_service';
      await replyWithMemory(event, userId, session, buildServiceOptions(config));
      return;
    }
    if (session.step === 'start' && ['1', '2'].includes(text)) {
      if (text === '1') {
        session.step = 'ask_service';
        await replyWithMemory(event, userId, session, buildServiceOptions(config));
        return;
      }
      const answer = await handleRescheduleFlow({ userId, text: '我要改時間', ai: emptyAi(), local: extractLocalBookingData('', config), session, config });
      await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (isRescheduleText(text) && !isSlotRefinementText(text, session)) {
      const profile = await getLineProfile(userId);
      const answer = await handleRescheduleFlow({ userId, text, ai: emptyAi(), local: extractLocalBookingData(text, config), session, config });
      await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (isCancelBookingRequestText(text)) {
      const answer = await handleCancelFlow({ userId, text, ai: emptyAi(), session, config });
      await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    const inferredOptionNumber = inferOptionNumberFromText(text, session);
    if (inferredOptionNumber && isStepOptionNumber(String(inferredOptionNumber), session)) {
      const profile = await getLineProfile(userId);
      const answer = await handleOptionNumberSelection({ userId, profile, text: String(inferredOptionNumber), session, config });
      await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (isStepOptionNumber(text, session)) {
      const profile = await getLineProfile(userId);
      const answer = await handleOptionNumberSelection({ userId, profile, text, session, config });
      await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (isStopText(text)) {
      sessions.delete(userId);
      await safeReplyText(event, userId, '好的，先不預約。如需預約再告訴我。');
      return;
    }
    if (session.step === 'confirm_booking' && ['2', '取消', '取消預約'].includes(text)) {
      sessions.delete(userId);
      session = getSession(userId, config);
      await replyWithMemory(event, userId, session, buildRestartMessage());
      return;
    }

    const profile = await getLineProfile(userId);
    const ai = shouldSkipAi(text, session, local)
      ? fallbackExtract(text, config)
      : await understandMessage(text, session, config);
    adjustAmbiguousTimeWithContext(ai.booking, text, session.booking, config.settings);
    const aiOptionNumber = inferOptionNumberFromAi(ai, session);
    if (aiOptionNumber && isStepOptionNumber(String(aiOptionNumber), session)) {
      const answer = await handleOptionNumberSelection({ userId, profile, text: String(aiOptionNumber), session, config });
      await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (ai.intent === 'multi_person') {
      const complexByAi = await handleComplexOrMultiPersonRequest({ userId, text, session, config, local });
      if (!complexByAi) {
        sessions.delete(userId);
        notifyShop(`需要店家確認的多人預約需求\n客人來源：${userId}\n訊息：${text}`, config, 'pending').catch((error) => {
          console.error('notifyShop failed:', error.response?.data || error.message);
        });
      }
      await replyWithMemory(event, userId, session, complexByAi || '多人同行或同時指定多位美甲師，需要店家確認後才能安排。我已先幫您通知店家。');
      return;
    }
    const answer = await runConversation({ userId, profile, text, ai, session, config, local });
    await replyWithMemory(event, userId, session, answer || '我沒有收到完整訊息，請再說一次。');
  } catch (error) {
    console.error('handleEvent failed:', formatErrorForLog(error));
    await safeReplyText(event, userId, buildBusyMessage(config));
  }
}

async function runConversation({ userId, profile, text, ai, session, config, local: providedLocal }) {
  ai = ai || emptyAi();
  const local = providedLocal || extractLocalBookingData(text, config);
  adjustAmbiguousTimeWithContext(local.booking, text, session.booking, config.settings);
  adjustAmbiguousTimeWithContext(ai.booking, text, session.booking, config.settings);
  if (session.step === 'ask_contact') {
    mergeBookingData(session.booking, ai.booking);
    return continueContactStep({ text, session, config });
  }
  const businessDateAnswer = answerBusinessDateQuery(text, config);
  if (businessDateAnswer) return businessDateAnswer;
  const artistStatusAnswer = answerArtistStatusQuery(text, config, local);
  if (artistStatusAnswer) return artistStatusAnswer;
  const priceAnswer = answerPriceQuery(text, config, session, local);
  if (priceAnswer) return priceAnswer;
  const availabilityAnswer = answerAvailabilityQuery(text, config, session, local);
  if (availabilityAnswer) return availabilityAnswer;

  const confirmationAnswer = answerAiConfirmation(ai, session, local);
  if (confirmationAnswer) return confirmationAnswer;

  if (isSlotRefinementText(text, session)) {
    applySlotRefinementText(text, session, local.booking);
    const service = findService(config.services, session.booking.service);
    if (service && session.booking.artist) {
      session.step = 'ask_time';
      return buildAvailableSlots(config, session.booking.artist, service, session.booking);
    }
  }

  if (session.step?.startsWith('reschedule') || ai.intent === 'reschedule' || (isRescheduleText(text) && !isSlotRefinementText(text, session))) {
    return handleRescheduleFlow({ userId, text, ai, local, session, config });
  }

  if (session.step?.startsWith('cancel') || ai.intent === 'cancel') {
    return handleCancelFlow({ userId, text, ai, session, config });
  }

  const isActiveBookingFlow = Boolean(session.booking?.service || session.booking?.artist || session.step?.startsWith('ask_') || session.step === 'confirm_booking');
  if (ai.intent === 'faq' && !(isActiveBookingFlow && (local.booking.date || local.booking.period || local.booking.time))) {
    const faqAnswer = answerFaq(text, config);
    if (faqAnswer) return faqAnswer;
    notifyShop(`待回答問題\n客人來源：${userId}\n訊息：${text}`, config, 'pending').catch((error) => {
      console.error('notifyShop failed:', error.response?.data || error.message);
    });
    return config.settings.ai_fallback_reply || '這個問題我幫您請店家確認。';
  }

  forceSearchCorrectionFromLocalText(ai, local);
  applyQuickReplyNumber(text, session, config);
  if (session.step === 'ask_service_detail' && !session.booking.service) {
    return buildServiceDetailOptions(session.pendingServiceGroup);
  }
  resetChosenTimeIfSearchChanged(session.booking, ai.booking);
  resetChosenTimeIfSearchChanged(session.booking, local.booking);
  mergeBookingData(session.booking, ai.booking);
  mergeBookingData(session.booking, local.booking);
  clearChosenTimeForDateOrPeriodOnlyMessage(session.booking, local.booking);
  logBookingParse('FINAL_BOOKING', text, session.booking);

  if (!session.booking.service) {
    session.step = 'ask_service';
    if (session.booking.date || session.booking.time || session.booking.period) {
      return [
        buildPartialTimeAcknowledgement(session.booking),
        '',
        buildServiceOptions(config),
      ].join('\n');
    }
    return buildServiceOptions(config);
  }

  const service = findService(config.services, session.booking.service);
  if (!service) {
    session.booking.service = '';
    session.step = 'ask_service';
    return `目前沒有找到「${ai.booking.service || text}」。\n\n${buildServiceOptions(config)}`;
  }
  session.booking.service = service.name;
  session.booking.duration = service.duration;

  const activeArtists = getBookableArtists(config, service);
  if (!session.booking.artist && activeArtists.length === 1) {
    session.booking.artist = activeArtists[0].name;
  }

  if (!session.booking.date && session.booking.time) {
    const nearest = findFirstAvailableSlotAtRequestedTime(config.slots, session.booking, service, config.settings);
    if (nearest) {
      session.booking.date = nearest.date;
      session.booking.time = nearest.time;
      session.booking.artist = nearest.artist;
    }
  }

  if (!session.booking.date || !session.booking.time) {
    session.step = 'ask_time';
    const alternatives = findAlternativeArtistSlots(config, session.booking, service);
    if (session.booking.artist && session.booking.date && !findAvailableStartSlots(config.slots, session.booking, service, config.settings).length && alternatives.length) {
      const unavailableArtist = session.booking.artist;
      session.booking.artist = '';
      session.step = 'ask_artist';
      return [
        `${session.booking.date} ${unavailableArtist} 目前沒有足夠的可預約時段，可以換其他美甲師。`,
        '',
        buildArtistOptions(config, service),
      ].join('\n');
    }
    if (session.booking.date && session.booking.period && !session.booking.artist && activeArtists.length > 1) {
      session.step = 'ask_artist';
      return buildArtistOptions(config, service, session.booking);
    }
    return buildAvailableSlots(config, session.booking.artist, service, session.booking);
  }

  if (!isBookingFarEnough(session.booking, config.settings)) {
    const requested = formatFriendlyDateTime(session.booking.date, session.booking.time);
    session.booking.time = '';
    session.step = 'ask_time';
    const hours = Number(config.settings.min_hours_before_booking || 0);
    return `${requested} 太近了，店家最少需要提前 ${hours} 小時預約。\n\n${buildAvailableSlots(config, session.booking.artist, service, session.booking)}`;
  }

  const slots = findConsecutiveSlots(config.slots, session.booking, service, config.settings);
  if (!slots.length) {
    const requested = formatFriendlyDateTime(session.booking.date, session.booking.time);
    session.booking.time = '';
    session.step = 'ask_time';
    const reason = buildUnavailableReason(config, session.booking, service);
    return `${reason || `${requested} 沒有足夠完成「${service.name}」的連續空檔。`}\n\n${buildAvailableSlots(config, session.booking.artist, service, session.booking)}`;
  }

  if (!session.booking.customerName || !session.booking.phone) {
    await hydrateKnownCustomer(session, userId);
  }

  if (!session.booking.customerName || !session.booking.phone) {
    const selectedTimeThisTurn = Boolean(local.booking.time || ai.booking?.time || (session.step === 'ask_time' && /^\d+$/.test(text.trim())));
    session.step = 'ask_contact';
    if (selectedTimeThisTurn) {
      return [
        `可以，先幫您保留 ${formatFriendlyDateTime(session.booking.date, session.booking.time)}。`,
        `服務：${service.name}`,
        `美甲師：${session.booking.artist}`,
        '',
        '最後請留下姓名與手機，例如：王小美 0912345678。',
      ].join('\n');
    }
    return '最後請留下姓名與手機，例如：王小美 0912345678。';
  }

  if (!isValidTaiwanMobile(session.booking.phone)) {
    session.booking.phone = '';
    session.step = 'ask_contact';
    return '手機號碼格式不正確，請留下 09 開頭的 10 碼手機號碼，例如：王小美 0912345678。';
  }

  if (session.step !== 'confirm_booking') {
    session.step = 'confirm_booking';
    return [
      '請確認預約資訊：',
      `服務：${service.name}（約 ${service.duration} 分鐘）`,
      `美甲師：${session.booking.artist}`,
      `時間：${session.booking.date} ${session.booking.time}`,
      `姓名：${session.booking.customerName}`,
      `電話：${session.booking.phone}`,
      '1. 確認預約',
      '2. 取消',
    ].join('\n');
  }

  if (!isConfirmBookingText(text)) {
    return [
      '請用下方按鈕確認或取消預約。',
      '1. 確認預約',
      '2. 取消',
    ].join('\n');
  }

  let booking;
  try {
    booking = await createBooking({
      userId,
      lineDisplayName: profile.displayName || '',
      booking: session.booking,
      service,
    });
  } catch (error) {
    console.error('createBooking failed:', error.response?.data || error.message);
    session.step = 'ask_time';
    session.booking.time = '';
    return [
      '剛剛建立預約時沒有成功，可能是該時段已被預約或系統連線不穩。',
      '',
      buildAvailableSlots(config, session.booking.artist, service, session.booking),
    ].join('\n');
  }
  await lockSlots(slots, booking.bookingId);
  notifyShop(`新預約 ${booking.bookingId}\n客人：${booking.customerName}\n電話：${booking.phone}\n服務：${booking.service}\n美甲師：${booking.artist}\n時間：${booking.date} ${booking.time}`, config, 'new').catch((error) => {
    console.error('notifyShop failed:', error.response?.data || error.message);
  });
  sessions.delete(userId);

  return [
    '預約成功！',
    `預約編號：${shortBookingId(booking.bookingId)}`,
    '',
    `服務：${booking.service}`,
    `美甲師：${booking.artist}`,
    `時間：${booking.date} ${booking.time}`,
    config.settings.shop_address ? `地址：${config.settings.shop_address}` : '',
  ].filter(Boolean).join('\n');
}

async function handleCancelFlow({ userId, text, ai, session, config }) {
  const bookingIdFromText = normalizeShortBookingInput(ai.cancel?.bookingId || text);

  if (session.step === 'cancel_confirm' && isAbortCancelText(text)) {
    sessions.delete(userId);
    session.step = 'start';
    return buildRestartMessage();
  }

  if (session.step === 'cancel_confirm' && isConfirmCancelText(text)) {
    const booking = session.cancelBooking;
    if (!booking) {
      session.step = 'start';
      return '取消資訊已過期，請重新輸入「取消預約」。';
    }
    try {
      await cancelBooking(userId, booking.id);
      await releaseLockedSlots(booking.id);
      notifyShop(`預約已取消 ${booking.id}\n客人：${booking.customer}\n服務：${booking.service}\n美甲師：${booking.artist}\n時間：${booking.date} ${booking.start}`, config, 'cancel').catch((error) => {
        console.error('notifyShop failed:', error.response?.data || error.message);
      });
      sessions.delete(userId);
      return `已取消預約 ${shortBookingId(booking.id)}號。`;
    } catch (error) {
      return `取消失敗：${error.message}。我已保留原預約，請店家協助確認。`;
    }
  }

  const bookings = await loadUserActiveBookings(userId);
  if (!bookings.length) {
    session.step = 'start';
    return '目前沒有找到你可取消的預約。若是店家代訂，請直接聯絡店家協助。';
  }

  let target = null;
  if (bookingIdFromText) {
    target = bookings.find((booking) => bookingIdMatches(booking.id, bookingIdFromText));
  }

  if (!target) {
    session.step = 'cancel_select';
    session.cancelOptions = bookings;
    return [
      '請選擇要取消的預約：',
      ...bookings.map((booking) => `預約編號 ${shortBookingId(booking.id)}號：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`),
      '請直接回覆要取消的預約編號，例如「006」。',
    ].join('\n');
  }

  session.step = 'cancel_confirm';
  session.cancelBooking = target;
  return [
    '請確認是否取消這筆預約：',
    `預約編號：${shortBookingId(target.id)}號`,
    `服務：${target.service}`,
    `美甲師：${target.artist}`,
    `時間：${target.date} ${target.start}`,
    '1. 確認刪除',
    '2. 取消刪除',
    '0. 回首頁',
  ].join('\n');
}

async function handleStaffFlow({ userId, text, session, config }) {
  if (!isStaffCommandText(text, session)) return '';
  if (!isStaffUser(userId)) {
    return '這是店家管理指令，目前此 LINE 帳號尚未開通店家權限。';
  }

  if (text === '店家') {
    session.step = 'staff_menu';
    return buildStaffMenu();
  }

  if (text === '店家模式') {
    resetStaffSession(session);
    return buildStaffMenu();
  }

  if (text === '今日預約' || text === '1' && session.step === 'staff_menu') {
    session.step = 'staff_menu';
    const date = nowInZone().format('YYYY-MM-DD');
    return buildStoreDateBookings(await loadStoreBookingsByDate(date), date, '今日預約');
  }

  if (text === '2' && session.step === 'staff_menu') {
    session.step = 'staff_menu';
    const date = nowInZone().add(1, 'day').format('YYYY-MM-DD');
    return buildStoreDateBookings(await loadStoreBookingsByDate(date), date, '明日預約');
  }

  if (text === '3' && session.step === 'staff_menu') {
    session.step = 'staff_date_lookup';
    return withStaffHomeAction('請輸入要查詢的日期，例如「查日期 5/20」或「明天」。');
  }

  if (text === '4' && session.step === 'staff_menu') {
    session.step = 'staff_lookup';
    return withStaffHomeAction('請輸入要查詢的預約編號，例如「查預約 001」。');
  }

  if (text === '5' && session.step === 'staff_menu') {
    session.step = 'staff_reschedule_wait_id';
    return withStaffHomeAction('請輸入要修改的預約編號，例如「修改 001」。');
  }

  if (text === '6' && session.step === 'staff_menu') {
    session.step = 'staff_cancel_wait_id';
    return withStaffHomeAction('請輸入要取消的預約編號，例如「取消 001」。');
  }

  if (session.step === 'staff_cancel_confirm' && isConfirmCancelText(text)) {
    const booking = session.staffCancelBooking;
    if (!booking) {
      session.step = 'staff_menu';
      return '取消資訊已過期，請重新輸入「取消 001」。';
    }
    const result = await storeCancelBooking(booking.id);
    session.step = 'staff_menu';
    session.staffCancelBooking = null;
    return withStaffHomeAction(`已取消預約 ${shortBookingId(result.bookingId)}號。`);
  }

  if (session.step === 'staff_cancel_confirm' && isAbortCancelText(text)) {
    resetStaffSession(session);
    return buildStaffMenu();
  }

  if (session.step === 'staff_reschedule_confirm' && isConfirmRescheduleText(text)) {
    const draft = session.staffRescheduleDraft;
    if (!draft) {
      session.step = 'staff_reschedule_wait_id';
      return '修改資訊已過期，請重新輸入「修改 001」。';
    }
    const result = await storeRescheduleBooking(draft);
    session.step = 'staff_menu';
    session.staffBooking = null;
    session.staffChange = {};
    session.staffRescheduleDraft = null;
    return withStaffHomeAction([
      '已修改預約！',
      `預約編號：${shortBookingId(result.bookingId)}號`,
      `服務：${result.service}`,
      `美甲師：${result.artist}`,
      `時間：${result.date} ${result.time}`,
    ].join('\n'));
  }

  if (session.step === 'staff_reschedule_confirm' && isAbortRescheduleText(text)) {
    resetStaffSession(session);
    return buildStaffMenu();
  }

  if (session.step?.startsWith('staff_') && isStaffHomeText(text)) {
    resetStaffSession(session);
    return buildStaffMenu();
  }

  const dateLookup = parseStaffDateLookup(text, session);
  if (dateLookup || session.step === 'staff_date_lookup') {
    const date = dateLookup || parseDateText(text);
    if (!date) return withStaffHomeAction('請輸入要查詢的日期，例如「查日期 5/20」或「明天」。');
    session.step = 'staff_menu';
    return buildStoreDateBookings(await loadStoreBookingsByDate(date), date);
  }

  const lookupId = /^查預約/.test(text) ? normalizeShortBookingInput(text) : '';
  if (lookupId || session.step === 'staff_lookup') {
    const bookingId = lookupId || normalizeShortBookingInput(text);
    if (!bookingId) return withStaffHomeAction('請輸入要查詢的預約編號，例如「查預約 001」。');
    session.step = 'staff_menu';
    const booking = await tryLoadStoreBooking(bookingId);
    if (!booking.ok) return withStaffHomeAction(booking.message);
    return withStaffHomeAction(formatStoreBooking(booking.data));
  }

  const cancelId = /^取消\s*\d+|^取消\s*預約\s*\d+/.test(text) ? normalizeShortBookingInput(text) : '';
  if (cancelId || session.step === 'staff_cancel_wait_id') {
    const bookingId = cancelId || normalizeShortBookingInput(text);
    if (!bookingId) return withStaffHomeAction('請輸入要取消的預約編號，例如「取消 001」。');
    const loaded = await tryLoadStoreBooking(bookingId);
    if (!loaded.ok) return withStaffHomeAction(loaded.message);
    const booking = loaded.data;
    session.step = 'staff_cancel_confirm';
    session.staffCancelBooking = booking;
    return [
      '請確認是否取消這筆預約：',
      formatStoreBooking(booking),
      '',
      '1. 確認刪除',
      '2. 取消刪除',
      '0. 店家模式',
    ].join('\n');
  }

  const modifyId = /^修改\s*\d+|^修改\s*預約\s*\d+/.test(text) ? normalizeShortBookingInput(text) : '';
  if (modifyId || session.step === 'staff_reschedule_wait_id') {
    const bookingId = modifyId || normalizeShortBookingInput(text);
    if (!bookingId) return withStaffHomeAction('請輸入要修改的預約編號，例如「修改 001」。');
    const loaded = await tryLoadStoreBooking(bookingId);
    if (!loaded.ok) return withStaffHomeAction(loaded.message);
    const booking = loaded.data;
    session.step = 'staff_reschedule_change';
    session.staffBooking = booking;
    session.staffChange = {};
    return withStaffHomeAction([
      '我找到這筆預約：',
      formatStoreBooking(booking),
      '',
      '請輸入新的日期與時間，例如「5/20 下午 4 點」。',
    ].join('\n'));
  }

  if (session.step === 'staff_reschedule_change') {
    return handleStaffRescheduleChange({ text, session, config });
  }

  return '';
}

async function tryLoadStoreBooking(bookingId) {
  try {
    return { ok: true, data: await loadStoreBooking(bookingId) };
  } catch (error) {
    if (isExpectedBookingLookupError(error)) {
      return { ok: false, message: `${error.message}\n請確認編號後再試一次，例如「查預約 001」。` };
    }
    throw error;
  }
}

function isExpectedBookingLookupError(error) {
  const message = String(error?.message || '');
  return message.includes('找不到預約編號') || message.includes('找到多筆短編號') || message.includes('請輸入預約編號');
}

function isStaffCommandText(text, session) {
  if (session.step?.startsWith('staff_')) return true;
  return text === '店家'
    || text === '店家模式'
    || text === '今日預約'
    || text === '明日預約'
    || /^查日期/.test(text)
    || /^查預約\s*\d+/.test(text)
    || /^修改\s*(預約\s*)?\d+/.test(text)
    || /^取消\s*(預約\s*)?\d+/.test(text);
}

function resetStaffSession(session) {
  session.step = 'staff_menu';
  session.staffBooking = null;
  session.staffChange = {};
  session.staffCancelBooking = null;
  session.staffRescheduleDraft = null;
  session.staffSlotOptions = null;
}

function isStaffHomeText(text) {
  return ['0', '店家模式', '回店家模式', '回首頁', '取消修改', '取消刪除', '取消', '不用了'].includes(String(text || '').trim());
}

function isStaffUser(userId) {
  const ids = [process.env.SHOP_NOTIFY_LINE_ID, process.env.SHOP_STAFF_LINE_IDS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!ids.length) return true;
  return ids.includes(userId);
}

function buildStaffMenu() {
  return [
    '店家模式',
    '1. 今日預約',
    '2. 明日預約',
    '3. 查日期',
    '4. 查預約',
    '5. 修改預約',
    '6. 取消預約',
  ].join('\n');
}

function buildStoreTodayBookings(bookings) {
  const date = nowInZone().format('YYYY-MM-DD');
  return buildStoreDateBookings(bookings, date, '今日預約');
}

function buildStoreDateBookings(bookings, date, title = '') {
  const heading = title || `${formatDateWithWeekday(date)} 預約`;
  if (!bookings.length) return withStaffHomeAction(`${heading}：目前沒有預約。`);
  return withStaffHomeAction([
    `${heading}：`,
    ...bookings.map((booking) => `${shortBookingId(booking.id)}｜${booking.start}｜${booking.artist}｜${booking.service}｜${booking.customer}｜${booking.phone}`),
  ].join('\n'));
}

function parseStaffDateLookup(text, session) {
  const value = String(text || '').trim();
  if (value === '明日預約') return nowInZone().add(1, 'day').format('YYYY-MM-DD');
  if (value === '今日預約') return nowInZone().format('YYYY-MM-DD');
  if (/^查日期/.test(value)) return parseDateText(value.replace(/^查日期/, '').trim());
  if (session.step === 'staff_date_lookup') return parseDateText(value);
  return '';
}

function withStaffHomeAction(message) {
  const text = String(message || '').trimEnd();
  if (!text) return '0. 店家模式';
  if (text.includes('0. 店家模式')) return text;
  return `${text}\n0. 店家模式`;
}

function formatStoreBooking(booking) {
  return [
    `預約編號：${shortBookingId(booking.id)}號`,
    `狀態：${booking.status}`,
    `客人：${booking.customer}`,
    `電話：${booking.phone}`,
    `服務：${booking.service}`,
    `美甲師：${booking.artist}`,
    `時間：${booking.date} ${booking.start}-${booking.end}`,
  ].join('\n');
}

function handleStaffRescheduleChange({ text, session, config }) {
  const booking = session.staffBooking;
  if (!booking) {
    session.step = 'staff_reschedule_wait_id';
    return '修改資訊已過期，請重新輸入「修改 001」。';
  }
  if (/^\d+$/.test(text.trim()) && Array.isArray(session.staffSlotOptions)) {
    const slot = session.staffSlotOptions[Number(text.trim()) - 1];
    if (slot) {
      session.staffChange.date = slot.date;
      session.staffChange.time = slot.time;
      session.staffChange.artist = slot.artist;
    }
  }

  const local = extractLocalBookingData(text, config);
  mergeBookingData(session.staffChange, local.booking);
  if ((local.booking.date || local.booking.period || local.booking.artist) && !local.booking.time) {
    session.staffChange.time = '';
  }
  const change = session.staffChange || {};
  const hasChangedTime = Object.prototype.hasOwnProperty.call(change, 'time');
  const next = {
    bookingId: booking.id,
    service: change.service || booking.service,
    artist: change.artist || booking.artist,
    date: change.date || booking.date,
    time: hasChangedTime ? change.time : booking.start,
  };
  const service = findService(config.services, next.service);
  if (!service) {
    session.staffChange.service = '';
    return `找不到「${next.service}」服務，請重新輸入。`;
  }
  const artist = config.artists.find((item) => item.name === next.artist);
  if (!artist) {
    session.staffChange.artist = '';
    return `找不到「${next.artist}」這位美甲師，請重新輸入。`;
  }
  if (!change.date && !change.time && !change.period && !change.artist) {
    return '請輸入新的日期與時間，例如「5/20 下午 4 點」。';
  }
  if (!next.date || !next.time) {
    session.step = 'staff_reschedule_change';
    return buildStaffRescheduleSlotOptions({ config, session, booking, next, change, service });
  }
  const slots = findConsecutiveSlots(config.slots, next, service, config.settings, booking.id);
  if (!isBookingFarEnough(next, config.settings) || !slots.length) {
    session.step = 'staff_reschedule_change';
    return buildStaffRescheduleSlotOptions({ config, session, booking, next, change, service, requestedTime: next.time });
  }
  session.step = 'staff_reschedule_confirm';
  session.staffRescheduleDraft = next;
  return [
    `是否將預約 ${shortBookingId(booking.id)}號修改為以下內容？`,
    '',
    `原本：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`,
    `改成：${next.date} ${next.time}｜${next.artist}｜${service.name}`,
    '',
    '1. 確認修改',
    '2. 取消修改',
    '0. 店家模式',
  ].join('\n');
}

function buildStaffRescheduleSlotOptions({ config, session, booking, next, change, service, requestedTime = '' }) {
  const suggestions = findAvailableStartSlots(config.slots, {
    artist: next.artist,
    date: next.date,
    period: change.period || '',
  }, service, config.settings, booking.id).slice(0, 6);
  session.staffSlotOptions = suggestions;
  const reason = buildUnavailableReason(config, { ...next, time: requestedTime || next.time }, service);
  return withStaffHomeAction([
    reason || `${next.date || '指定日期'} ${next.time || ''} 目前沒有足夠完成「${service.name}」的連續空檔。`,
    suggestions.length ? '可改約以下時段：' : '請換日期、時段或美甲師。',
    ...suggestions.map((slot, index) => `${index + 1}. ${slot.date} ${slot.time}｜${slot.artist}`),
  ].join('\n'));
}

async function understandMessage(text, session, config) {
  const now = nowInZone();
  const prompt = [
    config.settings.ai_system_prompt || '你是約好 AI 的美甲預約助理。',
    config.settings.ai_booking_rules || '每次只問一個問題，不重複詢問已提供資訊。',
    '請只輸出 JSON，不要加任何解釋。',
    '可用 intent: booking, cancel, reschedule, faq, price, availability, artist_status, multi_person, unknown。',
    'booking 欄位可包含 service, artist, date, time, customerName, phone, note。',
    'cancel 欄位可包含 bookingId。',
    '另可輸出 confidence(0到1), needsConfirmation(boolean), confirmationQuestion(string), peopleCount(number), artists(array), selectedOptionNumber(number), selectedOptionLabel(string)。',
    'date 請輸出 YYYY-MM-DD；time 請輸出 HH:mm；若只有上午/下午/晚上，請放 period。若不確定就留空字串。',
    '每一則訊息都要先判斷客人真正目的，不要只照前一步流程走；AI 只負責理解，最後是否能預約由程式判斷。',
    '如果客人訊息是在回答「上一題選項」，請輸出 selectedOptionNumber 或 selectedOptionLabel，不要另開新流程。',
    '如果客人用文字回答上一題，例如「Amy」「Bella」「款式諮詢」「第二個」，請對照上一題選項理解。',
    '如果客人說「我要改預約時間」「可以提前嗎」「改晚一點」「改約星期三」，intent 必須是 reschedule。',
    '如果客人表達提前、延後、改晚一點、改早一點、換日期、換時間、改約某天、改預約時間，intent 必須是 reschedule。',
    '如果客人說「取消預約」「我要取消預約」「取消006」，intent 是 cancel；如果只是「算了」「不約了」「取消」可能是放棄本次流程。',
    '如果客人問「3點可以嗎」「15號下午」「晚上有嗎」，且正在預約流程中，intent 是 booking，並盡量輸出 date/time/period。',
    '如果客人同時提到兩位美甲師、兩個人、雙人、朋友一起做，intent 必須是 multi_person。',
    '如果客人問可預約時間，不能建議已經過去或太接近現在的時間。',
    '如果語意不明，intent 用 unknown，needsConfirmation=true，confirmationQuestion 用一句中文向客人確認，不要硬猜。',
    `目前時間：${now.format('YYYY-MM-DD HH:mm')}，時區：${timezone}`,
    `服務項目：${config.services.map((s) => `${s.name}(${s.duration}分鐘)`).join('、')}`,
    `美甲師：${config.artists.map((a) => a.name).join('、')}`,
    `目前對話狀態：${JSON.stringify(session.booking)}`,
    `上一題：${session.lastBotQuestion || ''}`,
    `上一題選項：${formatLastOptions(session)}`,
    `最近對話：${formatSessionHistory(session)}`,
    `客人訊息：${text}`,
  ].join('\n');

  try {
    const raw = await callAiProvider(prompt, config);
    const parsed = normalizeAiJson(JSON.parse(raw || '{}'));
    logAiDecision(text, parsed);
    return parsed;
  } catch (error) {
    console.error('AI parse failed:', error.response?.data || error.message);
    const fallback = fallbackExtract(text, config);
    logAiDecision(text, fallback, 'fallback');
    return fallback;
  }
}

async function callAiProvider(prompt, config) {
  const provider = String(process.env.AI_PROVIDER || 'deepseek').trim().toLowerCase();
  if (provider === 'openai') return callOpenAi(prompt, config);
  if (provider === 'deepseek') return callDeepSeek(prompt, config);
  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
}

async function callOpenAi(prompt, config) {
  const response = await axios.post(
    `${process.env.OPENAI_BASE_URL || 'https://api.openai.com'}/v1/chat/completions`,
    {
      model: process.env.OPENAI_MODEL || process.env.AI_MODEL || 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: Number(config.settings.max_ai_tokens || 800),
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${requiredEnv('OPENAI_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return response.data.choices?.[0]?.message?.content || '{}';
}

async function callDeepSeek(prompt, config) {
  const response = await axios.post(
    `${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`,
    {
      model: process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: Number(config.settings.max_ai_tokens || 800),
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${requiredEnv('DEEPSEEK_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return response.data.choices?.[0]?.message?.content || '{}';
}

function logAiDecision(text, ai, source = process.env.AI_PROVIDER || 'deepseek') {
  const summary = {
    source,
    text: String(text || '').slice(0, 120),
    intent: ai.intent,
    service: ai.booking?.service || '',
    artist: ai.booking?.artist || '',
    date: ai.booking?.date || '',
    time: ai.booking?.time || '',
    period: ai.booking?.period || '',
    cancelBookingId: ai.cancel?.bookingId || '',
    selectedOptionNumber: ai.selectedOptionNumber || 0,
    selectedOptionLabel: ai.selectedOptionLabel || '',
    confidence: ai.confidence || 0,
    needsConfirmation: Boolean(ai.needsConfirmation),
  };
  console.log(`AI_DECISION ${JSON.stringify(summary)}`);
}

function logBookingParse(label, text, booking = {}) {
  const summary = {
    text: String(text || '').slice(0, 120),
    service: booking.service || '',
    artist: booking.artist || '',
    date: booking.date || '',
    time: booking.time || '',
    period: booking.period || '',
    customerName: booking.customerName ? '[filled]' : '',
    phone: booking.phone ? '[filled]' : '',
  };
  console.log(`${label} ${JSON.stringify(summary)}`);
}

function normalizeAiJson(json) {
  return {
    intent: json.intent || 'unknown',
    confidence: Number(json.confidence || 0),
    needsConfirmation: Boolean(json.needsConfirmation),
    confirmationQuestion: json.confirmationQuestion || '',
    peopleCount: Number(json.peopleCount || 0),
    artists: Array.isArray(json.artists) ? json.artists : [],
    selectedOptionNumber: Number(json.selectedOptionNumber || 0),
    selectedOptionLabel: json.selectedOptionLabel || '',
    booking: {
      service: json.booking?.service || '',
      artist: json.booking?.artist || '',
      date: json.booking?.date || '',
      time: normalizeTime(json.booking?.time || ''),
      customerName: json.booking?.customerName || '',
      phone: json.booking?.phone || '',
      note: json.booking?.note || '',
      period: json.booking?.period || '',
    },
    cancel: {
      bookingId: json.cancel?.bookingId || '',
    },
  };
}

function emptyAi() {
  return {
    intent: 'unknown',
    confidence: 0,
    needsConfirmation: false,
    confirmationQuestion: '',
    peopleCount: 0,
    artists: [],
    selectedOptionNumber: 0,
    selectedOptionLabel: '',
    booking: { service: '', artist: '', date: '', time: '', customerName: '', phone: '', note: '', period: '' },
    cancel: { bookingId: '' },
  };
}

function fallbackExtract(text, config = { services: [], artists: [] }) {
  const phone = extractTaiwanMobile(text);
  const local = extractLocalBookingData(text, config);
  return {
    intent: isRescheduleText(text) ? 'reschedule' : text.includes('取消') ? 'cancel' : 'booking',
    confidence: 0,
    needsConfirmation: false,
    confirmationQuestion: '',
    peopleCount: isMultiPersonBookingText(text) ? 2 : 0,
    artists: findMentionedArtists(text, config.artists),
    selectedOptionNumber: 0,
    selectedOptionLabel: '',
    booking: {
      service: local.booking.service || '',
      artist: local.booking.artist || '',
      date: local.booking.date || '',
      time: local.booking.time || normalizeTime(text.match(/(\d{1,2})[:：點](\d{2})?/)?.[0] || ''),
      customerName: phone ? text.replace(phone, '').trim() : '',
      phone,
      note: text,
      period: local.booking.period || '',
    },
    cancel: { bookingId: text.match(/\d+/)?.[0] || '' },
  };
}

function continueContactStep({ text, session, config }) {
  const phone = extractTaiwanMobile(text);
  if (phone) {
    session.booking.phone = phone;
    const name = String(text || '').replace(phone, '').replace(/[，,。.\s]+/g, '').trim();
    if (name) session.booking.customerName = name;
  } else if (/\d/.test(text)) {
    session.booking.phone = '';
    return '手機號碼格式不正確，請留下 09 開頭的 10 碼手機號碼，例如：王小美 0912345678。';
  } else if (!session.booking.customerName) {
    session.booking.customerName = String(text || '').trim();
  }

  if (!session.booking.customerName || !session.booking.phone) {
    if (session.booking.phone) return '已收到手機，請再留下姓名，例如：王小美。';
    if (session.booking.customerName) return '已收到姓名，請再留下 09 開頭的 10 碼手機號碼，例如：0912345678。';
    return '最後請留下姓名與手機，例如：王小美 0912345678。';
  }

  if (!isValidTaiwanMobile(session.booking.phone)) {
    session.booking.phone = '';
    return '手機號碼格式不正確，請留下 09 開頭的 10 碼手機號碼，例如：王小美 0912345678。';
  }

  const service = findService(config.services, session.booking.service) || { name: session.booking.service, duration: session.booking.duration || '' };
  session.step = 'confirm_booking';
  return [
    '請確認預約資訊：',
    `服務：${service.name}${service.duration ? `（約 ${service.duration} 分鐘）` : ''}`,
    `美甲師：${session.booking.artist}`,
    `時間：${session.booking.date} ${session.booking.time}`,
    `姓名：${session.booking.customerName}`,
    `電話：${session.booking.phone}`,
    '1. 確認預約',
    '2. 取消',
  ].join('\n');
}

function isValidTaiwanMobile(phone) {
  return /^09\d{8}$/.test(String(phone || '').trim());
}

function extractTaiwanMobile(text) {
  const match = String(text || '').match(/(?:^|[^\d])(09\d{8})(?!\d)/);
  return match?.[1] || '';
}

async function loadConfig() {
  if (cache.data && Date.now() < cache.expiresAt) return cache.data;
  const data = await appsScriptRequest('getConfig');
  cache.data = normalizeConfig(data);
  cache.expiresAt = Date.now() + 60 * 1000;
  return cache.data;
}

function normalizeConfig(data = {}) {
  return {
    ...data,
    services: (data.services || []).map((service) => ({
      ...service,
      name: String(service.name || '').trim(),
    })),
    artists: (data.artists || []).map((artist) => ({
      ...artist,
      name: String(artist.name || '').trim(),
      status: String(artist.status || '').trim(),
      note: String(artist.note || '').trim(),
    })),
    specials: (data.specials || []).map((special) => ({
      ...special,
      artist: String(special.artist || '').trim(),
      date: String(special.date || '').trim(),
      type: String(special.type || '').trim(),
      start: Number(special.start || 0),
      end: Number(special.end || 24 * 60),
      note: String(special.note || '').trim(),
    })),
    slots: (data.slots || []).map((slot) => ({
      ...slot,
      artist: String(slot.artist || '').trim(),
      status: String(slot.status || '').trim(),
      lockedBookingId: String(slot.lockedBookingId || '').trim(),
      time: normalizeTime(slot.time),
    })),
  };
}

async function createBooking({ userId, lineDisplayName, booking, service }) {
  const result = await appsScriptRequest('createBooking', {
    booking: {
      customerName: booking.customerName,
      phone: booking.phone,
      artist: booking.artist,
      service: service.name,
      date: booking.date,
      time: booking.time,
      note: booking.note || '',
      lineUserId: userId,
      lineDisplayName: lineDisplayName || '',
    },
  });
  if (!result?.bookingId) {
    throw new Error(`Apps Script did not return bookingId for createBooking: ${safeJson(result)}`);
  }
  cache.expiresAt = 0;
  return result;
}

async function loadUserActiveBookings(userId) {
  const bookings = await appsScriptRequest('getUserActiveBookings', { userId });
  return bookings
    .filter((booking) => parseDateTimeInZone(booking.date, booking.start).isAfter(nowInZone().subtract(1, 'day')))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

async function loadCustomerProfile(userId) {
  if (!userId || !userId.startsWith('U')) return null;
  return appsScriptRequest('getCustomerProfile', { userId });
}

async function hydrateKnownCustomer(session, userId) {
  if (session.customerProfileLoaded) return;
  session.customerProfileLoaded = true;
  try {
    const customer = await loadCustomerProfile(userId);
    if (!customer) return;
    if (!session.booking.customerName && customer.customerName) session.booking.customerName = customer.customerName;
    if (!session.booking.phone && customer.phone) session.booking.phone = customer.phone;
  } catch (error) {
    console.error('loadCustomerProfile failed:', error.response?.data || error.message);
  }
}

async function cancelBooking(userId, bookingId) {
  await appsScriptRequest('cancelBooking', { userId, bookingId });
  cache.expiresAt = 0;
  return bookingId;
}

async function rescheduleBooking(userId, booking) {
  const result = await appsScriptRequest('updateBooking', { userId, booking });
  cache.expiresAt = 0;
  return result;
}

async function loadStoreTodayBookings() {
  return appsScriptRequest('getStoreTodayBookings');
}

async function loadStoreBookingsByDate(date) {
  return appsScriptRequest('getStoreBookingsByDate', { date });
}

async function loadStoreBooking(bookingId) {
  return appsScriptRequest('getStoreBooking', { bookingId });
}

async function storeCancelBooking(bookingId) {
  const result = await appsScriptRequest('storeCancelBooking', { bookingId });
  cache.expiresAt = 0;
  return result;
}

async function storeRescheduleBooking(booking) {
  const result = await appsScriptRequest('storeUpdateBooking', { booking });
  cache.expiresAt = 0;
  return result;
}

async function lockSlots(slots, bookingId) {
  return { slots, bookingId };
}

async function releaseLockedSlots(bookingId) {
  return { bookingId };
}

function buildServiceOptions(config) {
  const services = (config.services || []).slice(0, 12);
  return [
    '想預約什麼服務？',
    ...services.map((service, index) => `${index + 1}. ${formatServiceOptionLabel(service)}`),
    restartOptionLine(),
    '可以點下方選項，也可以直接輸入服務名稱。',
  ].join('\n');
}

function formatServiceOptionLabel(service = {}) {
  return `${formatServiceMenuName(service)} ${service.duration}分 ${formatServicePrice(service)}`;
}

function buildServiceGroups(services = []) {
  const activeServices = Array.isArray(services) ? services : [];
  const groups = new Map();
  activeServices.forEach((service, index) => {
    const duration = Number(service.duration || 0) || 30;
    if (!groups.has(duration)) groups.set(duration, []);
    groups.get(duration).push({ ...service, originalIndex: index });
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([duration, items]) => ({ duration, services: items }));
}

function formatServiceGroupNames(services = []) {
  return services.map((service) => formatServiceMenuName(service)).join(' / ');
}

function buildServiceDetailOptions(group) {
  if (!group?.services?.length) return '請重新選擇服務項目。';
  return [
    `請問您要預約哪一項？`,
    ...group.services.map((service, index) => `${index + 1}. ${formatServiceMenuName(service)}`),
    restartOptionLine(),
    '請直接回覆編號。',
  ].join('\n');
}

function formatServiceMenuName(service = {}) {
  const name = service.name || '';
  if (!isFreeService(service)) return name;
  if (name.includes('款式諮詢/簡易服務')) return name.replace('款式諮詢/簡易服務', '款式諮詢（免費）/簡易服務');
  if (name.includes('款式咨詢/簡易服務')) return name.replace('款式咨詢/簡易服務', '款式咨詢（免費）/簡易服務');
  return `${name}（免費）`;
}

function isFreeService(service = {}) {
  const price = String(service.price ?? '').trim();
  return service.name?.includes('款式諮詢') || service.name?.includes('款式咨詢') || service.name?.includes('諮詢') || service.name?.includes('咨詢') || price === '0' || price === '免費';
}

function isAnyArtist(artist) {
  return String(artist || '').trim() === ANY_ARTIST;
}

function buildRestartMessage() {
  return [
    '請問您想預約，還是要改時間呢？',
    '1. 📅 我要預約',
    '2. ✏️ 改時間',
  ].join('\n');
}

function buildBusyMessage(config) {
  const phone = getShopPhone(config);
  return [
    phone
      ? `系統暫時忙碌，請稍後再試；若急著預約，請直接聯絡店家：${phone}`
      : '系統暫時忙碌，請稍後再試；若急著預約，請直接聯絡店家協助。',
    '',
    restartOptionLine(),
  ].join('\n');
}

function getShopPhone(config) {
  return String(
    process.env.SHOP_PHONE
    || config?.settings?.shop_phone
    || config?.settings?.store_phone
    || config?.settings?.phone
    || ''
  ).trim();
}

function buildPartialTimeAcknowledgement(booking) {
  if (booking.date && booking.time) {
    return `好的，我先幫您看 ${formatFriendlyDateTime(booking.date, booking.time)} 的預約。`;
  }
  if (booking.date && booking.period) {
    return `好的，我先幫您看 ${booking.date} ${periodLabel(booking.period)} 的預約。`;
  }
  if (booking.date) {
    return `好的，我先幫您看 ${booking.date} 的預約。`;
  }
  if (booking.period) {
    return `好的，我先幫您看${periodLabel(booking.period)}的預約。`;
  }
  return '好的，我先幫您看可預約時段。';
}

function buildArtistOptions(config, service, booking = {}) {
  const artists = getAvailableArtistsForBooking(config, service, booking);
  const showSpecialty = isSettingEnabled(config.settings.show_artist_specialty_in_line);
  if (!artists.length) {
    return buildNoAvailableSlotsMessage(config, '', service, booking);
  }
  return [
    `想指定哪位美甲師做「${service.name}」嗎？`,
    ...artists.map((artist, index) => showSpecialty && artist.note ? `${index + 1}. ${artist.name}｜${artist.note}` : `${index + 1}. ${artist.name}`),
    `${artists.length + 1}. ${ANY_ARTIST}`,
    restartOptionLine(),
    '請直接回覆編號。',
  ].join('\n');
}

function buildAvailableSlots(config, artist, service, booking = {}) {
  if (!booking.date) return buildDateOptions(config, artist, service, booking);
  if (!booking.period) return buildPeriodOptions(config, artist, service, booking);
  if (!artist) return buildArtistOptions(config, service, booking);
  const candidates = findAvailableStartSlots(config.slots, { ...booking, artist }, service, config.settings).slice(0, 11);
  if (!candidates.length) {
    logSlotDebug('time_options_empty', config, artist, service, booking, candidates);
    return buildNoAvailableSlotsMessage(config, artist, service, booking);
  }
  return [
    `${isAnyArtist(artist) ? '不指定美甲師' : artist} 做「${service.name}」約 ${service.duration} 分鐘，${booking.date} ${periodLabel(booking.period)}可以預約以下時段：`,
    ...candidates.map((slot, index) => `${index + 1}. ${slot.time}｜${slot.artist}`),
    restartOptionLine(),
    '請直接回覆上面的編號數字，或輸入您希望的日期與時間（例如：5/20 1600）。',
  ].join('\n');
}

function getBookableArtists(config, service) {
  return artistsForService(config.artists, service).slice(0, 3);
}

function getAvailableArtistsForBooking(config, service, booking = {}) {
  const artists = getBookableArtists(config, service);
  if (!booking.date || !booking.period) return artists;
  const diagnostics = artists.map((artist) => {
    const slots = findAvailableStartSlots(
      config.slots,
      { ...booking, artist: artist.name },
      service,
      config.settings
    );
    return {
      artist,
      count: slots.length,
      firstSlots: slots.slice(0, 5).map((slot) => `${slot.date} ${slot.time}`),
    };
  });
  console.log(`ARTIST_OPTION_DEBUG ${JSON.stringify({
    service: service?.name || '',
    duration: service?.duration || '',
    date: booking.date || '',
    period: booking.period || '',
    artists: diagnostics.map((item) => ({
      name: item.artist.name,
      count: item.count,
      firstSlots: item.firstSlots,
    })),
  })}`);
  return diagnostics.filter((item) => item.count).map((item) => item.artist);
}

function buildDateOptions(config, artist, service, booking = {}) {
  const dates = getAvailableDateOptions(config, artist, service, booking).slice(0, 5);
  logSlotDebug('date_options', config, artist, service, booking, dates);
  if (!dates.length) return buildNoAvailableSlotsMessage(config, artist, service, booking);
  const artistLabel = artist ? `${artist} 做` : '';
  return [
    `${artistLabel}「${service.name}」約 ${service.duration} 分鐘，想預約哪一天？`,
    ...dates.map((date, index) => `${index + 1}. ${formatDateWithWeekday(date)}`),
    restartOptionLine(),
    '也可以直接輸入日期，例如：5/20。',
  ].join('\n');
}

function buildPeriodOptions(config, artist, service, booking = {}) {
  const periods = getAvailablePeriodOptions(config, artist, service, booking);
  if (!periods.length) return buildNoAvailableSlotsMessage(config, artist, service, booking);
  const artistLabel = artist ? `${artist} 做` : '';
  return [
    `${artistLabel}「${service.name}」，${formatDateWithWeekday(booking.date)} 想預約哪個時段？`,
    ...periods.map((period, index) => `${index + 1}. ${periodLabel(period)}`),
    restartOptionLine(),
    '也可以直接輸入時間，例如：11:00。',
  ].join('\n');
}

function getAvailableDateOptions(config, artist, service, booking = {}) {
  const artists = artist && !isAnyArtist(artist) ? [{ name: artist }] : getBookableArtists(config, service);
  const dates = artists.flatMap((item) => {
    const slots = findAvailableStartSlots(config.slots, { ...booking, artist: item.name, date: '', period: '' }, service, config.settings);
    return slots.map((slot) => slot.date);
  });
  return [...new Set(dates)].sort();
}

function getAvailablePeriodOptions(config, artist, service, booking = {}) {
  const artists = artist && !isAnyArtist(artist) ? [{ name: artist }] : getBookableArtists(config, service);
  const slots = artists.flatMap((item) => findAvailableStartSlots(config.slots, { ...booking, artist: item.name, period: '' }, service, config.settings));
  const periods = ['morning', 'afternoon', 'evening'];
  return periods.filter((period) => slots.some((slot) => isInPeriod(slot.time, period)));
}

function logSlotDebug(stage, config, artist, service, booking = {}, options = []) {
  const debugArtists = artist && !isAnyArtist(artist) ? [artist] : getBookableArtists(config, service).map((item) => item.name);
  const artistSlots = (config.slots || []).filter((slot) => !debugArtists.length || debugArtists.includes(slot.artist));
  const openSlots = artistSlots.filter((slot) => isSlotOpenForBooking(slot));
  const starts = service ? debugArtists.flatMap((name) => findAvailableStartSlots(config.slots || [], { ...booking, artist: name }, service, config.settings || {})) : [];
  console.log(`SLOT_DEBUG ${JSON.stringify({
    stage,
    artist,
    service: service?.name || '',
    date: booking.date || '',
    period: booking.period || '',
    totalArtistSlots: artistSlots.length,
    openArtistSlots: openSlots.length,
    consecutiveStarts: starts.length,
    firstStarts: starts.slice(0, 5).map((slot) => `${slot.date} ${slot.time}`),
    options: options.slice(0, 5),
  })}`);
}

function restartOptionLine() {
  return '0. 重新開始';
}

function buildNoAvailableSlotsMessage(config, artist, service, booking = {}) {
  const reason = buildUnavailableReason(config, { ...booking, artist }, service);
  if (reason) return withNoSlotActions(reason);

  const scope = [
    booking.date ? booking.date : '',
    booking.period ? periodLabel(booking.period) : '',
  ].filter(Boolean).join(' ');
  const prefix = scope ? `${scope} ` : '';

  if (booking.date) {
    const daySlots = (config.slots || []).filter((slot) => slot.date === booking.date);
    if (!daySlots.length) {
      return withNoSlotActions(`${booking.date} 目前沒有開放預約，可能是店休、休假日或班表尚未建立。請換其他日期。`);
    }

    const artistDaySlots = artist && !isAnyArtist(artist) ? daySlots.filter((slot) => slot.artist === artist) : daySlots;
    if (!artistDaySlots.length) {
      return withNoSlotActions(`${booking.date} ${artist} 休假或未開放預約，請換其他日期、時段或美甲師。`);
    }

    const openSlots = artistDaySlots.filter((slot) => isSlotOpenForBooking(slot) && isFutureEnough(slot, config.settings));
    if (!openSlots.length) {
      return withNoSlotActions(`${prefix}${artist} 目前沒有可預約空檔，可能已滿、休假或已超過可預約時間。請換其他日期、時段或美甲師。`);
    }
  }

  const message = `${prefix}目前沒有足夠完成「${service.name}」的連續空檔，請換其他日期、時段或美甲師。`;
  return booking.date ? withNoSlotActions(message) : [message, restartOptionLine()].join('\n');
}

function buildUnavailableReason(config, booking = {}, service = {}) {
  const holiday = findHolidayConflict(config, booking, service);
  if (holiday) {
    const date = booking.date || holiday.date;
    const time = booking.time ? ` ${booking.time}` : '';
    const note = holiday.note ? `（${holiday.note}）` : '';
    if (holiday.artist === '全店') return `${date}${time} 是全店休假${note}，請換其他日期。`;
    return `${date}${time} ${holiday.artist} 休假${note}，請換其他日期、時段或美甲師。`;
  }
  if (booking.date) {
    const daySlots = (config.slots || []).filter((slot) => slot.date === booking.date);
    if (!daySlots.length) return `${booking.date} 目前沒有開放預約，可能是店休、休假日或班表尚未建立。請換其他日期。`;

    const artist = booking.artist && !isAnyArtist(booking.artist) ? booking.artist : '';
    if (artist) {
      const artistDaySlots = daySlots.filter((slot) => slot.artist === artist);
      if (!artistDaySlots.length) return `${booking.date} ${artist} 休假或未開放預約，請換其他日期、時段或美甲師。`;

      if (booking.time && !artistDaySlots.some((slot) => slot.time === normalizeTime(booking.time))) {
        return `${booking.date} ${booking.time} ${artist} 未開放預約，可能是休假或非上班時間。請換其他時間或美甲師。`;
      }
    }
  }
  return '';
}

function findHolidayConflict(config, booking = {}, service = {}) {
  if (!booking.date) return null;
  const artist = booking.artist && !isAnyArtist(booking.artist) ? booking.artist : '';
  const start = booking.time ? timeToMinutes(booking.time) : null;
  const duration = Number(service.duration || booking.duration || 0) || Number(config?.settings?.slot_minutes || 30);
  const end = start === null ? null : start + duration;
  const holidays = (config.specials || []).filter((special) => (
    special.date === booking.date
    && special.type === '休假'
    && (special.artist === '全店' || !artist || special.artist === artist)
  ));
  if (!holidays.length) return null;
  const fullDay = holidays.find((special) => Number(special.start || 0) <= 0 && Number(special.end || 0) >= 24 * 60);
  if (fullDay) return fullDay;
  if (start === null || end === null) return holidays[0];
  return holidays.find((special) => start < Number(special.end || 0) && end > Number(special.start || 0)) || null;
}

function withNoSlotActions(message) {
  return [
    message,
    '',
    '1. 選擇其他日期',
    '2. 選擇其他時段',
    '3. 選擇其他美甲師',
    restartOptionLine(),
  ].join('\n');
}

function isSlotRefinementText(text, session) {
  if (session.step !== 'ask_time') return false;
  if (!session.booking?.service || !session.booking?.artist) return false;
  return /(晚一點|晚點|晚些|更晚|晚上的?|下午|午後|早一點|早點|早些|更早|上午|早上|中午)/.test(text);
}

function applySlotRefinementText(text, session, localBooking = {}) {
  if (!session.booking) return;
  if (localBooking.date) session.booking.date = localBooking.date;
  if (localBooking.time) session.booking.time = localBooking.time;
  if (localBooking.artist) session.booking.artist = localBooking.artist;
  const period = parsePeriodText(text) || (
    /(晚一點|晚點|晚些|更晚|晚上的?)/.test(text)
      ? 'evening'
      : /(早一點|早點|早些|更早|上午|早上)/.test(text)
        ? 'morning'
        : ''
  );
  if (period) session.booking.period = period;
  if (period && !localBooking.time) session.booking.time = '';
}

function findAvailableStartSlots(slots, booking, service, settings, ignoreBookingId = '') {
  const starts = slots.filter((slot) => {
    if (booking.artist && !isAnyArtist(booking.artist) && slot.artist !== booking.artist) return false;
    if (booking.date && slot.date !== booking.date) return false;
    if (!isFutureEnough(slot, settings)) return false;
    if (booking.period && !isInPeriod(slot.time, booking.period)) return false;
    return isSlotOpenForBooking(slot, ignoreBookingId);
  }).sort(compareSlots);
  return starts.filter((slot) => findConsecutiveSlots(slots, { ...booking, date: slot.date, time: slot.time, artist: slot.artist }, service, settings, ignoreBookingId).length);
}

function findAlternativeArtistSlots(config, booking, service) {
  if (!booking.date || !service) return [];
  return (config.artists || [])
    .filter((artist) => artist.name !== booking.artist)
    .map((artist) => ({
      artist: artist.name,
      slots: findAvailableStartSlots(config.slots, { ...booking, artist: artist.name }, service, config.settings),
    }))
    .filter((item) => item.slots.length);
}

function findFirstAvailableSlotAtRequestedTime(slots, booking, service, settings, ignoreBookingId = '') {
  if (!booking.time) return null;
  return slots
    .filter((slot) => {
      if (booking.artist && !isAnyArtist(booking.artist) && slot.artist !== booking.artist) return false;
      if (slot.time !== booking.time) return false;
      if (!isFutureEnough(slot, settings)) return false;
      return isSlotOpenForBooking(slot, ignoreBookingId);
    })
    .sort(compareSlots)
    .find((slot) => findConsecutiveSlots(slots, { ...booking, date: slot.date, time: slot.time, artist: slot.artist }, service, settings, ignoreBookingId).length) || null;
}

function findConsecutiveSlots(slots, booking, service, settings, ignoreBookingId = '') {
  const slotMinutes = Number(settings.slot_minutes || 30);
  const needed = Math.ceil(Number(service.duration || 0) / slotMinutes);
  const start = timeToMinutes(booking.time);
  const found = [];

  if (!isFutureEnough({ date: booking.date, time: booking.time }, settings)) return [];

  for (let i = 0; i < needed; i += 1) {
    const time = minutesToTime(start + i * slotMinutes);
    const slot = slots.find((item) => (
      item.artist === booking.artist
      && item.date === booking.date
      && item.time === time
      && isSlotOpenForBooking(item, ignoreBookingId)
    ));
    if (!slot) return [];
    found.push(slot);
  }
  return found;
}

function isSlotOpenForBooking(slot, ignoreBookingId = '') {
  if (['可預約', '可約', 'available', 'open'].includes(String(slot.status || '').trim()) && !slot.lockedBookingId) return true;
  return Boolean(ignoreBookingId && slot.lockedBookingId && String(slot.lockedBookingId) === String(ignoreBookingId));
}

function answerFaq(text, config) {
  const faqMap = [
    { keys: ['停車', '車位', '開車'], value: config.settings.faq_parking },
    { keys: ['付款', '刷卡', '轉帳', '現金'], value: config.settings.faq_payment },
    { keys: ['取消', '改期'], value: config.settings.faq_cancel },
    { keys: ['遲到', '晚到'], value: config.settings.faq_late },
    { keys: ['營業', '幾點', '時間'], value: config.settings.business_hours },
    { keys: ['地址', '在哪'], value: config.settings.shop_address },
  ];
  return faqMap.find((item) => item.value && item.keys.some((key) => text.includes(key)))?.value || '';
}

function answerBusinessDateQuery(text, config) {
  if (!/(營業|有開|開店|店休|休息|公休)/.test(text)) return '';
  const date = parseDateText(text);
  if (!date) return '';

  const daySlots = (config.slots || [])
    .filter((slot) => slot.date === date)
    .sort(compareSlots);
  if (!daySlots.length) {
    return `${date} 目前查不到營業時段，可能是店休、班表尚未建立，或超過目前可查範圍。`;
  }

  const times = [...new Set(daySlots.map((slot) => slot.time).filter(Boolean))].sort();
  const openTime = times[0] || config.settings.day_start_time || '';
  const lastStart = times[times.length - 1] || config.settings.day_end_time || '';
  const closeTime = lastStart ? minutesToTime(timeToMinutes(lastStart) + Number(config.settings.slot_minutes || 30)) : config.settings.day_end_time || '';
  return [
    `${formatDateWithWeekday(date)} 有營業。`,
    openTime && closeTime ? `目前表上的營業時段約 ${openTime}-${closeTime}。` : '',
    '如果您想預約，我可以幫您查可約時段。',
  ].filter(Boolean).join('\n');
}

function answerPriceQuery(text, config, session, local) {
  if (!/(價格|價錢|費用|多少錢|收費|報價)/.test(text)) return '';
  const serviceName = local.booking.service || session.booking?.service || '';
  if (serviceName) {
    const service = findService(config.services, serviceName);
    if (service) return `${service.name}：${formatServicePrice(service)}。`;
  }
  return [
    '目前服務價格如下：',
    ...(config.services || []).map((service) => `${service.name}：${formatServicePrice(service)}`),
  ].join('\n');
}

function formatServicePrice(service = {}) {
  if (isFreeService(service)) return '免費';
  const price = String(service.price ?? '').trim();
  if (!price) return '請店家確認';
  return /^\d+$/.test(price) ? `NT$${price}` : price;
}

async function handleComplexOrMultiPersonRequest({ userId, text, session, config, local }) {
  const mentionedArtists = findMentionedArtists(text, config.artists);
  const multiPeople = isMultiPersonBookingText(text);
  const multipleArtistsTyped = mentionedArtists.length >= 2;
  const asksMultiAvailability = /(哪個時段|哪些時段|什麼時段|有沒有|可以預約|可約|查|看).*(2位|兩位|二位|多人|多位).*(美甲師|設計師)/.test(text);
  const specificMultiBooking = multiPeople
    && Boolean(local.booking.date || local.booking.time || local.booking.period)
    && /(預約|可約|可以約|可以預約|想約|我要約|安排)/.test(text);

  if (asksMultiAvailability && local.booking.date && !specificMultiBooking) {
    const grouped = groupAvailableArtistsByTime(config.slots, local.booking.date, config.settings)
      .filter((item) => item.artists.length >= 2)
      .slice(0, 8);
    if (!grouped.length) {
      return `${local.booking.date} 目前查不到同時有 2 位以上美甲師可預約的時段。若是多人同行，我可以幫您通知店家確認。`;
    }
    return [
      `${local.booking.date} 同時有 2 位以上美甲師可預約的時段：`,
      ...grouped.map((item, index) => `${index + 1}. ${item.time}｜${item.artists.join('、')}`),
      '多人同行需要店家確認，請告訴我人數、服務項目與希望時間。',
    ].join('\n');
  }

  if (!multiPeople && !multipleArtistsTyped) return '';

  sessions.delete(userId);
  const requested = [
    local.booking.date ? `日期：${local.booking.date}` : '',
    local.booking.time ? `時間：${local.booking.time}` : local.booking.period ? `時段：${periodLabel(local.booking.period)}` : '',
    local.booking.service ? `服務：${local.booking.service}` : '',
    mentionedArtists.length ? `美甲師：${mentionedArtists.join('、')}` : '',
  ].filter(Boolean).join('\n');

  notifyShop([
    '需要店家確認的預約需求',
    `客人來源：${userId}`,
    `訊息：${text}`,
    requested,
  ].filter(Boolean).join('\n'), config, 'pending').catch((error) => {
    console.error('notifyShop failed:', error.response?.data || error.message);
  });

  return [
    '多人同行或同時指定多位美甲師，需要店家確認後才能安排。',
    '我已先幫您通知店家，店家確認後會回覆您。',
  ].join('\n');
}

function isMultiPersonBookingText(text) {
  return /(2位|兩位|二位|多人|多位|兩個人|二個人|雙人|我和朋友|跟朋友|朋友一起|一起做|同時做|同時預約)/.test(text);
}

function findMentionedArtists(text, artists = []) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, '');
  return artists
    .map((artist) => artist.name)
    .filter(Boolean)
    .filter((name) => normalized.includes(String(name).toLowerCase().replace(/\s+/g, '')));
}

function answerArtistStatusQuery(text, config, local) {
  if (/(幾位|多少位).*(美甲師|設計師)/.test(text)) {
    const names = (config.artists || []).map((artist) => artist.name).filter(Boolean);
    return names.length
      ? `目前可預約美甲師共有 ${names.length} 位：${names.join('、')}。`
      : '目前還沒有設定可預約美甲師。';
  }

  if (/(哪個時段|哪些時段|什麼時段).*(2位|兩位|二位|多人|多位).*(美甲師|設計師)/.test(text)) {
    const date = local.booking.date;
    if (!date) return '請問您想查今天、明天，還是指定日期？';
    const grouped = groupAvailableArtistsByTime(config.slots, date, config.settings)
      .filter((item) => item.artists.length >= 2)
      .slice(0, 8);
    if (!grouped.length) return `${date} 目前查不到同時有 2 位以上美甲師可預約的時段。`;
    return [
      `${date} 同時有 2 位以上美甲師可預約的時段：`,
      ...grouped.map((item, index) => `${index + 1}. ${item.time}｜${item.artists.join('、')}`),
      '如果想預約，請告訴我服務項目與希望時間。',
    ].join('\n');
  }

  const asksCurrentArtistStatus = /(現在|目前).*(美甲師|設計師|在忙|有空|有在|可接|可以約)/.test(text)
    || ((config.artists || []).some((artist) => text.includes(artist.name)) && /(在忙|有在|現在|目前)/.test(text));
  if (!asksCurrentArtistStatus) return '';

  const date = local.booking.date || nowInZone().format('YYYY-MM-DD');
  const time = local.booking.time || nowInZone().format('HH:mm');
  const mentionedArtists = (config.artists || []).filter((artist) => text.includes(artist.name));
  const artists = mentionedArtists.length ? mentionedArtists : (config.artists || []);
  if (!artists.length) return '目前還沒有設定可預約美甲師。';

  const lines = artists.map((artist) => `${artist.name}：${describeArtistAtTime(config.slots, artist.name, date, time, config.settings)}`);
  return [
    `${formatFriendlyDateTime(date, time)} 的美甲師狀態：`,
    ...lines,
    '如果想預約，請告訴我服務項目。',
    '',
    buildServiceOptions(config),
  ].join('\n');
}

function groupAvailableArtistsByTime(slots, date, settings) {
  const groups = new Map();
  (slots || []).forEach((slot) => {
    if (slot.date !== date) return;
    if (slot.status !== '可預約' || slot.lockedBookingId) return;
    if (!isFutureEnough(slot, settings)) return;
    if (!groups.has(slot.time)) groups.set(slot.time, []);
    groups.get(slot.time).push(slot.artist);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, artists]) => ({ time, artists: [...new Set(artists)].sort() }));
}

function describeArtistAtTime(slots, artistName, date, time, settings) {
  const slotMinutes = Number(settings.slot_minutes || 30);
  const target = timeToMinutes(time);
  const slot = (slots || []).find((item) => {
    if (item.artist !== artistName || item.date !== date) return false;
    const start = timeToMinutes(item.time);
    return target >= start && target < start + slotMinutes;
  });
  if (!slot) return '目前沒有開放可預約時段';
  if (slot.status === '可預約' && !slot.lockedBookingId) return '目前可預約';
  return '目前已有預約';
}

function answerAvailabilityQuery(text, config, session, local) {
  const asksGeneralSlots = /(可預約時段|可約時段|可約時間|查空檔|看空檔|查時間|查詢時段|查詢預約)/.test(text);
  if (asksGeneralSlots && !local.booking.date && !session.booking?.date) {
    if (session.booking?.service) {
      session.step = 'ask_time';
      return '可以，請問您想查今天、明天，還是指定日期？';
    }
    session.step = 'ask_service';
    return [
      '可以，我先幫您查可預約時段。',
      '請先選服務項目，我才能依服務時間確認空檔。',
      '',
      buildServiceOptions(config),
    ].join('\n');
  }

  const asksDateSlots = /(查|看|有沒有|有|可約|可以約|空檔|時間)/.test(text)
    && Boolean(local.booking.date)
    && !local.booking.service
    && !local.booking.time;
  if (asksDateSlots && !session.booking?.service) {
    mergeBookingData(session.booking, local.booking);
    session.step = 'ask_service';
    return [
      `可以，我先幫您看 ${local.booking.date}。`,
      '請先選服務項目，我才能依服務時間確認可約空檔。',
      '',
      buildServiceOptions(config),
    ].join('\n');
  }

  const mentionsKnownArtist = (config.artists || []).some((artist) => text.includes(artist.name));
  const asksAvailability = /(美甲師|設計師).*(可預約|可以約|有空|在嗎)|今天.*(誰|哪位|哪個).*可/.test(text)
    || (mentionsKnownArtist && /(可預約|可以約|有空|在嗎)/.test(text))
    || (/今天.*(在嗎|有空|可預約|可以約)/.test(text));
  if (!asksAvailability) return '';
  const date = local.booking.date || nowInZone().format('YYYY-MM-DD');
  const artistName = local.booking.artist || findMentionedArtistName(text, config.artists);

  if (artistName && !config.artists.some((artist) => artist.name === artistName)) {
    return [
      `目前沒有找到「${artistName}」這位美甲師。`,
      `目前可接單的美甲師有：${config.artists.map((artist) => artist.name).join('、')}。`,
      '請問想預約哪一項服務？我會依服務時間幫您確認完整時段。',
      '',
      buildServiceOptions(config),
    ].join('\n');
  }

  const artists = artistName ? config.artists.filter((artist) => artist.name === artistName) : config.artists;
  const lines = artists.map((artist) => {
    const slots = config.slots
      .filter((slot) => slot.artist === artist.name && slot.date === date && slot.status === '可預約' && !slot.lockedBookingId && isFutureEnough(slot, config.settings))
      .sort(compareSlots)
      .slice(0, 3)
      .map((slot) => slot.time);
    return slots.length ? `${artist.name}：最近可約 ${slots.join('、')}` : `${artist.name}：目前沒有可預約空檔`;
  });

  return [
    `${date} 可預約狀況：`,
    ...lines,
    '請問想做哪一項服務？我會依服務時間幫您確認完整時段。',
    '',
    buildServiceOptions(config),
  ].join('\n');
}

async function handleRescheduleFlow({ userId, text, ai, local, session, config }) {
  const bookings = await loadUserActiveBookings(userId);
  if (!bookings.length) {
    session.step = 'start';
    session.booking = { service: '', artist: '', date: '', time: '', customerName: '', phone: '', note: '' };
    return [
      '目前系統沒有查到您的預約資料。',
      '如果您想重新預約，我現在可以協助您。',
      '',
      buildServiceOptions(config),
    ].join('\n');
  }

  if (session.step === 'reschedule_confirm' && isAbortRescheduleText(text)) {
    sessions.delete(userId);
    session.step = 'start';
    return buildRestartMessage();
  }

  if (session.step === 'reschedule_confirm' && isConfirmRescheduleText(text)) {
    const draft = session.rescheduleDraft;
    if (!draft) {
      session.step = 'reschedule_select';
      return '修改資訊已過期，請重新選擇要更改的預約。';
    }
    try {
      const result = await rescheduleBooking(userId, draft);
      notifyShop(`預約已修改 ${result.bookingId}\n客人：${result.customerName}\n服務：${result.service}\n美甲師：${result.artist}\n時間：${result.date} ${result.time}`, config, 'reschedule').catch((error) => {
        console.error('notifyShop failed:', error.response?.data || error.message);
      });
      sessions.delete(userId);
      return [
        '已修改預約！',
        `預約編號：${shortBookingId(result.bookingId)}`,
        `服務：${result.service}`,
        `美甲師：${result.artist}`,
        `時間：${result.date} ${result.time}`,
      ].join('\n');
    } catch (error) {
      session.step = 'reschedule_change';
      return [
        `修改失敗：${error.message}`,
        '請換其他日期或時間，我會再幫您確認。',
      ].join('\n');
    }
  }

  const bookingId = normalizeShortBookingInput(text);
  const target = bookingId ? bookings.find((booking) => bookingIdMatches(booking.id, bookingId)) : null;
  if (!target && !session.rescheduleBooking) {
    session.step = 'reschedule_select';
    session.rescheduleOptions = bookings;
    return [
      '您是想更改已預約的時間嗎？我先幫您查詢目前的預約。',
      '',
      '您目前有以下預約：',
      ...bookings.map((booking) => `預約編號 ${shortBookingId(booking.id)}號：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`),
      '請回覆要更改的預約編號，例如「006」。',
    ].join('\n');
  }

  if (target) session.rescheduleBooking = target;
  const booking = session.rescheduleBooking;
  if (session.step === 'reschedule_change' && /^\d+$/.test(text.trim()) && Array.isArray(session.rescheduleSlotOptions)) {
    const slot = session.rescheduleSlotOptions[Number(text.trim()) - 1];
    if (slot) {
      session.rescheduleChange.date = slot.date;
      session.rescheduleChange.time = slot.time;
      session.rescheduleChange.artist = slot.artist;
    }
  }
  mergeBookingData(session.rescheduleChange, ai.booking);
  mergeBookingData(session.rescheduleChange, local.booking);

  const change = session.rescheduleChange || {};
  const next = {
    bookingId: booking.id,
    service: change.service || booking.service,
    artist: change.artist || booking.artist,
    date: change.date || booking.date,
    time: change.time || booking.start,
  };

  if (!change.service && !change.artist && !change.date && !change.time && !change.period) {
    session.step = 'reschedule_change';
    return [
      `我找到預約編號 ${shortBookingId(booking.id)}號：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`,
      '請告訴我想改成什麼時間或內容，例如「改到 5/20 下午 4 點」。',
    ].join('\n');
  }

  const service = findService(config.services, next.service);
  if (!service) {
    session.rescheduleChange.service = '';
    return `目前沒有找到「${next.service}」這個服務，請重新告訴我想改成哪一項服務。`;
  }

  const artist = config.artists.find((item) => item.name === next.artist);
  if (!artist) {
    session.rescheduleChange.artist = '';
    return `目前沒有找到「${next.artist}」這位美甲師，請重新告訴我想改成哪位美甲師。`;
  }

  if (!next.date || !next.time) {
    session.step = 'reschedule_change';
    return [
      `我找到預約編號 ${shortBookingId(booking.id)}號：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`,
      '請告訴我想改到哪一天、幾點，例如「5/20 1600」或「星期三下午」。',
    ].join('\n');
  }

  const slots = findConsecutiveSlots(config.slots, next, service, config.settings, booking.id);
  if (!isBookingFarEnough(next, config.settings) || !slots.length) {
    session.step = 'reschedule_change';
    const suggestions = findAvailableStartSlots(config.slots, { artist: next.artist, date: next.date, period: change.period || '' }, service, config.settings, booking.id).slice(0, 6);
    session.rescheduleSlotOptions = suggestions;
    const reason = buildUnavailableReason(config, next, service);
    return [
      reason || `${next.date} ${next.time} 目前沒有足夠完成「${service.name}」的連續空檔。`,
      suggestions.length ? '以下是附近可約時間：' : '請換其他日期或時段。',
      ...suggestions.map((slot, index) => `${index + 1}. ${slot.date} ${slot.time}｜${slot.artist}`),
      suggestions.length ? '請直接回覆編號，或輸入其他日期時間。' : '',
    ].filter(Boolean).join('\n');
  }

  session.step = 'reschedule_confirm';
  session.rescheduleDraft = next;
  return [
    `是否將預約 ${shortBookingId(booking.id)}號修改為以下內容？`,
    '',
    `原本：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`,
    `改成：${next.date} ${next.time}｜${next.artist}｜${service.name}`,
    '',
    '1. 確認修改',
    '2. 取消修改',
    '0. 回首頁',
  ].join('\n');
}

function extractLocalBookingData(text, config) {
  const booking = {};
  const service = (config.services || []).find((item) => text.includes(item.name));
  const artist = (config.artists || []).find((item) => text.includes(item.name));
  const date = parseDateText(text);
  const time = parseTimeText(text);
  const period = parsePeriodText(text);
  if (service) booking.service = service.name;
  if (artist) booking.artist = artist.name;
  if (date) booking.date = date;
  if (time) booking.time = time;
  if (period) booking.period = period;
  return { booking };
}

function forceSearchCorrectionFromLocalText(ai, local) {
  if (!local?.booking) return;
  const localChangedSearch = Boolean(local.booking.date || local.booking.period);
  if (!localChangedSearch || local.booking.time) return;
  if (!ai.booking) ai.booking = {};
  ai.booking.time = '';
}

function clearChosenTimeForDateOrPeriodOnlyMessage(booking, localBooking) {
  if (!localBooking) return;
  if ((localBooking.date || localBooking.period) && !localBooking.time) {
    booking.time = '';
  }
}

function parseDateText(text) {
  const now = nowInZone();
  if (text.includes('今天')) return now.format('YYYY-MM-DD');
  if (text.includes('明天')) return now.add(1, 'day').format('YYYY-MM-DD');
  const weekday = parseWeekdayText(text);
  if (weekday) return weekday;
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(日|號)?/);
  if (monthDay) return resolveMonthDay(Number(monthDay[1]), Number(monthDay[2]));
  const slash = text.match(/(\d{1,2})[/-](\d{1,2})/);
  if (slash) return resolveMonthDay(Number(slash[1]), Number(slash[2]));
  const dayOnly = text.match(/(\d{1,2})\s*(日|號)/);
  if (dayOnly) {
    const base = nowInZone();
    let date = parseDateOnlyInZone(base.year(), base.month() + 1, Number(dayOnly[1]));
    if (date.isBefore(base, 'day')) date = date.add(1, 'month');
    return date.format('YYYY-MM-DD');
  }
  return '';
}

function parseWeekdayText(text) {
  const match = text.match(/(下週|下禮拜|這週|這禮拜|本週|本禮拜)?\s*(週|星期|禮拜)([一二三四五六日天])/);
  if (!match) return '';
  const map = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const target = map[match[3]];
  const base = nowInZone().startOf('day');
  const current = base.day();
  let diff = target - current;
  const prefix = match[1] || '';
  if (prefix.includes('下')) diff += 7;
  if (!prefix && diff < 0) diff += 7;
  return base.add(diff, 'day').format('YYYY-MM-DD');
}

function resolveMonthDay(month, day) {
  const base = nowInZone();
  let date = parseDateOnlyInZone(base.year(), month, day);
  if (date.isBefore(base, 'day')) date = date.add(1, 'year');
  return date.format('YYYY-MM-DD');
}

function parseTimeText(text) {
  const half = text.match(/([零〇一二兩三四五六七八九十\d]{1,3})\s*點\s*半/);
  if (half) return normalizeHourMinute(parseChineseHour(half[1]), 30, text);
  const colon = text.match(/(\d{1,2})[:：](\d{2})/);
  if (colon) return normalizeHourMinute(Number(colon[1]), Number(colon[2]), text);
  const compact = text.match(/(?:^|[^\d/-])(\d{3,4})(?:$|[^\d/-])/);
  if (compact) {
    const raw = compact[1].padStart(4, '0');
    const hour = Number(raw.slice(0, 2));
    const minute = Number(raw.slice(2, 4));
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return normalizeHourMinute(hour, minute, text);
  }
  const hourMinute = text.match(/([零〇一二兩三四五六七八九十\d]{1,3})\s*點\s*([零〇一二兩三四五六七八九十\d]{1,2})?\s*分?/);
  if (hourMinute) {
    return normalizeHourMinute(parseChineseHour(hourMinute[1]), hourMinute[2] ? parseChineseHour(hourMinute[2]) : 0, text);
  }
  return '';
}

function parseChineseHour(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const normalized = text.replace(/兩/g, '二').replace(/〇/g, '零');
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (normalized === '十') return 10;
  if (normalized.startsWith('十')) return 10 + (map[normalized[1]] || 0);
  if (normalized.includes('十')) {
    const [tens, ones] = normalized.split('十');
    return (map[tens] || 1) * 10 + (map[ones] || 0);
  }
  return map[normalized] || 0;
}

function normalizeHourMinute(hour, minute, text) {
  let h = hour;
  if ((text.includes('下午') || text.includes('晚上')) && h < 12) h += 12;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function adjustAmbiguousTimeWithContext(booking, text, currentBooking = {}, settings = {}) {
  if (!booking?.time) return;
  if (/(上午|早上|下午|晚上)/.test(text)) return;
  const [hourText, minuteText] = booking.time.split(':');
  let hour = Number(hourText);
  if (!Number.isFinite(hour) || hour >= 12) return;

  const contextPeriod = booking.period || currentBooking?.period || '';
  const dayStartHour = Math.floor(timeToMinutes(settings.day_start_time || '10:00') / 60);
  if ((['afternoon', 'evening'].includes(contextPeriod) && hour <= 6) || hour < dayStartHour) {
    hour += 12;
    booking.time = `${String(hour).padStart(2, '0')}:${minuteText || '00'}`;
  }
}

function parsePeriodText(text) {
  if (text.includes('上午') || text.includes('早上')) return 'morning';
  if (text.includes('下午')) return 'afternoon';
  if (text.includes('晚上')) return 'evening';
  return '';
}

function findMentionedArtistName(text, artists) {
  const exact = (artists || []).find((artist) => text.includes(artist.name));
  if (exact) return exact.name;
  const match = text.match(/今天(.+?)(在嗎|有空|可以約)|(.+?)(在嗎|有空)/);
  return (match?.[1] || match?.[3] || '').replace(/[，,？? ]/g, '');
}

function isFutureEnough(slot, settings) {
  const minHours = Number(settings.min_hours_before_booking || 0);
  if (!slot.date || !slot.time) return false;
  const slotAt = parseDateTimeInZone(slot.date, slot.time);
  return slotAt.isAfter(nowInZone().add(minHours, 'hour'));
}

function isInPeriod(time, period) {
  const minutes = timeToMinutes(time);
  if (period === 'morning') return minutes < 12 * 60;
  if (period === 'afternoon') return minutes >= 12 * 60 && minutes < 18 * 60;
  if (period === 'evening') return minutes >= 18 * 60;
  return true;
}

function periodLabel(period) {
  if (period === 'morning') return '上午';
  if (period === 'afternoon') return '下午';
  if (period === 'evening') return '晚上';
  return '';
}

function formatDateWithWeekday(date) {
  const target = dayjs.tz(`${date} 00:00`, timezone);
  if (!target.isValid()) return date;
  const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  return `${target.format('M/D')}（${weekdays[target.day()]}）`;
}

function formatFriendlyDateTime(date, time) {
  const target = parseDateTimeInZone(date, time);
  if (!target.isValid()) return `${date} ${time}`;
  const now = nowInZone();
  const dateLabel = target.isSame(now, 'day')
    ? '今天'
    : target.isSame(now.add(1, 'day'), 'day')
      ? '明天'
      : target.format('M/D');
  const hour = target.hour();
  const period = hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上';
  const displayHour = hour > 12 ? hour - 12 : hour;
  const minute = target.minute() ? `:${String(target.minute()).padStart(2, '0')}` : '點';
  return `${dateLabel}${period}${displayHour}${minute}`;
}

function shortBookingId(id) {
  const text = String(id || '');
  return text.includes('-') ? text.split('-').pop() : String(text).padStart(3, '0');
}

function normalizeShortBookingInput(value) {
  const text = String(value || '').replace('預約編號', '').replace('編號', '').replace('號', '').trim();
  const match = text.match(/\d+/);
  return match ? match[0].padStart(3, '0') : '';
}

function bookingIdMatches(fullId, input) {
  const short = shortBookingId(fullId);
  const normalized = normalizeShortBookingInput(input);
  return String(fullId) === String(input).trim() || (normalized && short === normalized);
}

function nowInZone() {
  return dayjs().tz(timezone);
}

function parseDateTimeInZone(date, time) {
  return dayjs.tz(`${date} ${normalizeTime(time)}`, timezone);
}

function parseDateOnlyInZone(year, month, day) {
  return dayjs.tz(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00`, timezone);
}

function compareSlots(a, b) {
  return `${a.date} ${a.time} ${a.artist || ''}`.localeCompare(`${b.date} ${b.time} ${b.artist || ''}`);
}

function findService(services, input) {
  if (!input) return null;
  return services.find((service) => service.name === input || service.name.includes(input) || input.includes(service.name));
}

function artistsForService(artists, service) {
  return artists;
}

function isSettingEnabled(value) {
  return ['開啟', '是', 'true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isSettingDisabled(value) {
  return ['關閉', '否', 'false', '0', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function mergeBookingData(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    if (value) target[key] = value;
  });
}

function resetChosenTimeIfSearchChanged(current, incoming) {
  if (!incoming) return;
  const changed = ['service', 'artist', 'date', 'period'].some((key) => incoming[key] && incoming[key] !== current[key]);
  if (changed && !incoming.time) current.time = '';
}

function isActiveBookingSession(session) {
  return Boolean(session?.booking?.service || session?.booking?.artist || session?.booking?.date || session?.booking?.time || session?.step?.startsWith('ask_') || session?.step === 'confirm_booking');
}

function isFastRestartText(text) {
  const normalized = String(text || '').trim();
  return normalized === '0' || isResetText(normalized);
}

function isRestartOptionNumber(text, session) {
  if (String(text || '').trim() !== '0') return false;
  return isActiveBookingSession(session) || session.step?.startsWith('cancel') || session.step?.startsWith('reschedule');
}

function answerAiConfirmation(ai, session, local) {
  if (!ai) return '';
  const localHasUsefulBookingData = Boolean(
    local?.booking?.service
    || local?.booking?.artist
    || local?.booking?.date
    || local?.booking?.time
    || local?.booking?.period
  );
  if (localHasUsefulBookingData || session.step === 'confirm_booking') return '';
  if (ai.needsConfirmation && ai.confirmationQuestion) return ai.confirmationQuestion;
  if (session.step?.startsWith('ask_')) return '';
  const confidence = Number(ai.confidence || 0);
  if (confidence > 0 && confidence < 0.55 && !['booking', 'cancel', 'reschedule'].includes(ai.intent)) {
    return '我想確認一下，您是想預約，還是調整已有預約呢？';
  }
  return '';
}

function shouldSkipAi(text, session, local) {
  if (/^\d+$/.test(text.trim())) return true;
  if (session.step === 'ask_contact') return true;
  if (isConfirmBookingText(text) || isConfirmCancelText(text) || isConfirmRescheduleText(text)) return true;
  if (isCancelBookingRequestText(text) || isAbandonBookingText(text) || isResetText(text)) return true;
  if (isSlotRefinementText(text, session)) return true;
  return false;
}

function isStepOptionNumber(text, session) {
  if (!/^\d+$/.test(String(text || '').trim())) return false;
  if (String(text || '').trim() === '0') return false;
  return ['ask_service', 'ask_service_detail', 'ask_artist', 'ask_time', 'reschedule_change'].includes(session.step);
}

async function handleOptionNumberSelection({ userId, profile, text, session, config }) {
  const beforeStep = session.step;
  const noSlotActionAnswer = handleNoSlotAction(text, session, config);
  if (noSlotActionAnswer) return noSlotActionAnswer;
  applyQuickReplyNumber(text, session, config);

  if (beforeStep === 'ask_service' && session.step === 'ask_service_detail' && !session.booking.service) {
    return buildServiceDetailOptions(session.pendingServiceGroup);
  }

  if (beforeStep === 'cancel_select' && session.cancelBooking) {
    const target = session.cancelBooking;
    return [
      '請確認是否取消這筆預約：',
      `預約編號：${shortBookingId(target.id)}號`,
      `服務：${target.service}`,
      `美甲師：${target.artist}`,
      `時間：${target.date} ${target.start}`,
      '1. 確認刪除',
      '2. 取消刪除',
      '0. 回首頁',
    ].join('\n');
  }

  if (beforeStep === 'reschedule_select' && session.rescheduleBooking) {
    const booking = session.rescheduleBooking;
    return [
      `我找到預約編號 ${shortBookingId(booking.id)}號：${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}`,
      '請告訴我想改成什麼時間或內容，例如「改到 5/20 下午 4 點」。',
    ].join('\n');
  }

  if (beforeStep === 'reschedule_change') {
    return runConversation({ userId, profile, text, ai: emptyAi(), session, config, local: { booking: {} } });
  }

  return runConversation({ userId, profile, text: '', ai: emptyAi(), session, config, local: { booking: {} } });
}

function handleNoSlotAction(text, session, config) {
  const choice = String(text || '').trim();
  if (!['1', '2', '3'].includes(choice)) return '';
  if (session.step !== 'ask_time') return '';
  const service = findService(config.services, session.booking?.service);
  if (!service || !session.booking?.date || !session.booking?.period || !session.booking?.artist) return '';
  const slots = findAvailableStartSlots(config.slots, session.booking, service, config.settings);
  if (slots.length) return '';

  session.booking.time = '';
  if (choice === '1') {
    session.booking.date = '';
    session.booking.period = '';
    session.booking.artist = '';
    session.step = 'ask_time';
    return buildAvailableSlots(config, session.booking.artist, service, session.booking);
  }
  if (choice === '2') {
    session.booking.period = '';
    session.step = 'ask_time';
    return buildAvailableSlots(config, session.booking.artist, service, session.booking);
  }
  session.booking.artist = '';
  session.step = 'ask_artist';
  return buildArtistOptions(config, service, session.booking);
}

function applyQuickReplyNumber(text, session, config) {
  if (!/^\d+$/.test(text.trim())) return;
  if (text.trim() === '0') return;
  const index = Number(text.trim()) - 1;
  if (session.step === 'ask_service') {
    const service = (config.services || []).slice(0, 12)[index];
    if (service) session.booking.service = service.name;
    session.pendingServiceGroup = null;
    return;
  }
  if (session.step === 'ask_service_detail' && session.pendingServiceGroup?.services?.[index]) {
    session.booking.service = session.pendingServiceGroup.services[index].name;
    session.pendingServiceGroup = null;
    return;
  }
  if (session.step === 'ask_artist') {
    const service = findService(config.services, session.booking.service);
    const artists = service ? getAvailableArtistsForBooking(config, service, session.booking) : (config.artists || []).slice(0, 3);
    if (index === artists.length) {
      session.booking.artist = ANY_ARTIST;
    } else if (artists[index]) {
      session.booking.artist = artists[index].name;
    }
  }
  if (session.step === 'ask_time') {
    const service = findService(config.services, session.booking.service);
    if (!service) return;
    if (!session.booking.date) {
      const date = getAvailableDateOptions(config, session.booking.artist, service, session.booking).slice(0, 5)[index];
      if (date) {
        session.booking.date = date;
        session.booking.period = '';
        session.booking.time = '';
      }
      return;
    }
    if (!session.booking.period) {
      const period = getAvailablePeriodOptions(config, session.booking.artist, service, session.booking)[index];
      if (period) {
        session.booking.period = period;
        session.booking.time = '';
      }
      return;
    }
    const slots = findAvailableStartSlots(config.slots, session.booking, service, config.settings);
    if (slots[index]) {
      session.booking.artist = slots[index].artist;
      session.booking.date = slots[index].date;
      session.booking.time = slots[index].time;
    }
  }
  if (session.step === 'cancel_select' && Array.isArray(session.cancelOptions)) {
    const target = session.cancelOptions[index];
    if (target) {
      session.cancelBooking = target;
      session.step = 'cancel_confirm';
    }
  }
  if (session.step === 'reschedule_select' && Array.isArray(session.rescheduleOptions)) {
    const target = session.rescheduleOptions[index];
    if (target) {
      session.rescheduleBooking = target;
      session.step = 'reschedule_change';
    }
  }
}

function inferOptionNumberFromAi(ai, session) {
  if (!session?.step?.startsWith('ask_') && !['cancel_select', 'reschedule_select'].includes(session?.step)) return 0;
  const optionNumber = Number(ai?.selectedOptionNumber || 0);
  if (optionNumber > 0 && optionNumber <= (session.lastOptions || []).length) return optionNumber;
  if (ai?.selectedOptionLabel) return findOptionNumberByLabel(ai.selectedOptionLabel, session);
  return 0;
}

function inferOptionNumberFromText(text, session) {
  if (!session?.step?.startsWith('ask_') && !['cancel_select', 'reschedule_select'].includes(session?.step)) return 0;
  const value = String(text || '').trim();
  if (!value || /^\d+$/.test(value)) return 0;

  const labelMatch = findOptionNumberByLabel(value, session);
  if (labelMatch) return labelMatch;

  const ordinal = parseOrdinalOptionNumber(value);
  if (ordinal && ordinal <= (session.lastOptions || []).length) return ordinal;

  return 0;
}

function findOptionNumberByLabel(text, session) {
  const options = (session.lastOptions || []).filter((option) => Number(option.number) > 0);
  if (!options.length) return 0;
  const normalizedText = normalizeOptionText(text);
  const matches = options.filter((option) => {
    return optionLabelAliases(option.label).some((alias) => {
      const normalizedAlias = normalizeOptionText(alias);
      return normalizedAlias.length >= 2 && (normalizedText === normalizedAlias || normalizedText.includes(normalizedAlias));
    });
  });
  return matches.length === 1 ? Number(matches[0].number) : 0;
}

function optionLabelAliases(label) {
  const text = String(label || '').trim();
  const firstPart = text.split(/[｜|/]/)[0].trim();
  const withoutFree = text.replace(/[（(]免費[）)]/g, '').trim();
  return [...new Set([text, firstPart, withoutFree].filter(Boolean))];
}

function normalizeOptionText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[「」『』"'“”‘’。.!！?？,，、]/g, '')
    .replace(/（免費）|\(免費\)/g, '');
}

function parseOrdinalOptionNumber(text) {
  const value = String(text || '').trim();
  const match = value.match(/第\s*([一二三四五六七八九十\d]+)\s*(個|項|位|種)?/);
  if (!match) return 0;
  return parseChineseOptionNumber(match[1]);
}

function parseChineseOptionNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const normalized = text.replace(/兩/g, '二').replace(/〇/g, '零');
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (normalized === '十') return 10;
  if (normalized.startsWith('十')) return 10 + (map[normalized[1]] || 0);
  if (normalized.includes('十')) {
    const [tens, ones] = normalized.split('十');
    return (map[tens] || 1) * 10 + (map[ones] || 0);
  }
  return map[normalized] || 0;
}

function getSession(userId, config) {
  const ttl = Number(config?.settings?.session_ttl_minutes || process.env.SESSION_TTL_MINUTES || 10) * 60 * 1000;
  const existing = sessions.get(userId);
  if (existing && Date.now() - existing.updatedAt < ttl) {
    existing.updatedAt = Date.now();
    ensureSessionShape(existing, config);
    return existing;
  }
  const session = {
    updatedAt: Date.now(),
    step: 'start',
    booking: { service: '', artist: '', date: '', time: '', customerName: '', phone: '', note: '' },
    pendingServiceGroup: null,
    rescheduleChange: {},
    history: [],
    lastBotQuestion: '',
    lastOptions: [],
    historyLimit: getSessionHistoryLimit(config),
  };
  sessions.set(userId, session);
  return session;
}

function ensureSessionShape(session, config) {
  session.booking = session.booking || { service: '', artist: '', date: '', time: '', customerName: '', phone: '', note: '' };
  session.history = Array.isArray(session.history) ? session.history : [];
  session.lastOptions = Array.isArray(session.lastOptions) ? session.lastOptions : [];
  session.lastBotQuestion = session.lastBotQuestion || '';
  if (config?.settings || !session.historyLimit) session.historyLimit = getSessionHistoryLimit(config);
}

function getSessionHistoryLimit(config) {
  const turns = Number(config?.settings?.session_history_turns || process.env.SESSION_HISTORY_TURNS || 4);
  return Math.max(4, Math.min(20, turns * 2));
}

function rememberUserMessage(session, text) {
  rememberSessionMessage(session, 'user', text);
}

function rememberBotMessage(session, text) {
  rememberSessionMessage(session, 'bot', text);
  updateLastBotContext(session, text);
}

function rememberSessionMessage(session, role, text) {
  if (!session) return;
  ensureSessionShape(session, {});
  session.history.push({
    role,
    text: String(text || '').slice(0, 1200),
    at: nowInZone().format('YYYY-MM-DD HH:mm'),
  });
  while (session.history.length > session.historyLimit) session.history.shift();
}

function updateLastBotContext(session, text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const options = [];
  lines.forEach((line) => {
    const match = line.match(/^(\d+)\.\s*(.+)$/);
    if (match) options.push({ number: Number(match[1]), label: match[2].trim() });
  });
  if (options.length) session.lastOptions = options;
  const question = lines.find((line) => !/^\d+\.\s*/.test(line) && !line.includes('請直接回覆'));
  if (question) session.lastBotQuestion = question;
}

function formatSessionHistory(session) {
  return (session.history || [])
    .map((item) => `${item.role === 'bot' ? 'bot' : 'user'}: ${item.text}`)
    .join(' / ');
}

function formatLastOptions(session) {
  return (session.lastOptions || [])
    .map((option) => `${option.number}. ${option.label}`)
    .join(' / ');
}

async function getLineProfile(userId) {
  if (!userId || !userId.startsWith('U')) return {};
  try {
    return await lineClient.getProfile(userId);
  } catch (_error) {
    return {};
  }
}

async function notifyShop(text, config, type = 'general') {
  const notifyId = process.env.SHOP_NOTIFY_LINE_ID;
  if (!notifyId) return;
  if (!shouldNotifyShop(config?.settings, type)) return;
  await lineClient.pushMessage({ to: notifyId, messages: [{ type: 'text', text }] });
}

function shouldNotifyShop(settings = {}, type = 'general') {
  if (isSettingDisabled(settings.notify_shop_enabled)) return false;
  const keyByType = {
    new: 'notify_new_booking',
    cancel: 'notify_cancel_booking',
    reschedule: 'notify_reschedule_booking',
    pending: 'notify_pending_request',
  };
  const key = keyByType[type];
  if (!key) return true;
  return !isSettingDisabled(settings[key]);
}

async function replyText(replyToken, text) {
  const message = { type: 'text', text: String(text).slice(0, 4500) };
  const quickReply = buildQuickReplyFromText(text);
  if (quickReply) message.quickReply = quickReply;
  await lineClient.replyMessage({
    replyToken,
    messages: [message],
  });
}

async function safeReplyText(event, userId, text) {
  try {
    await replyText(event.replyToken, text);
  } catch (error) {
    console.error('replyText failed, trying pushMessage:', error.response?.data || error.message);
    if (userId && userId.startsWith('U')) {
      const message = { type: 'text', text: String(text).slice(0, 4500) };
      const quickReply = buildQuickReplyFromText(text);
      if (quickReply) message.quickReply = quickReply;
      await lineClient.pushMessage({
        to: userId,
        messages: [message],
      });
    } else {
      throw error;
    }
  }
}

function buildQuickReplyFromText(text) {
  const items = String(text || '')
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\.\s*(.+)$/))
    .filter(Boolean)
    .slice(0, 13)
    .map((match) => ({
      type: 'action',
      action: {
        type: 'message',
        label: truncateQuickReplyLabel(addQuickReplyEmoji(toQuickReplyLabel(match[2]))),
        text: match[1],
      },
    }));
  return items.length ? { items } : null;
}

function toQuickReplyLabel(label) {
  const text = String(label || '').trim();
  return text.replace(/\s+\d+\s*分(?:\s+.*)?$/, '').trim();
}

function addQuickReplyEmoji(label) {
  const text = String(label || '').trim();
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(text)) return text;
  if (text.includes('確認')) return `✅ ${text}`;
  if (text.includes('預約')) return `📅 ${text}`;
  if (text.includes('修改') || text.includes('改時間')) return `✏️ ${text}`;
  if (text.includes('取消')) return `❌ ${text}`;
  if (text.includes('重新開始')) return `🏠 ${text}`;
  if (text === ANY_ARTIST) return `🙋 ${text}`;
  if (/卸甲|保養|凝膠|延甲|款式|簡易服務/.test(text)) return `💅 ${text}`;
  if (/上午|早上/.test(text)) return `🌤️ ${text}`;
  if (/下午/.test(text)) return `☀️ ${text}`;
  if (/晚上/.test(text)) return `🌙 ${text}`;
  if (/^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}|週|星期|明天|今天/.test(text)) return `📆 ${text}`;
  if (/\d{1,2}:\d{2}/.test(text)) return `🕒 ${text}`;
  return `💅 ${text}`;
}

function truncateQuickReplyLabel(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  return text.length > 20 ? `${text.slice(0, 19)}…` : text;
}

async function replyWithMemory(event, userId, session, text) {
  await safeReplyText(event, userId, text);
  rememberBotMessage(session, text);
}

async function appsScriptRequest(action, data = {}) {
  const timeout = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 60000);
  const response = await axios.post(
    requiredEnv('APPS_SCRIPT_WEB_APP_URL'),
    {
      action,
      token: String(requiredEnv('APPS_SCRIPT_API_TOKEN')).trim(),
      ...data,
    },
    { timeout }
  );
  if (!response.data?.ok) {
    throw new Error(response.data?.error || `Apps Script action failed: ${action}`);
  }
  return response.data.data;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function formatErrorForLog(error) {
  return {
    message: error?.message || String(error),
    status: error?.response?.status,
    data: error?.response?.data,
    stack: error?.stack,
  };
}

function isBookingFarEnough(booking, settings) {
  const hours = Number(settings.min_hours_before_booking || 0);
  if (!hours || !booking.date || !booking.time) return true;
  return parseDateTimeInZone(booking.date, booking.time).diff(nowInZone(), 'minute') >= hours * 60;
}

function normalizeTime(value) {
  if (!value) return '';
  const text = String(value).trim().replace('：', ':').replace('點', ':00');
  const match = text.match(/(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${(match[2] || '00').padStart(2, '0')}`;
}

function normalizeSheetDate(value) {
  if (!value) return '';
  if (typeof value === 'string') return dayjs(value).isValid() ? dayjs(value).tz(timezone).format('YYYY-MM-DD') : value;
  return dayjs(value).tz(timezone).format('YYYY-MM-DD');
}

function timeToMinutes(time) {
  const [hour, minute] = normalizeTime(time).split(':').map(Number);
  return hour * 60 + minute;
}

function minutesToTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isResetText(text) {
  const normalized = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/来/g, '來')
    .replace(/[。.!！?？,，]/g, '');
  if (['重來', '重新來', '重新開始', 'reset', 'restart'].includes(normalized)) return true;
  return /^(我要)?(重來|重新來|重新開始)$/.test(normalized);
}

function isStopText(text) {
  return isAbandonBookingText(text);
}

function isStartBookingText(text) {
  return ['我想預約', '我要預約', '預約', '你好，我想預約'].includes(text.trim());
}

function isGreetingText(text) {
  return ['嗨', '你好', '您好', '哈囉', 'hello', 'hi'].includes(text.trim().toLowerCase());
}

function isRescheduleText(text) {
  return /(改預約|更改預約|調整預約|修改預約|改時間|更改時間|換時間|調整時間|改期|改約|改到|改成|提前|提早|延後|晚一點|早一點|換日期|改日期)/.test(text);
}

function isCancelBookingRequestText(text) {
  if (isResetText(text)) return false;
  return /(取消預約|取消我的預約|我要取消|我想取消|取消編號)/.test(text);
}

function isAbandonBookingText(text) {
  if (isCancelBookingRequestText(text) || isResetText(text)) return false;
  const normalized = text.trim();
  if (normalized === '取消') return true;
  return /(算了|先不用|不用了|不約了|不想約|不想預約|不要約|不預約了|先不要|改天再約|下次再約|暫時不用)/.test(normalized);
}

function isConfirmBookingText(text) {
  return ['1', '888', '確認', '確認預約', '✅ 確認預約', '對', '沒錯', '可以'].includes(text.trim());
}

function isConfirmCancelText(text) {
  return ['1', '確認取消', '確定取消', '取消沒錯', '確認刪除', '確定刪除', '刪除沒錯'].includes(text.trim());
}

function isConfirmRescheduleText(text) {
  return ['1', '確認修改', '確定修改', '確認改期', '確認更改', '修改沒錯'].includes(text.trim());
}

function isAbortRescheduleText(text) {
  return ['2', '取消修改', '取消改期', '取消更改', '回首頁', '0'].includes(String(text || '').trim());
}

function isAbortCancelText(text) {
  return ['2', '取消刪除', '取消取消', '保留預約', '回首頁', '0'].includes(String(text || '').trim());
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

app.listen(port, () => {
  console.log(`約好 AI MVP v3 listening on ${port}`);
});
