require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const dayjs = require('dayjs');

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
  res.json({ ok: true, service: '約好 AI MVP v2', webhook: '/line/webhook' });
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
  const config = await loadConfig();
  const session = getSession(userId, config);

  if (isResetText(text)) {
    sessions.delete(userId);
    await replyText(event.replyToken, '好的，已重新開始。想預約哪一項服務呢？');
    return;
  }

  const profile = await getLineProfile(userId);
  const ai = await understandMessage(text, session, config);
  const answer = await runConversation({ userId, profile, text, ai, session, config });
  await replyText(event.replyToken, answer);
}

async function runConversation({ userId, profile, text, ai, session, config }) {
  if (session.step?.startsWith('cancel') || ai.intent === 'cancel') {
    return handleCancelFlow({ userId, text, ai, session, config });
  }

  if (ai.intent === 'faq') {
    return answerFaq(text, config) || config.settings.ai_fallback_reply || '這個問題我幫您請店家確認。';
  }

  applyQuickReplyNumber(text, session, config);
  mergeBookingData(session.booking, ai.booking);

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

  if (!session.booking.artist) {
    session.step = 'ask_artist';
    return buildArtistOptions(config, service);
  }

  if (!session.booking.date || !session.booking.time) {
    session.step = 'ask_time';
    return buildAvailableSlots(config, session.booking.artist, service);
  }

  if (!isBookingFarEnough(session.booking, config.settings)) {
    session.booking.date = '';
    session.booking.time = '';
    session.step = 'ask_time';
    const hours = Number(config.settings.min_hours_before_booking || 0);
    return `這個時間太近了，店家最少需要提前 ${hours} 小時預約。\n\n${buildAvailableSlots(config, session.booking.artist, service)}`;
  }

  const slots = findConsecutiveSlots(config.slots, session.booking, service, config.settings);
  if (!slots.length) {
    session.booking.date = '';
    session.booking.time = '';
    session.step = 'ask_time';
    return `這個時間沒有足夠完成「${service.name}」的連續空檔。\n\n${buildAvailableSlots(config, session.booking.artist, service)}`;
  }

  if (!session.booking.customerName || !session.booking.phone) {
    session.step = 'ask_contact';
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

  const booking = await createBooking({
    userId,
    lineDisplayName: profile.displayName || '',
    booking: session.booking,
    service,
  });
  await lockSlots(slots, booking.bookingId);
  await notifyShop(`新預約 ${booking.bookingId}\n客人：${booking.customerName}\n電話：${booking.phone}\n服務：${booking.service}\n美甲師：${booking.artist}\n時間：${booking.date} ${booking.time}`);
  sessions.delete(userId);

  return [
    `預約成功：${booking.bookingId}`,
    `服務：${booking.service}`,
    `美甲師：${booking.artist}`,
    `時間：${booking.date} ${booking.time}`,
    config.settings.shop_address ? `地址：${config.settings.shop_address}` : '',
  ].filter(Boolean).join('\n');
}

async function handleCancelFlow({ userId, text, ai, session, config }) {
  const bookingIdFromText = ai.cancel?.bookingId || text.match(/\d+/)?.[0] || '';

  if (session.step === 'cancel_confirm' && isConfirmCancelText(text)) {
    const booking = session.cancelBooking;
    if (!booking) {
      session.step = 'start';
      return '取消資訊已過期，請重新輸入「取消預約」。';
    }
    await cancelBooking(userId, booking.id);
    await releaseLockedSlots(booking.id);
    await notifyShop(`預約已取消 ${booking.id}\n客人：${booking.customer}\n服務：${booking.service}\n美甲師：${booking.artist}\n時間：${booking.date} ${booking.start}`);
    sessions.delete(userId);
    return `已取消預約 ${booking.id}。`;
  }

  const bookings = await loadUserActiveBookings(userId);
  if (!bookings.length) {
    session.step = 'start';
    return '目前沒有找到你可取消的預約。若是店家代訂，請直接聯絡店家協助。';
  }

  let target = null;
  if (bookingIdFromText) {
    target = bookings.find((booking) => String(booking.id) === String(bookingIdFromText));
  }
  if (!target && /^\d+$/.test(text.trim())) {
    target = bookings[Number(text.trim()) - 1];
  }

  if (!target) {
    session.step = 'cancel_select';
    session.cancelOptions = bookings;
    return [
      '請選擇要取消的預約：',
      ...bookings.map((booking, index) => `${index + 1}. ${booking.date} ${booking.start}｜${booking.artist}｜${booking.service}｜編號 ${booking.id}`),
      '請回覆編號，例如「取消 1」。',
    ].join('\n');
  }

  session.step = 'cancel_confirm';
  session.cancelBooking = target;
  return [
    '請確認是否取消這筆預約：',
    `編號：${target.id}`,
    `服務：${target.service}`,
    `美甲師：${target.artist}`,
    `時間：${target.date} ${target.start}`,
    '確認取消請回覆「確認取消」。',
  ].join('\n');
}

async function understandMessage(text, session, config) {
  const prompt = [
    config.settings.ai_system_prompt || '你是約好 AI 的美甲預約助理。',
    config.settings.ai_booking_rules || '每次只問一個問題，不重複詢問已提供資訊。',
    '請只輸出 JSON，不要加任何解釋。',
    '可用 intent: booking, cancel, faq, unknown。',
    'booking 欄位可包含 service, artist, date, time, customerName, phone, note。',
    'cancel 欄位可包含 bookingId。',
    'date 請輸出 YYYY-MM-DD；time 請輸出 HH:mm。若不確定就留空字串。',
    `今天日期：${dayjs().format('YYYY-MM-DD')}，時區：${timezone}`,
    `服務項目：${config.services.map((s) => `${s.name}(${s.duration}分鐘)`).join('、')}`,
    `美甲師：${config.artists.map((a) => a.name).join('、')}`,
    `目前對話狀態：${JSON.stringify(session.booking)}`,
    `客人訊息：${text}`,
  ].join('\n');

  try {
    const response = await axios.post(
      `${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`,
      {
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
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
    return normalizeAiJson(JSON.parse(response.data.choices?.[0]?.message?.content || '{}'));
  } catch (error) {
    console.error('DeepSeek parse failed:', error.response?.data || error.message);
    return fallbackExtract(text);
  }
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
    },
    cancel: {
      bookingId: json.cancel?.bookingId || '',
    },
  };
}

function fallbackExtract(text) {
  const phone = text.match(/09\d{8}/)?.[0] || '';
  return {
    intent: text.includes('取消') ? 'cancel' : 'booking',
    booking: {
      service: '',
      artist: '',
      date: '',
      time: normalizeTime(text.match(/(\d{1,2})[:：點](\d{2})?/)?.[0] || ''),
      customerName: phone ? text.replace(phone, '').trim() : '',
      phone,
      note: text,
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
    .filter((booking) => dayjs(`${booking.date} ${booking.start}`).isAfter(dayjs().subtract(1, 'day')))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

async function cancelBooking(userId, bookingId) {
  await appsScriptRequest('cancelBooking', { userId, bookingId });
  cache.expiresAt = 0;
  return bookingId;
}

async function lockSlots(slots, bookingId) {
  return { slots, bookingId };
}

async function releaseLockedSlots(bookingId) {
  return { bookingId };
}

function buildServiceOptions(config) {
  return [
    '想預約哪一項服務呢？',
    ...config.services.map((service, index) => `${index + 1}. ${service.name}｜約 ${service.duration} 分｜NT$${service.price}`),
    '如果還不知道款式，可以選「款式諮詢/簡易服務」。',
  ].join('\n');
}

function buildArtistOptions(config, service) {
  const artists = artistsForService(config.artists, service);
  return [
    `想指定哪位美甲師做「${service.name}」嗎？`,
    ...artists.map((artist, index) => `${index + 1}. ${artist.name}｜${artist.note || '可預約'}`),
  ].join('\n');
}

function buildAvailableSlots(config, artist, service) {
  const candidates = findAvailableStartSlots(config.slots, { artist }, service, config.settings).slice(0, 8);
  if (!candidates.length) return '目前沒有足夠的可預約時段，請店家先重新整理可預約時段，或改其他美甲師/日期。';
  return [
    `${artist} 做「${service.name}」約 ${service.duration} 分鐘，可以預約以下時段：`,
    ...candidates.map((slot, index) => `${index + 1}. ${slot.date} ${slot.time}｜${slot.artist}`),
    '請直接回覆編號或日期時間。',
  ].join('\n');
}

function findAvailableStartSlots(slots, booking, service, settings) {
  const starts = slots.filter((slot) => {
    if (booking.artist && slot.artist !== booking.artist) return false;
    if (booking.date && slot.date !== booking.date) return false;
    return slot.status === '可預約' && !slot.lockedBookingId;
  });
  return starts.filter((slot) => findConsecutiveSlots(slots, { ...booking, date: slot.date, time: slot.time, artist: slot.artist }, service, settings).length);
}

function findConsecutiveSlots(slots, booking, service, settings) {
  const slotMinutes = Number(settings.slot_minutes || 30);
  const needed = Math.ceil(Number(service.duration || 0) / slotMinutes);
  const start = timeToMinutes(booking.time);
  const found = [];

  for (let i = 0; i < needed; i += 1) {
    const time = minutesToTime(start + i * slotMinutes);
    const slot = slots.find((item) => (
      item.artist === booking.artist
      && item.date === booking.date
      && item.time === time
      && item.status === '可預約'
      && !item.lockedBookingId
    ));
    if (!slot) return [];
    found.push(slot);
  }
  return found;
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

function findService(services, input) {
  if (!input) return null;
  return services.find((service) => service.name === input || service.name.includes(input) || input.includes(service.name));
}

function artistsForService(artists, service) {
  return artists.filter((artist) => !artist.services || artist.services.includes(service.name));
}

function mergeBookingData(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    if (value) target[key] = value;
  });
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
  return dayjs(`${booking.date} ${booking.time}`).diff(dayjs(), 'minute') >= hours * 60;
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
  if (typeof value === 'string') return dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : value;
  return dayjs(value).format('YYYY-MM-DD');
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
  return ['重來', '重新開始', '取消操作', 'reset'].includes(text.toLowerCase());
}

function isConfirmBookingText(text) {
  return ['確認', '確認預約', '對', '沒錯', '可以'].includes(text.trim());
}

function isConfirmCancelText(text) {
  return ['確認取消', '確定取消', '取消沒錯'].includes(text.trim());
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

app.listen(port, () => {
  console.log(`約好 AI MVP v2 listening on ${port}`);
});
