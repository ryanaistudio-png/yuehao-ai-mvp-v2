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
  try {
    const config = await loadConfig();
    let session = getSession(userId, config);

    if (isResetText(text)) {
      sessions.delete(userId);
      cache.expiresAt = 0;
      await safeReplyText(event, userId, buildRestartMessage());
      return;
    }
    if (isAbandonBookingText(text) && isActiveBookingSession(session)) {
      sessions.delete(userId);
      await safeReplyText(event, userId, '好的，已取消本次預約流程。之後想預約時，請再回覆「預約」。');
      return;
    }
    if (isGreetingText(text)) {
      await safeReplyText(event, userId, '您好，我可以協助預約、調整已有預約或查詢可約時段。若要預約，請直接回覆「預約」。');
      return;
    }
    if (isStartBookingText(text)) {
      sessions.delete(userId);
      session = getSession(userId, config);
      session.step = 'ask_service';
      await safeReplyText(event, userId, buildServiceOptions(config));
      return;
    }
    if (isRescheduleText(text)) {
      const profile = await getLineProfile(userId);
      const answer = await handleRescheduleFlow({ userId, text, ai: emptyAi(), local: extractLocalBookingData(text, config), session, config });
      await safeReplyText(event, userId, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (isCancelBookingRequestText(text)) {
      const answer = await handleCancelFlow({ userId, text, ai: emptyAi(), session, config });
      await safeReplyText(event, userId, answer || '我沒有收到完整訊息，請再說一次。');
      return;
    }
    if (isStopText(text)) {
      sessions.delete(userId);
      await safeReplyText(event, userId, '好的，先不預約。如需預約再告訴我。');
      return;
    }

    const profile = await getLineProfile(userId);
    const local = extractLocalBookingData(text, config);
    adjustAmbiguousTimeWithContext(local.booking, text, session.booking, config.settings);
    const ai = shouldSkipAi(text, session, local)
      ? fallbackExtract(text, config)
      : await understandMessage(text, session, config);
    adjustAmbiguousTimeWithContext(ai.booking, text, session.booking, config.settings);
    const answer = await runConversation({ userId, profile, text, ai, session, config });
    await safeReplyText(event, userId, answer || '我沒有收到完整訊息，請再說一次。');
  } catch (error) {
    console.error('handleEvent failed:', error);
    await safeReplyText(event, userId, '系統暫時忙碌，請稍後再試；若急著預約，請直接聯絡店家協助。');
  }
}

async function runConversation({ userId, profile, text, ai, session, config }) {
  const local = extractLocalBookingData(text, config);
  adjustAmbiguousTimeWithContext(local.booking, text, session.booking, config.settings);
  adjustAmbiguousTimeWithContext(ai.booking, text, session.booking, config.settings);
  const availabilityAnswer = answerAvailabilityQuery(text, config);
  if (availabilityAnswer) return availabilityAnswer;

  if (session.step?.startsWith('reschedule') || ai.intent === 'reschedule' || isRescheduleText(text)) {
    return handleRescheduleFlow({ userId, text, ai, local, session, config });
  }

  if (session.step?.startsWith('cancel') || ai.intent === 'cancel') {
    return handleCancelFlow({ userId, text, ai, session, config });
  }

  const isActiveBookingFlow = Boolean(session.booking?.service || session.booking?.artist || session.step?.startsWith('ask_') || session.step === 'confirm_booking');
  if (ai.intent === 'faq' && !(isActiveBookingFlow && (local.booking.date || local.booking.period || local.booking.time))) {
    return answerFaq(text, config) || config.settings.ai_fallback_reply || '這個問題我幫您請店家確認。';
  }

  forceSearchCorrectionFromLocalText(ai, local);
  applyQuickReplyNumber(text, session, config);
  resetChosenTimeIfSearchChanged(session.booking, ai.booking);
  resetChosenTimeIfSearchChanged(session.booking, local.booking);
  mergeBookingData(session.booking, ai.booking);
  mergeBookingData(session.booking, local.booking);
  clearChosenTimeForDateOrPeriodOnlyMessage(session.booking, local.booking);

  if (!session.booking.service) {
    session.step = 'ask_service';
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

  const activeArtists = config.artists || [];
  if (!session.booking.artist && activeArtists.length === 1) {
    session.booking.artist = activeArtists[0].name;
  }

  if (!session.booking.artist) {
    session.step = 'ask_artist';
    return buildArtistOptions(config, service);
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
    return buildAvailableSlots(config, session.booking.artist, service, session.booking);
  }

  if (!isBookingFarEnough(session.booking, config.settings)) {
    session.booking.date = '';
    session.booking.time = '';
    session.step = 'ask_time';
    const hours = Number(config.settings.min_hours_before_booking || 0);
    return `這個時間太近了，店家最少需要提前 ${hours} 小時預約。\n\n${buildAvailableSlots(config, session.booking.artist, service, session.booking)}`;
  }

  const slots = findConsecutiveSlots(config.slots, session.booking, service, config.settings);
  if (!slots.length) {
    session.booking.date = '';
    session.booking.time = '';
    session.step = 'ask_time';
    return `這個時間沒有足夠完成「${service.name}」的連續空檔。\n\n${buildAvailableSlots(config, session.booking.artist, service, session.booking)}`;
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

  if (session.step !== 'confirm_booking') {
    session.step = 'confirm_booking';
    return [
      '請確認預約資訊：',
      `服務：${service.name}（約 ${service.duration} 分鐘）`,
      `美甲師：${session.booking.artist}`,
      `時間：${session.booking.date} ${session.booking.time}`,
      `姓名：${session.booking.customerName}`,
      `電話：${session.booking.phone}`,
      '確認無誤請回覆「確認預約」。',
    ].join('\n');
  }

  if (!isConfirmBookingText(text)) {
    return '如果資訊正確，請回覆「確認預約」。如果要重來，請回覆「重來」。';
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
  notifyShop(`新預約 ${booking.bookingId}\n客人：${booking.customerName}\n電話：${booking.phone}\n服務：${booking.service}\n美甲師：${booking.artist}\n時間：${booking.date} ${booking.time}`).catch((error) => {
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
    '請保留此編號，之後取消或更改預約會用到。',
  ].filter(Boolean).join('\n');
}

async function handleCancelFlow({ userId, text, ai, session, config }) {
  const bookingIdFromText = normalizeShortBookingInput(ai.cancel?.bookingId || text);

  if (session.step === 'cancel_confirm' && isConfirmCancelText(text)) {
    const booking = session.cancelBooking;
    if (!booking) {
      session.step = 'start';
      return '取消資訊已過期，請重新輸入「取消預約」。';
    }
    try {
      await cancelBooking(userId, booking.id);
      await releaseLockedSlots(booking.id);
      notifyShop(`預約已取消 ${booking.id}\n客人：${booking.customer}\n服務：${booking.service}\n美甲師：${booking.artist}\n時間：${booking.date} ${booking.start}`).catch((error) => {
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
    '確認取消請回覆「確認取消」。',
  ].join('\n');
}

async function understandMessage(text, session, config) {
  const now = nowInZone();
  const prompt = [
    config.settings.ai_system_prompt || '你是約好 AI 的美甲預約助理。',
    config.settings.ai_booking_rules || '每次只問一個問題，不重複詢問已提供資訊。',
    '請只輸出 JSON，不要加任何解釋。',
    '可用 intent: booking, cancel, reschedule, faq, unknown。',
    'booking 欄位可包含 service, artist, date, time, customerName, phone, note。',
    'cancel 欄位可包含 bookingId。',
    'date 請輸出 YYYY-MM-DD；time 請輸出 HH:mm。若不確定就留空字串。',
    '每一則訊息都要先判斷客人真正目的，不要只照前一步流程走。',
    '如果客人說「我要改預約時間」「可以提前嗎」「改晚一點」「改約星期三」，intent 必須是 reschedule。',
    '如果客人表達提前、延後、改晚一點、改早一點、換日期、換時間、改約某天、改預約時間，intent 必須是 reschedule。',
    '如果客人問「3點可以嗎」「15號下午」「晚上有嗎」，且正在預約流程中，intent 是 booking，並盡量輸出 date/time/period。',
    '如果客人問可預約時間，不能建議已經過去或太接近現在的時間。',
    `目前時間：${now.format('YYYY-MM-DD HH:mm')}，時區：${timezone}`,
    `服務項目：${config.services.map((s) => `${s.name}(${s.duration}分鐘)`).join('、')}`,
    `美甲師：${config.artists.map((a) => a.name).join('、')}`,
    `目前對話狀態：${JSON.stringify(session.booking)}`,
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
  };
  console.log(`AI_DECISION ${JSON.stringify(summary)}`);
}

function normalizeAiJson(json) {
  return {
    intent: json.intent || 'unknown',
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
    booking: { service: '', artist: '', date: '', time: '', customerName: '', phone: '', note: '', period: '' },
    cancel: { bookingId: '' },
  };
}

function fallbackExtract(text, config = { services: [], artists: [] }) {
  const phone = text.match(/09\d{8}/)?.[0] || '';
  const local = extractLocalBookingData(text, config);
  return {
    intent: isRescheduleText(text) ? 'reschedule' : text.includes('取消') ? 'cancel' : 'booking',
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

async function loadConfig() {
  if (cache.data && Date.now() < cache.expiresAt) return cache.data;
  const data = await appsScriptRequest('getConfig');
  cache.data = data;
  cache.expiresAt = Date.now() + 60 * 1000;
  return cache.data;
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

async function lockSlots(slots, bookingId) {
  return { slots, bookingId };
}

async function releaseLockedSlots(bookingId) {
  return { bookingId };
}

function buildServiceOptions(config) {
  const services = Array.isArray(config.services) ? config.services : [];
  return [
    '想預約哪一項服務呢？',
    ...services.map((service, index) => `${index + 1}. ${service.name}｜約 ${service.duration} 分｜NT$${service.price}`),
    '如果還不知道款式，可以選「款式諮詢/簡易服務」。',
    '請直接回覆編號。',
  ].join('\n');
}

function buildRestartMessage() {
  return [
    '好的，已重新開始。',
    '請問您想預約，還是需要調整已有預約呢？',
  ].join('\n');
}

function buildArtistOptions(config, service) {
  const artists = artistsForService(config.artists, service);
  return [
    `想指定哪位美甲師做「${service.name}」嗎？`,
    ...artists.map((artist, index) => `${index + 1}. ${artist.name}｜${artist.note || '可預約'}`),
    '請直接回覆編號。',
  ].join('\n');
}

function buildAvailableSlots(config, artist, service, booking = {}) {
  const candidates = findAvailableStartSlots(config.slots, { ...booking, artist }, service, config.settings).slice(0, 8);
  if (!candidates.length) {
    const scope = [
      booking.date ? booking.date : '',
      booking.period ? periodLabel(booking.period) : '',
    ].filter(Boolean).join(' ');
    return `${scope ? `${scope} ` : ''}目前沒有足夠的可預約時段，請換其他日期、時段或美甲師。`;
  }
  return [
    `${artist} 做「${service.name}」約 ${service.duration} 分鐘，可以預約以下時段：`,
    ...candidates.map((slot, index) => `${index + 1}. ${slot.date} ${slot.time}｜${slot.artist}`),
    '請直接回覆上面的編號數字，或輸入您希望的日期與時間（例如：5/20 1600）。',
  ].join('\n');
}

function findAvailableStartSlots(slots, booking, service, settings, ignoreBookingId = '') {
  const starts = slots.filter((slot) => {
    if (booking.artist && slot.artist !== booking.artist) return false;
    if (booking.date && slot.date !== booking.date) return false;
    if (!isFutureEnough(slot, settings)) return false;
    if (booking.period && !isInPeriod(slot.time, booking.period)) return false;
    return isSlotOpenForBooking(slot, ignoreBookingId);
  }).sort(compareSlots);
  return starts.filter((slot) => findConsecutiveSlots(slots, { ...booking, date: slot.date, time: slot.time, artist: slot.artist }, service, settings, ignoreBookingId).length);
}

function findFirstAvailableSlotAtRequestedTime(slots, booking, service, settings, ignoreBookingId = '') {
  if (!booking.time) return null;
  return slots
    .filter((slot) => {
      if (booking.artist && slot.artist !== booking.artist) return false;
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
  if (slot.status === '可預約' && !slot.lockedBookingId) return true;
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

function answerAvailabilityQuery(text, config) {
  const mentionsKnownArtist = (config.artists || []).some((artist) => text.includes(artist.name));
  const asksAvailability = /(美甲師|設計師).*(可預約|可以約|有空|在嗎)|今天.*(誰|哪位|哪個).*可/.test(text)
    || (mentionsKnownArtist && /(可預約|可以約|有空|在嗎)/.test(text))
    || (/今天.*(在嗎|有空|可預約|可以約)/.test(text));
  if (!asksAvailability) return '';
  const local = extractLocalBookingData(text, config);
  const date = local.booking.date || nowInZone().format('YYYY-MM-DD');
  const artistName = local.booking.artist || findMentionedArtistName(text, config.artists);

  if (artistName && !config.artists.some((artist) => artist.name === artistName)) {
    return [
      `目前沒有找到「${artistName}」這位美甲師。`,
      `目前可接單的美甲師有：${config.artists.map((artist) => artist.name).join('、')}。`,
      '請問想預約哪一項服務？我會依服務時間幫您確認完整時段。',
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

  if (session.step === 'reschedule_confirm' && isConfirmRescheduleText(text)) {
    const draft = session.rescheduleDraft;
    if (!draft) {
      session.step = 'reschedule_select';
      return '修改資訊已過期，請重新選擇要更改的預約。';
    }
    try {
      const result = await rescheduleBooking(userId, draft);
      notifyShop(`預約已修改 ${result.bookingId}\n客人：${result.customerName}\n服務：${result.service}\n美甲師：${result.artist}\n時間：${result.date} ${result.time}`).catch((error) => {
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
    return [
      `${next.date} ${next.time} 目前沒有足夠完成「${service.name}」的連續空檔。`,
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
    '確認請回覆「確認修改」。',
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
  const half = text.match(/(\d{1,2})\s*點半/);
  if (half) return normalizeHourMinute(Number(half[1]), 30, text);
  const colon = text.match(/(\d{1,2})[:：](\d{2})/);
  if (colon) return normalizeHourMinute(Number(colon[1]), Number(colon[2]), text);
  const compact = text.match(/(?:^|[^\d])(\d{3,4})(?:$|[^\d])/);
  if (compact && !/[/-]/.test(text)) {
    const raw = compact[1].padStart(4, '0');
    const hour = Number(raw.slice(0, 2));
    const minute = Number(raw.slice(2, 4));
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return normalizeHourMinute(hour, minute, text);
  }
  const hour = text.match(/(\d{1,2})\s*點/);
  if (hour) return normalizeHourMinute(Number(hour[1]), 0, text);
  return '';
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
  if (contextPeriod === 'afternoon' || contextPeriod === 'evening' || hour < dayStartHour) {
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

function shouldSkipAi(text, session, local) {
  if (/^\d+$/.test(text.trim())) return true;
  if (session.step === 'ask_contact' && /09\d{8}/.test(text)) return true;
  if (isConfirmBookingText(text) || isConfirmCancelText(text) || isConfirmRescheduleText(text)) return true;
  if (isRescheduleText(text) || isCancelBookingRequestText(text) || isAbandonBookingText(text) || isResetText(text)) return true;
  if (isActiveBookingSession(session) && (local.booking.date || local.booking.time || local.booking.period)) return true;
  return false;
}

function applyQuickReplyNumber(text, session, config) {
  if (!/^\d+$/.test(text.trim())) return;
  const index = Number(text.trim()) - 1;
  if (session.step === 'ask_service' && config.services[index]) {
    session.booking.service = config.services[index].name;
  }
  if (session.step === 'ask_artist') {
    const service = findService(config.services, session.booking.service);
    const artists = service ? artistsForService(config.artists, service) : config.artists;
    if (artists[index]) session.booking.artist = artists[index].name;
  }
  if (session.step === 'ask_time') {
    const service = findService(config.services, session.booking.service);
    if (!service) return;
    const slots = findAvailableStartSlots(config.slots, session.booking, service, config.settings);
    if (slots[index]) {
      session.booking.artist = slots[index].artist;
      session.booking.date = slots[index].date;
      session.booking.time = slots[index].time;
    }
  }
}

function getSession(userId, config) {
  const ttl = Number(config?.settings?.session_ttl_minutes || process.env.SESSION_TTL_MINUTES || 120) * 60 * 1000;
  const existing = sessions.get(userId);
  if (existing && Date.now() - existing.updatedAt < ttl) {
    existing.updatedAt = Date.now();
    return existing;
  }
  const session = {
    updatedAt: Date.now(),
    step: 'start',
    booking: { service: '', artist: '', date: '', time: '', customerName: '', phone: '', note: '' },
    rescheduleChange: {},
  };
  sessions.set(userId, session);
  return session;
}

async function getLineProfile(userId) {
  if (!userId || !userId.startsWith('U')) return {};
  try {
    return await lineClient.getProfile(userId);
  } catch (_error) {
    return {};
  }
}

async function notifyShop(text) {
  const notifyId = process.env.SHOP_NOTIFY_LINE_ID;
  if (!notifyId) return;
  await lineClient.pushMessage({ to: notifyId, messages: [{ type: 'text', text }] });
}

async function replyText(replyToken, text) {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: String(text).slice(0, 4500) }],
  });
}

async function safeReplyText(event, userId, text) {
  try {
    await replyText(event.replyToken, text);
  } catch (error) {
    console.error('replyText failed, trying pushMessage:', error.response?.data || error.message);
    if (userId && userId.startsWith('U')) {
      await lineClient.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: String(text).slice(0, 4500) }],
      });
    } else {
      throw error;
    }
  }
}

async function appsScriptRequest(action, data = {}) {
  const response = await axios.post(
    requiredEnv('APPS_SCRIPT_WEB_APP_URL'),
    {
      action,
      token: requiredEnv('APPS_SCRIPT_API_TOKEN'),
      ...data,
    },
    { timeout: 20000 }
  );
  if (!response.data?.ok) {
    throw new Error(response.data?.error || `Apps Script action failed: ${action}`);
  }
  return response.data.data;
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
  return /(算了|先不用|不用了|不約了|先不要|改天再約|下次再約|暫時不用)/.test(text.trim());
}

function isConfirmBookingText(text) {
  return ['確認', '確認預約', '對', '沒錯', '可以'].includes(text.trim());
}

function isConfirmCancelText(text) {
  return ['確認取消', '確定取消', '取消沒錯'].includes(text.trim());
}

function isConfirmRescheduleText(text) {
  return ['確認修改', '確定修改', '確認改期', '確認更改', '修改沒錯'].includes(text.trim());
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

app.listen(port, () => {
  console.log(`約好 AI MVP v3 listening on ${port}`);
});
