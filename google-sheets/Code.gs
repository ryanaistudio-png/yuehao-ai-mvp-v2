/**
 * 約好 AI MVP v3
 * LINE AI 預約 + Google Sheet 店家後台
 */

const SHEETS = {
  week: '01 一週預約表',
  add: '02 現場新增',
  edit: '03 修改預約',
  query: '04 預約查詢',
  bookings: '05 預約資料庫',
  customers: '06 客戶資料庫',
  services: '07 服務設定',
  artists: '08 美甲師設定',
  special: '09 特殊休假',
  fixed: '10 固定班表',
  settings: '90 系統設定',
  slots: '91 可預約時段',
  options: '92 選項資料',
};

const TAB_ORDER = [
  SHEETS.week,
  SHEETS.add,
  SHEETS.edit,
  SHEETS.query,
  SHEETS.bookings,
  SHEETS.customers,
  SHEETS.services,
  SHEETS.artists,
  SHEETS.special,
  SHEETS.fixed,
  SHEETS.settings,
  SHEETS.slots,
  SHEETS.options,
];

// 如果 Apps Script 是從 Google Sheet 內開啟，可以留空。
// 如果是從 https://script.google.com/home 建立獨立專案，請填入 Google Sheet 網址 /d/ 和 /edit 中間那串 ID。
const SPREADSHEET_ID = '1e-fz48STCograxywrKQSkK56WZ1C7-YwU0ZwPmfwyyY';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('約好 AI 操作')
    .addItem('更新預約畫面', 'refreshSystemData')
    .addItem('同步美甲師與班表', 'syncArtistsAndRefresh')
    .addItem('套用 v3 安全版面', 'applyV3Layout')
    .addToUi();

  SpreadsheetApp.getUi()
    .createMenu('系統表')
    .addItem('顯示系統表', 'showSystemSheets')
    .addItem('隱藏系統表', 'hideSystemSheets')
    .addItem('刪除舊版重複表', 'deleteLegacySheets')
    .addToUi();
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const name = sheet.getName();
  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (name === SHEETS.week && row === 2 && col === 2) buildWeekView_(getAppSpreadsheet_());
  if (name === SHEETS.add && row === 12 && col === 2) handleAddCommand_(sheet);
  if (name === SHEETS.edit && row === 10 && col === 2) handleEditCommand_(sheet);
  if (name === SHEETS.query && row === 2 && [2, 5].includes(col)) buildBookingQuery_(getAppSpreadsheet_());
  if ([SHEETS.artists, SHEETS.fixed, SHEETS.special, SHEETS.services, SHEETS.settings].includes(name) && e.range.getRow() >= 2) {
    refreshSystemData(false);
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const ss = getAppSpreadsheet_();
    const settings = readSettings_(ss);
    const expectedToken = String(settings.api_token || '').trim();
    const receivedToken = String(payload.token || '').trim();
    if (!expectedToken || receivedToken !== expectedToken) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    if (payload.action === 'getConfig') return jsonResponse_({ ok: true, data: getApiConfig_(ss) });
    if (payload.action === 'createBooking') return jsonResponse_({ ok: true, data: createApiBooking_(ss, payload.booking || {}) });
    if (payload.action === 'getUserActiveBookings') return jsonResponse_({ ok: true, data: getApiUserActiveBookings_(ss, payload.userId || '') });
    if (payload.action === 'getCustomerProfile') return jsonResponse_({ ok: true, data: getApiCustomerProfile_(ss, payload.userId || '') });
    if (payload.action === 'updateBooking') return jsonResponse_({ ok: true, data: updateApiBooking_(ss, payload.userId || '', payload.booking || {}) });
    if (payload.action === 'cancelBooking') return jsonResponse_({ ok: true, data: cancelApiBooking_(ss, payload.userId || '', payload.bookingId || '') });
    if (payload.action === 'getStoreTodayBookings') return jsonResponse_({ ok: true, data: getStoreTodayBookings_(ss) });
    if (payload.action === 'getStoreBookingsByDate') return jsonResponse_({ ok: true, data: getStoreBookingsByDate_(ss, payload.date || '') });
    if (payload.action === 'getStoreBooking') return jsonResponse_({ ok: true, data: getStoreBooking_(ss, payload.bookingId || '') });
    if (payload.action === 'getStoreBookingCandidates') return jsonResponse_({ ok: true, data: getStoreBookingCandidates_(ss, payload.bookingId || '') });
    if (payload.action === 'searchStoreCustomerBookings') return jsonResponse_({ ok: true, data: searchStoreCustomerBookings_(ss, payload.query || '') });
    if (payload.action === 'storeCreateBooking') return jsonResponse_({ ok: true, data: storeCreateBooking_(ss, payload.booking || {}) });
    if (payload.action === 'storeExtendBooking') return jsonResponse_({ ok: true, data: storeExtendBooking_(ss, payload.bookingId || '', payload.extraMinutes || 0) });
    if (payload.action === 'storeUpdateBooking') return jsonResponse_({ ok: true, data: storeUpdateBooking_(ss, payload.booking || {}) });
    if (payload.action === 'storeCancelBooking') return jsonResponse_({ ok: true, data: storeCancelBooking_(ss, payload.bookingId || '') });

    return jsonResponse_({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message });
  }
}

function setupYuehaoV3() {
  const ss = getAppSpreadsheet_();
  Object.values(SHEETS).forEach((name) => {
    const sheet = getOrCreateSheet_(ss, name);
    sheet.clear();
    sheet.clearConditionalFormatRules();
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  });

  setupOptions_(ss);
  setupSettings_(ss);
  setupServices_(ss);
  setupArtists_(ss);
  setupFixedSchedule_(ss);
  setupSpecialDays_(ss);
  setupBookings_(ss, true);
  setupCustomers_(ss);
  setupWeekView_(ss);
  setupAddSheet_(ss);
  setupEditSheet_(ss);
  setupQuerySheet_(ss);
  setupSlots_(ss);

  refreshDropdowns_();
  refreshSystemData(false);
  sortAndColorSheets_(ss);
  freezeFirstColumnAllSheets_(ss);
  hideSystemSheets();
  safeUiAlert_('約好 AI MVP v3 已建立完成。');
}

function applyV3Layout() {
  const ss = getAppSpreadsheet_();
  Object.values(SHEETS).forEach((name) => getOrCreateSheet_(ss, name));
  setupOptions_(ss);
  ensureDefaultSettings_(ss);
  ensureCoreDataTables_(ss);
  syncFixedScheduleArtists_(ss);
  setupWeekView_(ss);
  setupAddSheet_(ss);
  setupEditSheet_(ss);
  setupQuerySheet_(ss);
  setupCustomers_(ss);
  ensureBookingDatabaseLayout_(ss);
  refreshDropdowns_();
  buildWeekView_(ss);
  buildBookingQuery_(ss);
  sortAndColorSheets_(ss);
  freezeFirstColumnAllSheets_(ss);
  deleteLegacySheets();
  hideSystemSheets();
  safeUiAlert_('已套用 v3 安全版面，不會清空預約資料。若需要重新產生 LINE 可預約時段，請再執行「更新預約畫面」。');
}

function refreshSystemData(showUi) {
  const ss = getAppSpreadsheet_();
  syncFixedScheduleArtists_(ss);
  refreshDropdowns_();
  rebuildAvailableSlots_(ss);
  buildWeekView_(ss);
  buildBookingQuery_(ss);
  rebuildCustomers_(ss);
  applyBookingStatusRowRules_(ss);
  freezeFirstColumnAllSheets_(ss);
  if (showUi !== false) safeUiAlert_('已更新預約畫面。');
}

function refreshApiBookingData_(ss) {
  rebuildAvailableSlots_(ss);
  rebuildCustomers_(ss);
  buildBookingQuery_(ss);
  applyBookingStatusRowRules_(ss);
  SpreadsheetApp.flush();
}

function syncArtistsAndRefresh() {
  const ss = getAppSpreadsheet_();
  syncFixedScheduleArtists_(ss);
  refreshDropdowns_();
  refreshSystemData(false);
  safeUiAlert_('已同步美甲師、班表與預約畫面。');
}

function ensureCoreDataTables_(ss) {
  if (isSheetEmpty_(ss.getSheetByName(SHEETS.services))) setupServices_(ss);
  if (isSheetEmpty_(ss.getSheetByName(SHEETS.artists))) setupArtists_(ss);
  if (isSheetEmpty_(ss.getSheetByName(SHEETS.special))) setupSpecialDays_(ss);
  if (isSheetEmpty_(ss.getSheetByName(SHEETS.fixed))) setupFixedSchedule_(ss);
}

function isSheetEmpty_(sheet) {
  if (!sheet) return true;
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  return values.every((row) => row.every((cell) => cell === '' || cell === null));
}

function setupWeekView_(ss) {
  const sheet = ss.getSheetByName(SHEETS.week);
  resetSheetForLayout_(sheet);
  sheet.getRange('A1:H1').breakApart();
  sheet.getRange(1, 1, 2, 8).setValues([
    ['此表主要供查看。新增請到 02，修改/取消/延時請到 03。', '', '', '', '', '', '', ''],
    ['查看週別', '本週', '', '', '', '', '', ''],
  ]);
  sheet.getRange('A1:H1').merge().setFontColor('#b91c1c').setFontWeight('bold').setBackground('#fee2e2');
  sheet.getRange('A2:B2').setBackground('#f8fafc');
  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(1);
  sheet.setColumnWidths(1, 8, 135);
}

function setupAddSheet_(ss) {
  const sheet = ss.getSheetByName(SHEETS.add);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 13, 3).setValues([
    ['重要提醒', '填完資料後，請在最下方「執行指令」選擇「執行現場新增」。', ''],
    ['美甲師', '', '必填'],
    ['服務', '', '必填'],
    ['日期', new Date(), '必填'],
    ['開始時間', '10:00', '必填'],
    ['占用分鐘', '', '可空白，系統會用服務設定的分鐘'],
    ['允許特殊時段', '否', '預設否；遇休假、非營業、已過時間需改成是再執行'],
    ['客人姓名', '現場客', '可選'],
    ['電話', '', '可選'],
    ['備註', '', '可選'],
    ['', '', ''],
    ['執行指令', '未執行', '未執行 / 執行現場新增 / 更新預約畫面'],
    ['執行結果', '', '系統自動填'],
  ]);
  sheet.getRange('A1:C1').setFontColor('#b91c1c').setFontWeight('bold').setBackground('#fee2e2');
  sheet.getRange('B4').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('B5').setNumberFormat('hh:mm');
  styleKeyValueSheet_(sheet, 13);
}

function setupEditSheet_(ss) {
  const sheet = ss.getSheetByName(SHEETS.edit);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 11, 3).setValues([
    ['重要提醒', '先輸入預約編號並載入資料，再修改服務、美甲師、時間、調整分鐘或取消。', ''],
    ['預約編號', '', '建議輸入完整編號，例如 202606-001；短編號重複時系統會提示'],
    ['目前預約資訊', '', '載入後自動顯示'],
    ['新美甲師', '', '修改美甲師時填寫；空白則沿用原本'],
    ['新服務', '', '修改服務時填寫；空白則沿用原本'],
    ['新日期', '', '修改日期/時間時填寫；空白則沿用原本'],
    ['新開始時間', '', '修改日期/時間時填寫；空白則沿用原本'],
    ['調整分鐘', '', '延長填正數，縮短填負數'],
    ['允許特殊時段', '否', '預設否；遇休假、非營業、已過時間需改成是再執行'],
    ['執行指令', '未執行', '未執行 / 載入預約 / 修改預約 / 延長時間 / 取消預約 / 更新預約畫面'],
    ['執行結果', '', '系統自動填'],
  ]);
  sheet.getRange('A1:C1').setFontColor('#b91c1c').setFontWeight('bold').setBackground('#fee2e2');
  sheet.getRange('B6').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('B7').setNumberFormat('hh:mm');
  styleKeyValueSheet_(sheet, 11);
}

function setupQuerySheet_(ss) {
  const sheet = ss.getSheetByName(SHEETS.query);
  resetSheetForLayout_(sheet);
  sheet.getRange('A1:K1').breakApart();
  sheet.getRange(1, 1, 3, 11).setValues([
    ['此表僅供查詢，請不要直接修改。新增到 02，修改/取消/延時到 03。', '', '', '', '', '', '', '', '', '', ''],
    ['查看月份', '全部', '', '查看狀態', '全部', '', '', '', '', '', ''],
    ['預約編號', '狀態', '服務日期', '開始時間', '結束時間', '美甲師', '服務', '客人姓名', '電話', '來源', '備註'],
  ]);
  sheet.getRange('A1:K1').merge().setFontColor('#b91c1c').setFontWeight('bold').setBackground('#fee2e2');
  sheet.getRange('A3:K3').setBackground('#111827').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(3);
  sheet.setColumnWidths(1, 11, 125);
}

function setupBookings_(ss, withDemo) {
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.clear();
  ensureBookingDatabaseLayout_(ss);
  if (withDemo) {
    const today = new Date();
    [
      ['LINE', new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), '10:00', 'Amy', '單色凝膠', '王小美', '0912345678', 'Udemo001', '王小美', 'Demo 預約'],
      ['現場', new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2), '13:30', 'Bella', '延甲', '現場客', '', '', '', 'Demo 現場'],
      ['LINE', new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3), '15:00', 'Amy', '手部保養', '林小姐', '0922222222', 'Udemo002', '林小姐', 'Demo LINE'],
    ].forEach((item) => sheet.appendRow(makeBookingRow_(...item)));
  }
  sheet.getRange('K3:K5000').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('L3:M5000').setNumberFormat('hh:mm');
  sheet.getRange('D3:D5000').setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('P3:P5000').setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('S3:T5000').setNumberFormat('yyyy-mm-dd hh:mm');
}

function ensureBookingDatabaseLayout_(ss) {
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange('A1:T1').breakApart();
  sheet.getRange(1, 1, 2, 20).setValues([
    ['此表為系統資料庫，請不要直接修改。新增請到 02，修改/取消/延時請到 03。', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['預約編號', '狀態', '來源', '建立時間', '客人姓名', '電話', 'LINE userId', 'LINE 顯示名稱', '美甲師', '服務', '服務日期', '開始時間', '結束時間', '服務分鐘', '備註', '完成確認時間', '付款狀態', '實收金額', '更新時間', '取消時間'],
  ]);
  sheet.getRange('A1:T1').merge().setFontColor('#b91c1c').setFontWeight('bold').setBackground('#fee2e2');
  sheet.getRange('A2:T2').setBackground('#111827').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(2);
  sheet.setColumnWidths(1, 20, 125);
}

function setupCustomers_(ss) {
  const sheet = ss.getSheetByName(SHEETS.customers);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 1, 14).setValues([[
    '客戶編號', '姓名', '電話', 'LINE userId', 'LINE 顯示名稱', '生日月份', '首次預約日期', '最近預約日期',
    '總預約次數', '取消次數', '偏好美甲師', '常做服務', '備註', '黑名單/注意事項',
  ]]);
  sheet.getRange('A1:N1').setBackground('#111827').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 14, 125);
}

function setupServices_(ss) {
  const sheet = ss.getSheetByName(SHEETS.services);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 8, 6).setValues([
    ['服務名稱', '服務分鐘', '價格', 'LINE是否開放', '店家可用', '說明'],
    ['單色凝膠', 90, 1200, '是', '是', '簡約乾淨，適合第一次體驗'],
    ['設計款凝膠', 120, 1800, '是', '是', '暈染、跳色、簡單飾品'],
    ['卸甲', 30, 500, '是', '是', '本店或他店卸甲'],
    ['延甲', 150, 2200, '是', '是', '增加長度或調整甲型'],
    ['手部保養', 60, 800, '是', '是', '修型、甘皮處理、基礎護理'],
    ['款式諮詢/簡易服務', 60, 0, '是', '是', '還不知道款式時先預約諮詢'],
    ['延時/縮時', 30, 0, '否', '是', '內部使用，請優先在店家 LINE 或 03 修改預約使用調整時間'],
  ]);
  styleTable_(sheet);
}

function setupArtists_(ss) {
  const sheet = ss.getSheetByName(SHEETS.artists);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 5, 4).setValues([
    ['美甲師', '接單狀態', '推薦順序', '備註'],
    ['Amy', '可接單', 1, '簡約、氣質、法式'],
    ['Bella', '可接單', 2, '暈染、延甲、華麗款'],
    ['', '', '', ''],
    ['', '', '', ''],
  ]);
  styleTable_(sheet);
}

function setupSpecialDays_(ss) {
  const sheet = ss.getSheetByName(SHEETS.special);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 5, 7).setValues([
    ['美甲師/全店', '日期', '類型', '開始時間', '結束時間', '備註', '是否啟用'],
    ['全店', '', '休假', '', '', '全店店休時填這裡', '停用'],
    ['Amy', '', '休假', '', '', '個人休假範例', '停用'],
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
  ]);
  sheet.getRange('B2:B500').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('D2:E500').setNumberFormat('hh:mm');
  styleTable_(sheet);
}

function setupFixedSchedule_(ss) {
  const sheet = ss.getSheetByName(SHEETS.fixed);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 1, 5).setValues([['美甲師', '星期', '是否上班', '開始時間', '結束時間']]);
  const rows = [];
  const artists = readArtists_(ss).map((artist) => artist.name).filter(Boolean);
  (artists.length ? artists : ['Amy', 'Bella']).forEach((artist) => {
    ['週一', '週二', '週三', '週四', '週五', '週六', '週日'].forEach((weekday) => {
      const works = weekday !== '週一';
      rows.push([artist, weekday, works ? '是' : '否', works ? '10:00' : '', works ? '20:00' : '']);
    });
  });
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  sheet.getRange('D2:E500').setNumberFormat('hh:mm');
  styleTable_(sheet);
}

function syncFixedScheduleArtists_(ss) {
  const sheet = ss.getSheetByName(SHEETS.fixed);
  if (!sheet) return;
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, 5).setValues([['美甲師', '星期', '是否上班', '開始時間', '結束時間']]);
  }
  const artists = readArtists_(ss).map((artist) => artist.name).filter(Boolean);
  const weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
  const existing = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 5).getValues();
  const keys = new Set(existing.filter((row) => row[0] && row[1]).map((row) => `${row[0]}|${row[1]}`));
  const rows = [];
  artists.forEach((artist) => {
    weekdays.forEach((weekday) => {
      const key = `${artist}|${weekday}`;
      if (keys.has(key)) return;
      const works = weekday !== '週一';
      rows.push([artist, weekday, works ? '是' : '否', works ? '10:00' : '', works ? '20:00' : '']);
    });
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    sheet.getRange('D2:E500').setNumberFormat('hh:mm');
    styleTable_(sheet);
  }
}

function setupSettings_(ss) {
  const sheet = ss.getSheetByName(SHEETS.settings);
  resetSheetForLayout_(sheet);
  const rows = getDefaultSettingRows_();
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  styleTable_(sheet);
}

function getDefaultSettingRows_() {
  return [
    ['設定鍵', '設定值', '說明'],
    ['shop_name', 'Demo 美甲工作室', '店名'],
    ['shop_address', '台北市信義區 Demo 路 1 號', '預約成功傳給客人'],
    ['shop_phone', '', '系統忙碌時提供給客人聯絡店家'],
    ['business_hours', '週二至週日 10:00-20:00，週一公休', '給 AI 回答用'],
    ['booking_days_ahead', 30, 'LINE 可查未來幾天'],
    ['min_hours_before_booking', 2, '最少提前幾小時預約'],
    ['slot_minutes', 30, '系統最小時段'],
    ['day_start_time', '10:00', '一週表顯示開始時間'],
    ['day_end_time', '21:00', '一週表顯示結束時間'],
    ['session_ttl_minutes', 10, 'LINE 對話記憶分鐘'],
    ['session_history_turns', 4, 'AI 判斷時參考最近幾輪對話'],
    ['show_artist_specialty_in_line', '否', 'LINE 美甲師選單是否顯示專長；否則只顯示名字'],
    ['notify_shop_enabled', '是', '是否啟用 LINE 店家通知總開關'],
    ['notify_new_booking', '是', 'LINE 新增預約成功時通知店家'],
    ['notify_cancel_booking', '是', 'LINE 取消預約成功時通知店家'],
    ['notify_reschedule_booking', '是', 'LINE 改時間成功時通知店家'],
    ['notify_pending_request', '是', 'AI 無法完整處理、多人或需店家回覆時通知店家'],
    ['api_token', '請改成一串自己看得懂但別人猜不到的密碼', 'Zeabur 呼叫 Apps Script Web App 用'],
    ['ai_system_prompt', '你是「約好 AI」的美甲預約助理，負責協助客人預約、取消預約、回答店家常見問題。', 'AI 角色設定'],
    ['ai_booking_rules', '每次只問一個問題；不重複詢問已提供資訊；建立或取消預約前一定要先確認；不要問「還有其他問題嗎」。', 'AI 對話規則'],
    ['ai_fallback_reply', '這個問題我幫您請店家確認。', 'AI 不確定時回覆'],
    ['faq_parking', '附近有收費停車場，步行約 3 分鐘。', '停車 FAQ'],
    ['faq_payment', '可使用現金、轉帳，其他付款方式請到店確認。', '付款 FAQ'],
    ['faq_late', '若會遲到，請提前通知店家，避免影響後續預約。', '遲到 FAQ'],
  ];
}

function ensureDefaultSettings_(ss) {
  const sheet = ss.getSheetByName(SHEETS.settings);
  if (!sheet || sheet.getLastRow() < 1) {
    setupSettings_(ss);
    return;
  }
  const rows = getDefaultSettingRows_();
  const existingKeys = new Set(sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues().flat().filter(Boolean));
  const missing = rows.slice(1).filter((row) => !existingKeys.has(row[0]));
  if (missing.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
    styleTable_(sheet);
  }
}

function setupSlots_(ss) {
  const sheet = ss.getSheetByName(SHEETS.slots);
  resetSheetForLayout_(sheet);
  sheet.getRange(1, 1, 1, 7).setValues([['日期', '時間', '美甲師', '狀態', '預約編號', '備註', '更新時間']]);
  styleTable_(sheet);
}

function setupOptions_(ss) {
  const sheet = ss.getSheetByName(SHEETS.options);
  resetSheetForLayout_(sheet);
  const rows = buildOptionRows_();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}

function handleWeekCommand_(sheet) {
  const command = String(sheet.getRange('B4').getValue() || '').trim();
  if (!command || command === '未執行') return;
  const ss = getAppSpreadsheet_();
  try {
    if (command === '更新預約畫面') {
      refreshSystemData(false);
      sheet.getRange('B5').setValue('執行成功：已更新預約畫面。');
    } else if (command === '標記完成') {
      const id = sheet.getRange('B3').getValue();
      markBookingCompleted_(ss, id);
      refreshSystemData(false);
      sheet.getRange('B5').setValue(`執行成功：已標記 ${shortBookingId_(id)}號完成。`);
    }
  } catch (error) {
    sheet.getRange('B5').setValue(`執行失敗：${error.message}`);
  } finally {
    sheet.getRange('B4').setValue('未執行');
  }
}

function handleAddCommand_(sheet) {
  const command = String(sheet.getRange('B12').getValue() || '').trim();
  if (!command || command === '未執行') return;
  const ss = getAppSpreadsheet_();
  try {
    if (command === '更新預約畫面') {
      refreshSystemData(false);
      sheet.getRange('B13').setValue('執行成功：已更新預約畫面。');
      return;
    }
    if (command !== '執行現場新增') throw new Error('請選擇「執行現場新增」。');
    const values = readAddForm_(sheet);
    const result = createManualBooking_(ss, values);
    refreshSystemData(false);
    sheet.getRange('B13').setValue(`執行成功：新增預約 ${shortBookingId_(result.bookingId)}號。`);
  } catch (error) {
    sheet.getRange('B13').setValue(`執行失敗：${error.message}`);
  } finally {
    sheet.getRange('B12').setValue('未執行');
    sheet.getRange('B7').setValue('否');
  }
}

function handleEditCommand_(sheet) {
  const command = String(sheet.getRange('B10').getValue() || '').trim();
  if (!command || command === '未執行') return;
  const ss = getAppSpreadsheet_();
  try {
    if (command === '更新預約畫面') {
      refreshSystemData(false);
      sheet.getRange('B11').setValue('執行成功：已更新預約畫面。');
      return;
    }
    const id = sheet.getRange('B2').getValue();
    if (command === '載入預約') {
      const found = resolveBookingRow_(ss, id);
      const booking = parseBookingRow_(found.values);
      fillEditCurrentBooking_(sheet, booking);
      sheet.getRange('B11').setValue(`已載入預約 ${shortBookingId_(booking.id)}號。`);
      return;
    }
    if (command === '修改預約' || command === '修改時間') {
      updateBookingTime_(ss, readEditForm_(sheet));
      refreshSystemData(false);
      sheet.getRange('B11').setValue('執行成功：已修改預約。');
      return;
    }
    if (command === '延長時間') {
      extendBooking_(ss, readEditForm_(sheet));
      refreshSystemData(false);
      sheet.getRange('B11').setValue('執行成功：已調整預約時間。');
      return;
    }
    if (command === '取消預約') {
      cancelManualBooking_(ss, id);
      refreshSystemData(false);
      sheet.getRange('B11').setValue(`執行成功：已取消 ${shortBookingId_(id)}號。`);
      return;
    }
    throw new Error('請選擇有效指令。');
  } catch (error) {
    sheet.getRange('B11').setValue(`執行失敗：${error.message}`);
  } finally {
    sheet.getRange('B10').setValue('未執行');
    sheet.getRange('B9').setValue('否');
  }
}

function readAddForm_(sheet) {
  return {
    artist: sheet.getRange('B2').getValue(),
    service: sheet.getRange('B3').getValue(),
    date: sheet.getRange('B4').getValue(),
    startTime: normalizeTimeText_(sheet.getRange('B5').getValue()),
    duration: Number(sheet.getRange('B6').getValue() || 0),
    allowSpecial: String(sheet.getRange('B7').getValue() || '否'),
    customer: sheet.getRange('B8').getValue(),
    phone: sheet.getRange('B9').getValue(),
    note: sheet.getRange('B10').getValue(),
  };
}

function readEditForm_(sheet) {
  return {
    id: sheet.getRange('B2').getValue(),
    newArtist: sheet.getRange('B4').getValue(),
    newService: sheet.getRange('B5').getValue(),
    newDate: sheet.getRange('B6').getValue(),
    newStartTime: normalizeTimeText_(sheet.getRange('B7').getValue()),
    extendMinutes: Number(sheet.getRange('B8').getValue() || 0),
    allowSpecial: String(sheet.getRange('B9').getValue() || '否'),
  };
}

function fillEditCurrentBooking_(sheet, booking) {
  sheet.getRange('B3').setValue(`${booking.id}｜${booking.status}｜${booking.date} ${booking.startTime}-${booking.endTime}｜${booking.artist}｜${booking.service}｜${booking.customer}`);
  sheet.getRange('B4').setValue(booking.artist);
  sheet.getRange('B5').setValue(booking.service);
  sheet.getRange('B6').setValue(booking.dateValue);
  sheet.getRange('B7').setValue(booking.startTime);
  sheet.getRange('B8').clearContent();
}

function createManualBooking_(ss, values) {
  if (!values.artist || !values.service || !values.date || !values.startTime) throw new Error('新增預約需要美甲師、服務、日期、開始時間。');
  if (values.phone && !isValidTaiwanMobile_(values.phone)) throw new Error('手機號碼格式不正確，請輸入 09 開頭的 10 碼手機號碼。');
  const service = findService_(ss, values.service, true);
  const start = timeToMinutes_(values.startTime);
  const duration = values.duration || service.duration;
  const end = start + duration;
  assertNoConflict_(ss, '', values.artist, values.date, start, end);
  const warnings = getExceptionWarnings_(ss, values.artist, values.date, start, end);
  assertSpecialAllowed_(warnings, values.allowSpecial);
  const id = nextBookingId_(ss, values.date);
  const now = new Date();
  const row = [
    id, '已確認', '現場', now, values.customer || '現場客', values.phone || '', '', '',
    values.artist, service.name, values.date, minutesToTime_(start), minutesToTime_(end),
    duration, buildNote_(values.note, warnings), '', '未收款', '', now, '',
  ];
  ss.getSheetByName(SHEETS.bookings).appendRow(row);
  rebuildCustomers_(ss);
  return { bookingId: id };
}

function updateBookingTime_(ss, values) {
  if (!values.id) throw new Error('請輸入預約編號。');
  const found = resolveBookingRow_(ss, values.id);
  const old = parseBookingRow_(found.values);
  const artist = values.newArtist || old.artist;
  const service = findService_(ss, values.newService || old.service, true);
  const date = values.newDate || old.dateValue;
  const startTime = values.newStartTime || old.startTime;
  if (!artist || !service || !date || !startTime) throw new Error('請至少載入預約，並確認美甲師、服務、日期與時間。');
  const activeArtist = readArtists_(ss).find((item) => item.name === artist && item.status === '可接單');
  if (!activeArtist) throw new Error('這位美甲師目前不可接單。');
  const start = timeToMinutes_(startTime);
  const end = start + service.duration;
  assertNoConflict_(ss, old.id, artist, date, start, end);
  const warnings = getExceptionWarnings_(ss, artist, date, start, end);
  assertSpecialAllowed_(warnings, values.allowSpecial);
  const sheet = ss.getSheetByName(SHEETS.bookings);
  const newId = bookingMonthPrefix_(old.id) === bookingMonthPrefix_(nextBookingId_(ss, date))
    ? old.id
    : nextBookingId_(ss, date);
  sheet.getRange(found.rowNumber, 1, 1, 20).setValues([[
    newId, '已確認', old.source, old.createdAt, old.customer, old.phone, old.lineUserId, old.lineDisplayName,
    artist, service.name, date, minutesToTime_(start), minutesToTime_(end),
    service.duration, buildNote_(old.note, warnings), '', old.paymentStatus, old.paidAmount, new Date(), '',
  ]]);
}

function extendBooking_(ss, values) {
  if (!values.id) throw new Error('請輸入預約編號。');
  if (!values.extendMinutes) throw new Error('請輸入調整分鐘。');
  const found = resolveBookingRow_(ss, values.id);
  const old = parseBookingRow_(found.values);
  const newDuration = old.duration + values.extendMinutes;
  const minDuration = Number(readSettings_(ss).slot_minutes || 30);
  if (newDuration < minDuration) throw new Error(`縮短後預約至少需要 ${minDuration} 分鐘。`);
  const newEnd = old.startMinutes + newDuration;
  assertNoConflict_(ss, old.id, old.artist, old.dateValue, old.startMinutes, newEnd);
  const warnings = getExceptionWarnings_(ss, old.artist, old.dateValue, old.startMinutes, newEnd);
  assertSpecialAllowed_(warnings, values.allowSpecial);
  ss.getSheetByName(SHEETS.bookings).getRange(found.rowNumber, 1, 1, 20).setValues([[
    old.id, '已確認', old.source, old.createdAt, old.customer, old.phone, old.lineUserId, old.lineDisplayName,
    old.artist, old.service, old.dateValue, old.startTime, minutesToTime_(newEnd),
    newDuration, buildNote_(old.note, warnings.concat([`${values.extendMinutes > 0 ? '延長' : '縮短'} ${Math.abs(values.extendMinutes)} 分鐘`])), '', old.paymentStatus, old.paidAmount, new Date(), '',
  ]]);
}

function cancelManualBooking_(ss, id) {
  const found = resolveBookingRow_(ss, id);
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 2).setValue('已取消');
  sheet.getRange(found.rowNumber, 19).setValue(new Date());
  sheet.getRange(found.rowNumber, 20).setValue(new Date());
  rebuildCustomers_(ss);
}

function markBookingCompleted_(ss, id) {
  const found = resolveBookingRow_(ss, id);
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 2).setValue('已完成');
  sheet.getRange(found.rowNumber, 16).setValue(new Date());
  sheet.getRange(found.rowNumber, 19).setValue(new Date());
  rebuildCustomers_(ss);
}

function createApiBooking_(ss, booking) {
  if (!booking.artist || !booking.service || !booking.date || !booking.time || !booking.customerName || !booking.phone) {
    throw new Error('預約資料不足');
  }
  if (!isValidTaiwanMobile_(booking.phone)) throw new Error('手機號碼格式不正確，請輸入 09 開頭的 10 碼手機號碼。');
  const service = findService_(ss, booking.service, false);
  const start = timeToMinutes_(booking.time);
  const end = start + service.duration;
  assertApiBookingFutureEnough_(ss, booking.date, start);
  assertNoConflict_(ss, '', booking.artist, booking.date, start, end);
  const id = nextBookingId_(ss, booking.date);
  const now = new Date();
  ss.getSheetByName(SHEETS.bookings).appendRow([
    id, '已確認', 'LINE', now, booking.customerName, booking.phone, booking.lineUserId || '', booking.lineDisplayName || '',
    booking.artist, service.name, new Date(booking.date), minutesToTime_(start), minutesToTime_(end),
    service.duration, booking.note || '', '', '未收款', '', now, '',
  ]);
  markBookedSlots_(ss, booking.artist, booking.date, start, end, id);
  SpreadsheetApp.flush();
  return {
    bookingId: id,
    customerName: booking.customerName,
    phone: booking.phone,
    service: service.name,
    artist: booking.artist,
    date: booking.date,
    time: minutesToTime_(start),
    end: minutesToTime_(end),
    duration: service.duration,
  };
}

function markBookedSlots_(ss, artist, dateValue, start, end, bookingId) {
  const sheet = ss.getSheetByName(SHEETS.slots);
  if (!sheet || sheet.getLastRow() < 2) return;
  const dateText = formatDate_(dateValue);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  const updates = [];
  values.forEach((row, index) => {
    const rowDate = formatMaybeDate_(row[0]);
    const rowTime = normalizeTimeText_(row[1]);
    const rowArtist = String(row[2] || '').trim();
    const minutes = timeToMinutes_(rowTime);
    if (rowDate === dateText && rowArtist === artist && minutes >= start && minutes < end) {
      updates.push(index + 2);
    }
  });
  updates.forEach((rowNumber) => {
    sheet.getRange(rowNumber, 4, 1, 4).setValues([['已預約', bookingId, '', new Date()]]);
  });
}

function getApiUserActiveBookings_(ss, userId) {
  const today = formatDate_(new Date());
  return readBookings_(ss)
    .filter((booking) => booking.lineUserId === userId && !['已取消', '已完成'].includes(booking.status) && booking.date >= today)
    .map((booking) => ({
      id: booking.id,
      status: booking.status,
      customer: booking.customer,
      phone: booking.phone,
      artist: booking.artist,
      service: booking.service,
      date: booking.date,
      start: booking.startTime,
      end: booking.endTime,
      duration: booking.duration,
      lineUserId: booking.lineUserId,
      lineDisplayName: booking.lineDisplayName,
    }));
}

function getApiCustomerProfile_(ss, userId) {
  if (!userId) return null;
  const customer = getCustomerProfileFromDatabase_(ss, userId);
  if (customer) return customer;
  const bookings = readBookings_(ss)
    .filter((booking) => booking.lineUserId === userId && (booking.customer || booking.phone))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.startMinutes - a.startMinutes);
  const latest = bookings[0];
  if (!latest) return null;
  return {
    customerName: latest.customer,
    phone: latest.phone,
    lineUserId: latest.lineUserId,
    lineDisplayName: latest.lineDisplayName,
  };
}

function getCustomerProfileFromDatabase_(ss, userId) {
  const sheet = ss.getSheetByName(SHEETS.customers);
  if (!sheet || !userId) return null;
  const rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 14).getValues();
  const row = rows.find((item) => item[3] === userId);
  if (!row) return null;
  if (!row[1] && !row[2]) return null;
  return {
    customerName: row[1] || '',
    phone: row[2] || '',
    lineUserId: row[3] || '',
    lineDisplayName: row[4] || '',
  };
}

function getStoreTodayBookings_(ss) {
  return getStoreBookingsByDate_(ss, formatDate_(new Date()));
}

function getStoreBookingsByDate_(ss, date) {
  const targetDate = formatMaybeDate_(date);
  if (!targetDate) throw new Error('請輸入查詢日期');
  return readBookings_(ss)
    .filter((booking) => booking.date === targetDate && !['已取消', '已完成'].includes(booking.status))
    .sort((a, b) => a.startMinutes - b.startMinutes || String(a.artist).localeCompare(String(b.artist)))
    .map(formatApiBooking_);
}

function getStoreBooking_(ss, bookingId) {
  const found = resolveBookingRow_(ss, bookingId);
  return formatApiBooking_(parseBookingRow_(found.values));
}

function getStoreBookingCandidates_(ss, bookingId) {
  return findBookingRowMatches_(ss, bookingId, '')
    .map((match) => formatApiBooking_(parseBookingRow_(match.values)));
}

function searchStoreCustomerBookings_(ss, query) {
  const keyword = String(query || '').trim();
  if (!keyword) throw new Error('請輸入客人姓名或手機。');
  const phone = normalizeTaiwanMobile_(keyword);
  const normalized = keyword.replace(/\s+/g, '');
  return readBookings_(ss)
    .filter((booking) => {
      if (phone && normalizeTaiwanMobile_(booking.phone) === phone) return true;
      return String(booking.customer || '').replace(/\s+/g, '').includes(normalized);
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.startMinutes - a.startMinutes)
    .slice(0, 12)
    .map(formatApiBooking_);
}

function formatApiBooking_(booking) {
  return {
    id: booking.id,
    status: booking.status,
    customer: booking.customer,
    phone: booking.phone,
    artist: booking.artist,
    service: booking.service,
    date: booking.date,
    start: booking.startTime,
    end: booking.endTime,
    duration: booking.duration,
    lineUserId: booking.lineUserId,
    lineDisplayName: booking.lineDisplayName,
  };
}

function storeCreateBooking_(ss, booking) {
  if (!booking.artist || !booking.service || !booking.date || !booking.time) throw new Error('新增預約資料不足');
  if (booking.phone && !isValidTaiwanMobile_(booking.phone)) throw new Error('手機號碼格式不正確，請輸入 09 開頭的 10 碼手機號碼。');
  const service = findService_(ss, booking.service, true);
  const start = timeToMinutes_(booking.time);
  const end = start + service.duration;
  assertApiBookingFutureEnough_(ss, booking.date, start);
  assertNoConflict_(ss, '', booking.artist, booking.date, start, end);
  const warnings = getExceptionWarnings_(ss, booking.artist, booking.date, start, end);
  assertSpecialAllowed_(warnings, '否');
  const id = nextBookingId_(ss, booking.date);
  const now = new Date();
  const customerName = booking.customerName || '現場客';
  const phone = booking.phone ? normalizeTaiwanMobile_(booking.phone) : '';
  ss.getSheetByName(SHEETS.bookings).appendRow([
    id, '已確認', '店家LINE', now, customerName, phone, booking.lineUserId || '', booking.lineDisplayName || '',
    booking.artist, service.name, new Date(booking.date), minutesToTime_(start), minutesToTime_(end),
    service.duration, buildNote_(booking.note || '', warnings), '', '未收款', '', now, '',
  ]);
  markBookedSlots_(ss, booking.artist, booking.date, start, end, id);
  refreshApiBookingData_(ss);
  SpreadsheetApp.flush();
  return {
    bookingId: id,
    customerName,
    phone,
    service: service.name,
    artist: booking.artist,
    date: booking.date,
    time: minutesToTime_(start),
    end: minutesToTime_(end),
    duration: service.duration,
  };
}

function updateApiBooking_(ss, userId, booking) {
  if (!booking.bookingId) throw new Error('缺少預約編號');
  if (!booking.artist || !booking.service || !booking.date || !booking.time) throw new Error('修改資料不足');
  const found = resolveBookingRow_(ss, booking.bookingId, userId);
  const old = parseBookingRow_(found.values);
  if (['已取消', '已完成'].includes(old.status)) throw new Error('這筆預約目前不可修改');
  const service = findService_(ss, booking.service, false);
  const artist = readArtists_(ss).find((item) => item.name === booking.artist && item.status === '可接單');
  if (!artist) throw new Error('這位美甲師目前不可接單');
  const start = timeToMinutes_(booking.time);
  const end = start + service.duration;
  assertApiBookingFutureEnough_(ss, booking.date, start);
  assertNoConflict_(ss, old.id, booking.artist, booking.date, start, end);
  const warnings = getExceptionWarnings_(ss, booking.artist, booking.date, start, end);
  assertSpecialAllowed_(warnings, '否');
  const newId = bookingMonthPrefix_(old.id) === bookingMonthPrefix_(nextBookingId_(ss, booking.date))
    ? old.id
    : nextBookingId_(ss, booking.date);
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 1, 1, 20).setValues([[
    newId, '已確認', old.source, old.createdAt, old.customer, old.phone, old.lineUserId, old.lineDisplayName,
    booking.artist, service.name, new Date(booking.date), minutesToTime_(start), minutesToTime_(end),
    service.duration, buildNote_(old.note, warnings), '', old.paymentStatus, old.paidAmount, new Date(), '',
  ]]);
  refreshApiBookingData_(ss);
  return {
    bookingId: newId,
    customerName: old.customer,
    phone: old.phone,
    service: service.name,
    artist: booking.artist,
    date: booking.date,
    time: minutesToTime_(start),
    end: minutesToTime_(end),
    duration: service.duration,
  };
}

function storeUpdateBooking_(ss, booking) {
  if (!booking.bookingId) throw new Error('缺少預約編號');
  if (!booking.artist || !booking.service || !booking.date || !booking.time) throw new Error('修改資料不足');
  const found = resolveBookingRow_(ss, booking.bookingId);
  const old = parseBookingRow_(found.values);
  if (['已取消', '已完成'].includes(old.status)) throw new Error('這筆預約目前不可修改');
  const service = findService_(ss, booking.service, true);
  const artist = readArtists_(ss).find((item) => item.name === booking.artist && item.status === '可接單');
  if (!artist) throw new Error('這位美甲師目前不可接單');
  const start = timeToMinutes_(booking.time);
  const end = start + service.duration;
  assertApiBookingFutureEnough_(ss, booking.date, start);
  assertNoConflict_(ss, old.id, booking.artist, booking.date, start, end);
  const warnings = getExceptionWarnings_(ss, booking.artist, booking.date, start, end);
  assertSpecialAllowed_(warnings, '否');
  const newId = bookingMonthPrefix_(old.id) === bookingMonthPrefix_(nextBookingId_(ss, booking.date))
    ? old.id
    : nextBookingId_(ss, booking.date);
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 1, 1, 20).setValues([[
    newId, '已確認', old.source, old.createdAt, old.customer, old.phone, old.lineUserId, old.lineDisplayName,
    booking.artist, service.name, new Date(booking.date), minutesToTime_(start), minutesToTime_(end),
    service.duration, buildNote_(old.note, warnings), '', old.paymentStatus, old.paidAmount, new Date(), '',
  ]]);
  refreshApiBookingData_(ss);
  return {
    bookingId: newId,
    customerName: old.customer,
    phone: old.phone,
    service: service.name,
    artist: booking.artist,
    date: booking.date,
    time: minutesToTime_(start),
    end: minutesToTime_(end),
    duration: service.duration,
  };
}

function storeExtendBooking_(ss, bookingId, extraMinutes) {
  const minutes = Number(extraMinutes || 0);
  if (!minutes) throw new Error('請輸入要調整的分鐘數。');
  const found = resolveBookingRow_(ss, bookingId);
  const old = parseBookingRow_(found.values);
  if (['已取消', '已完成'].includes(old.status)) throw new Error('這筆預約目前不可調整時間');
  const newEnd = old.endMinutes + minutes;
  const minDuration = Number(readSettings_(ss).slot_minutes || 30);
  if (newEnd - old.startMinutes < minDuration) throw new Error(`縮短後預約至少需要 ${minDuration} 分鐘。`);
  assertNoConflict_(ss, old.id, old.artist, old.date, old.startMinutes, newEnd);
  const warnings = getExceptionWarnings_(ss, old.artist, old.date, old.startMinutes, newEnd);
  assertSpecialAllowed_(warnings, '否');
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 13).setValue(minutesToTime_(newEnd));
  sheet.getRange(found.rowNumber, 14).setValue(newEnd - old.startMinutes);
  sheet.getRange(found.rowNumber, 15).setValue(buildNote_(old.note, warnings.concat([`${minutes > 0 ? '延長' : '縮短'} ${Math.abs(minutes)} 分鐘`])));
  sheet.getRange(found.rowNumber, 19).setValue(new Date());
  refreshApiBookingData_(ss);
  return {
    bookingId: old.id,
    customerName: old.customer,
    phone: old.phone,
    service: old.service,
    artist: old.artist,
    date: old.date,
    time: old.startTime,
    end: minutesToTime_(newEnd),
    duration: newEnd - old.startMinutes,
  };
}

function cancelApiBooking_(ss, userId, bookingId) {
  const found = resolveBookingRow_(ss, bookingId, userId);
  const booking = parseBookingRow_(found.values);
  if (booking.status === '已取消') return { bookingId: booking.id, status: '已取消' };
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 2).setValue('已取消');
  sheet.getRange(found.rowNumber, 19).setValue(new Date());
  sheet.getRange(found.rowNumber, 20).setValue(new Date());
  refreshApiBookingData_(ss);
  return { bookingId: booking.id, status: '已取消' };
}

function storeCancelBooking_(ss, bookingId) {
  const found = resolveBookingRow_(ss, bookingId);
  const booking = parseBookingRow_(found.values);
  if (booking.status === '已取消') return { bookingId: booking.id, status: '已取消' };
  const sheet = ss.getSheetByName(SHEETS.bookings);
  sheet.getRange(found.rowNumber, 2).setValue('已取消');
  sheet.getRange(found.rowNumber, 19).setValue(new Date());
  sheet.getRange(found.rowNumber, 20).setValue(new Date());
  refreshApiBookingData_(ss);
  return { bookingId: booking.id, status: '已取消' };
}

function getApiConfig_(ss) {
  const settings = readSettings_(ss);
  return {
    settings,
    services: readServices_(ss).filter((service) => service.lineOpen),
    artists: readArtists_(ss).filter((artist) => artist.status === '可接單'),
    specials: readSpecialDays_(ss),
    slots: readSlots_(ss),
  };
}

function rebuildAvailableSlots_(ss) {
  const settings = readSettings_(ss);
  const artists = readArtists_(ss).filter((artist) => artist.status === '可接單').map((artist) => artist.name);
  const fixed = readFixedSchedule_(ss);
  const specials = readSpecialDays_(ss);
  const bookings = readBookings_(ss).filter((booking) => booking.status !== '已取消');
  const daysAhead = Number(settings.booking_days_ahead || 30);
  const slotMinutes = Number(settings.slot_minutes || 30);
  const today = new Date();
  const rows = [];

  for (let offset = 0; offset <= daysAhead; offset += 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const dateText = formatDate_(date);
    const weekday = getWeekday_(date);
    artists.forEach((artist) => {
      const work = fixed.find((item) => item.artist === artist && item.weekday === weekday && item.enabled === '是');
      const ranges = [];
      if (work) ranges.push({ start: work.start, end: work.end });
      specials.filter((item) => item.artist === artist && item.date === dateText && item.type === '加開')
        .forEach((item) => ranges.push({ start: item.start, end: item.end }));

      ranges.forEach((range) => {
        for (let minutes = range.start; minutes < range.end; minutes += slotMinutes) {
          const special = findSpecial_(specials, artist, dateText, minutes, slotMinutes);
          if (special && special.type === '休假') continue;
          const booking = findBookingAt_(bookings, artist, dateText, minutes);
          rows.push([date, minutesToTime_(minutes), artist, booking ? '已預約' : '可預約', booking ? booking.id : '', special ? special.note : '', new Date()]);
        }
      });
    });
  }

  setupSlots_(ss);
  const sheet = ss.getSheetByName(SHEETS.slots);
  if (rows.length) sheet.getRange(2, 1, rows.length, 7).setValues(rows);
  sheet.getRange('A2:A5000').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('B2:B5000').setNumberFormat('hh:mm');
  styleSlotStatus_(sheet);
}

function buildWeekView_(ss) {
  const sheet = ss.getSheetByName(SHEETS.week);
  const weekStart = getSelectedWeekStart_(sheet.getRange('B2').getValue());
  const settings = readSettings_(ss);
  const bookings = readBookings_(ss).filter((booking) => booking.status !== '已取消');
  const fixed = readFixedSchedule_(ss);
  const specials = readSpecialDays_(ss);
  const slotMinutes = Number(settings.slot_minutes || 30);
  const dayStart = timeToMinutes_(settings.day_start_time || '10:00');
  const dayEnd = timeToMinutes_(settings.day_end_time || '21:00');
  const days = Array.from({ length: 7 }, (_v, i) => addDays_(weekStart, i));
  const weekDates = new Set(days.map((date) => formatDate_(date)));
  const artistMap = new Map();
  readArtists_(ss)
    .filter((artist) => artist.status === '可接單')
    .forEach((artist) => artistMap.set(artist.name, artist));
  bookings
    .filter((booking) => weekDates.has(booking.date) && booking.artist)
    .forEach((booking) => {
      if (!artistMap.has(booking.artist)) {
        artistMap.set(booking.artist, { name: booking.artist, status: '預約中', sort: 999, note: '' });
      }
    });
  const artists = [...artistMap.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  sheet.getRange('A3:H500').clearContent().clearFormat().clearDataValidations();
  let row = 3;
  const statusRanges = [];
  sheet.getRange(row, 1, 1, 8).setValues([['時間', ...days.map((date) => `${getWeekday_(date)}\n${formatDate_(date)}`)]]);
  styleHeader_(sheet.getRange(row, 1, 1, 8));
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(1);
  row += 1;

  artists.forEach((artist, artistIndex) => {
    sheet.getRange(row, 1, 1, 8).setValues([[`${artist.name} 一週預約`, '', '', '', '', '', '', '']]);
    styleBand_(sheet.getRange(row, 1, 1, 8), artistBandColor_(artistIndex));
    row += 1;

    const rows = [];
    for (let minutes = dayStart; minutes < dayEnd; minutes += slotMinutes) {
      const line = [minutesToTime_(minutes)];
      days.forEach((date) => {
        const dateText = formatDate_(date);
        const booking = findBookingAt_(bookings, artist.name, dateText, minutes);
        if (booking) {
          line.push(minutes === booking.startMinutes
            ? `${shortBookingId_(booking.id)}號｜${booking.status}｜${booking.startTime}-${booking.endTime}\n${booking.service}｜${booking.customer}`
            : `${booking.status}\n${booking.customer}`);
        } else if (isWorkingSlot_(fixed, specials, artist.name, date, minutes, slotMinutes)) {
          line.push('可約');
        } else {
          line.push('休假');
        }
      });
      rows.push(line);
    }
    sheet.getRange(row, 1, rows.length, 8).setValues(rows);
    styleWeekStatus_(sheet, row, rows.length, statusRanges);
    row += rows.length + 2;
  });
  applyWeekStatusRules_(sheet, statusRanges);
}

function buildBookingQuery_(ss) {
  const sheet = ss.getSheetByName(SHEETS.query);
  const month = String(sheet.getRange('B2').getValue() || '全部');
  const status = String(sheet.getRange('E2').getValue() || '全部');
  const rows = readBookings_(ss)
    .filter((booking) => month === '全部' || `${new Date(booking.dateValue).getMonth() + 1}月` === month)
    .filter((booking) => status === '全部' || booking.status === status)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes || a.artist.localeCompare(b.artist))
    .map((booking) => [
      booking.id, booking.status, booking.dateValue, booking.startTime, booking.endTime, booking.artist,
      booking.service, booking.customer, booking.phone, booking.source, booking.note,
    ]);
  sheet.getRange('A4:K5000').clearContent();
  if (rows.length) sheet.getRange(4, 1, rows.length, 11).setValues(rows);
  sheet.getRange('C4:C5000').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('D4:E5000').setNumberFormat('hh:mm');
  sheet.getRange('I4:I5000').setNumberFormat('@');
  applyBookingStatusRowRules_(ss);
}

function rebuildCustomers_(ss) {
  const sheet = ss.getSheetByName(SHEETS.customers);
  const oldRows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 14).getValues();
  const oldByKey = new Map(oldRows.filter((row) => row[0]).map((row) => [row[3] || row[2] || row[0], row]));
  const groups = new Map();
  readBookings_(ss).forEach((booking) => {
    const key = booking.lineUserId || booking.phone || booking.customer;
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(booking);
  });
  const rows = Array.from(groups.entries()).map(([key, bookings], index) => {
    bookings.sort((a, b) => a.date.localeCompare(b.date));
    const latest = bookings[bookings.length - 1];
    const old = oldByKey.get(key) || [];
    const active = bookings.filter((booking) => booking.status !== '已取消');
    return [
      old[0] || `C${String(index + 1).padStart(4, '0')}`,
      old[1] || latest.customer,
      old[2] || latest.phone,
      latest.lineUserId,
      latest.lineDisplayName,
      old[5] || '未填',
      bookings[0].dateValue,
      latest.dateValue,
      active.length,
      bookings.filter((booking) => booking.status === '已取消').length,
      mode_(active.map((booking) => booking.artist)),
      mode_(active.map((booking) => booking.service)),
      old[12] || '',
      old[13] || '',
    ];
  });
  setupCustomers_(ss);
  sheet.getRange('C2:C5000').setNumberFormat('@');
  if (rows.length) sheet.getRange(2, 1, rows.length, 14).setValues(rows);
}

function readBookings_(ss) {
  const sheet = ss.getSheetByName(SHEETS.bookings);
  const rows = sheet.getRange(3, 1, Math.max(sheet.getLastRow() - 2, 1), 20).getValues();
  return rows.filter((row) => row[0]).map(parseBookingRow_);
}

function parseBookingRow_(row) {
  const start = timeToMinutes_(row[11]);
  const end = row[12] ? timeToMinutes_(row[12]) : start + Number(row[13] || 30);
  const completedAt = row[15] instanceof Date ? row[15] : null;
  let effectiveEnd = end;
  if (row[1] === '已完成' && completedAt && formatDate_(completedAt) === formatMaybeDate_(row[10])) {
    effectiveEnd = Math.min(end, completedAt.getHours() * 60 + completedAt.getMinutes());
  }
  return {
    id: row[0],
    status: row[1],
    source: row[2],
    createdAt: row[3],
    customer: row[4] || '現場客',
    phone: normalizeTaiwanMobile_(row[5]),
    lineUserId: row[6] || '',
    lineDisplayName: row[7] || '',
    artist: row[8],
    service: row[9],
    dateValue: row[10],
    date: formatMaybeDate_(row[10]),
    startTime: normalizeTimeText_(row[11]),
    endTime: normalizeTimeText_(row[12]),
    startMinutes: start,
    endMinutes: end,
    effectiveEndMinutes: effectiveEnd,
    duration: Number(row[13] || (end - start)),
    note: row[14] || '',
    completedAt,
    paymentStatus: row[16] || '',
    paidAmount: row[17] || '',
  };
}

function isValidTaiwanMobile_(phone) {
  return /^09\d{8}$/.test(normalizeTaiwanMobile_(phone));
}

function normalizeTaiwanMobile_(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^09\d{8}$/.test(digits)) return digits;
  if (/^9\d{8}$/.test(digits)) return `0${digits}`;
  return String(phone || '').trim();
}

function findBookingAt_(bookings, artist, dateText, minutes) {
  return bookings.find((booking) => (
    booking.artist === artist
    && booking.date === dateText
    && minutes >= booking.startMinutes
    && minutes < booking.effectiveEndMinutes
  ));
}

function resolveBookingRow_(ss, id, userId) {
  const input = String(id || '').trim();
  if (!input) throw new Error('請輸入預約編號。');
  const matches = findBookingRowMatches_(ss, input, userId);
  if (!matches.length) throw new Error(`找不到預約編號 ${input}`);
  if (matches.length > 1) {
    const options = matches.map((match) => {
      const b = parseBookingRow_(match.values);
      return `${b.id}｜${b.date} ${b.startTime}｜${b.artist}｜${b.service}`;
    }).join('\n');
    throw new Error(`找到多筆短編號 ${input}，請輸入完整預約編號：\n${options}`);
  }
  return matches[0];
}

function findBookingRowMatches_(ss, id, userId) {
  const input = String(id || '').trim();
  if (!input) return [];
  const rows = ss.getSheetByName(SHEETS.bookings).getRange('A3:T5000').getValues();
  const matches = [];
  rows.forEach((row, index) => {
    if (!row[0]) return;
    if (userId && row[6] !== userId) return;
    if (bookingIdMatches_(row[0], input)) matches.push({ rowNumber: index + 3, values: row });
  });
  return matches;
}

function assertNoConflict_(ss, ignoreId, artist, dateValue, start, end) {
  const dateText = formatMaybeDate_(dateValue);
  const conflicts = readBookings_(ss).filter((booking) => {
    if (booking.status === '已取消') return false;
    if (String(booking.id) === String(ignoreId)) return false;
    if (booking.artist !== artist || booking.date !== dateText) return false;
    return start < booking.effectiveEndMinutes && end > booking.startMinutes;
  });
  if (conflicts.length) {
    const b = conflicts[0];
    throw new Error(`${artist} ${dateText} ${minutesToTime_(start)}-${minutesToTime_(end)} 會撞到 ${b.id} ${b.customer} ${b.service}`);
  }
}

function assertApiBookingFutureEnough_(ss, dateValue, start) {
  const date = toDate_(dateValue);
  if (!date) throw new Error('預約日期格式不正確');
  const settings = readSettings_(ss);
  const minHours = Number(settings.min_hours_before_booking || 0);
  const startAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(start / 60), start % 60, 0);
  const earliest = new Date(Date.now() + minHours * 60 * 60 * 1000);
  if (startAt.getTime() <= earliest.getTime()) {
    throw new Error(`這個時間已過或太接近現在，店家最少需要提前 ${minHours} 小時預約。`);
  }
}

function getExceptionWarnings_(ss, artist, dateValue, start, end) {
  const date = toDate_(dateValue);
  const dateText = formatMaybeDate_(dateValue);
  const warnings = [];
  if (date) {
    const startAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(start / 60), start % 60, 0);
    if (startAt.getTime() < Date.now()) warnings.push('這筆預約時間已經過去');
  }
  const weekday = getWeekday_(date || new Date(dateText));
  const fixed = readFixedSchedule_(ss).filter((item) => item.artist === artist && item.weekday === weekday && item.enabled === '是');
  const specials = readSpecialDays_(ss).filter((item) => item.date === dateText && (item.artist === artist || item.artist === '全店'));
  const holiday = specials.find((item) => item.type === '休假' && start < item.end && end > item.start);
  if (holiday) warnings.push(holiday.artist === '全店' ? '全店休假' : `${artist} 休假`);
  const ranges = fixed.map((item) => ({ start: item.start, end: item.end }))
    .concat(specials.filter((item) => item.type === '加開' && item.artist === artist).map((item) => ({ start: item.start, end: item.end })));
  if (!ranges.some((range) => start >= range.start && end <= range.end)) warnings.push('不在一般營業/上班時間內');
  return [...new Set(warnings)];
}

function assertSpecialAllowed_(warnings, allowSpecial) {
  if (!warnings.length || allowSpecial === '是') return;
  throw new Error(`提醒：這筆預約有以下例外情況：${warnings.join('、')}。若確定仍要執行，請將「允許特殊時段」改成「是」，再執行一次。`);
}

function readServices_(ss) {
  return ss.getSheetByName(SHEETS.services).getRange('A2:F500').getValues()
    .filter((row) => row[0])
    .map((row) => ({
      name: row[0],
      duration: Number(row[1] || 30),
      price: Number(row[2] || 0),
      lineOpen: row[3] === '是',
      storeOpen: row[4] !== '否',
      description: row[5] || '',
    }));
}

function findService_(ss, name, storeSide) {
  const service = readServices_(ss).find((item) => item.name === name);
  if (!service) throw new Error('找不到服務，請先到 07 服務設定新增。');
  if (storeSide && !service.storeOpen) throw new Error('這個服務未開放店家端使用。');
  if (!storeSide && !service.lineOpen) throw new Error('這個服務未開放 LINE 預約。');
  return service;
}

function readArtists_(ss) {
  return ss.getSheetByName(SHEETS.artists).getRange('A2:D200').getValues()
    .filter((row) => row[0])
    .map((row) => ({ name: row[0], status: row[1], sort: Number(row[2] || 999), note: row[3] || '' }))
    .sort((a, b) => a.sort - b.sort);
}

function readFixedSchedule_(ss) {
  return ss.getSheetByName(SHEETS.fixed).getRange('A2:E500').getValues()
    .filter((row) => row[0] && row[1])
    .map((row) => ({ artist: row[0], weekday: row[1], enabled: row[2], start: timeToMinutes_(row[3]), end: timeToMinutes_(row[4]) }));
}

function readSpecialDays_(ss) {
  return ss.getSheetByName(SHEETS.special).getRange('A2:G500').getValues()
    .filter((row) => row[0] && row[1] && row[2] && row[6] !== '停用')
    .map((row) => ({
      artist: row[0],
      date: formatMaybeDate_(row[1]),
      type: row[2],
      start: row[3] ? timeToMinutes_(row[3]) : 0,
      end: row[4] ? timeToMinutes_(row[4]) : 24 * 60,
      note: row[5] || '',
    }));
}

function readSettings_(ss) {
  const rows = ss.getSheetByName(SHEETS.settings).getRange('A2:B200').getValues();
  return Object.fromEntries(rows.filter((row) => row[0]).map((row) => [row[0], row[1]]));
}

function readSlots_(ss) {
  const sheet = ss.getSheetByName(SHEETS.slots);
  const rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 7).getValues();
  return rows.filter((row) => row[0] && row[2]).map((row) => ({
    date: formatMaybeDate_(row[0]),
    time: normalizeTimeText_(row[1]),
    artist: row[2],
    status: row[3],
    lockedBookingId: row[4] || '',
    note: row[5] || '',
  }));
}

function isWorkingSlot_(fixed, specials, artist, date, minutes, slotMinutes) {
  const dateText = formatDate_(date);
  const weekday = getWeekday_(date);
  const work = fixed.find((item) => item.artist === artist && item.weekday === weekday && item.enabled === '是' && minutes >= item.start && minutes < item.end);
  const special = findSpecial_(specials, artist, dateText, minutes, slotMinutes);
  if (special && special.type === '休假') return false;
  if (special && special.type === '加開') return true;
  return Boolean(work);
}

function findSpecial_(specials, artist, dateText, minutes, slotMinutes) {
  const end = minutes + slotMinutes;
  const matches = specials.filter((item) => (item.artist === artist || item.artist === '全店') && item.date === dateText && minutes < item.end && end > item.start);
  return matches.find((item) => item.type === '加開' && item.artist === artist) || matches.find((item) => item.type === '休假') || null;
}

function makeBookingRow_(source, date, startTime, artist, serviceName, customer, phone, lineUserId, lineName, note) {
  const ss = getAppSpreadsheet_();
  const service = readServices_(ss).find((item) => item.name === serviceName) || { duration: 60 };
  const start = timeToMinutes_(startTime);
  const id = nextBookingId_(ss, date);
  const now = new Date();
  return [
    id, '已確認', source, now, customer, phone, lineUserId, lineName, artist, serviceName, date,
    minutesToTime_(start), minutesToTime_(start + service.duration), service.duration, note, '', '未收款', '', now, '',
  ];
}

function nextBookingId_(ss, serviceDate) {
  const prefix = Utilities.formatDate(new Date(serviceDate), Session.getScriptTimeZone(), 'yyyyMM');
  const next = readBookings_(ss).reduce((max, booking) => {
    const text = String(booking.id || '');
    if (!text.startsWith(`${prefix}-`)) return max;
    return Math.max(max, Number(text.split('-').pop() || 0));
  }, 0) + 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

function bookingIdMatches_(fullId, input) {
  const full = String(fullId || '').trim();
  const raw = String(input || '').trim().replace('預約編號', '').replace('編號', '').replace('號', '');
  if (!full || !raw) return false;
  if (full === raw) return true;
  return shortBookingId_(full) === raw.padStart(3, '0');
}

function shortBookingId_(id) {
  const text = String(id || '');
  return text.includes('-') ? text.split('-').pop() : text.padStart(3, '0');
}

function bookingMonthPrefix_(id) {
  return String(id || '').split('-')[0] || '';
}

function buildNote_(note, warnings) {
  const parts = [];
  if (warnings.length) parts.push(`特殊預約：${warnings.join('、')}`);
  if (note) parts.push(note);
  return parts.join('｜');
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function refreshDropdowns_() {
  const ss = getAppSpreadsheet_();
  const optionSheet = ss.getSheetByName(SHEETS.options);
  const artistNames = readArtists_(ss).map((artist) => artist.name).filter(Boolean);
  optionSheet.getRange('O1:O200').clearContent();
  optionSheet.getRange(1, 15, artistNames.length + 2, 1).setValues([['美甲師/全店'], ['全店'], ...artistNames.map((name) => [name])]);

  createNamedRange_(ss, '週別選項', SHEETS.options, 'A2:A20');
  createNamedRange_(ss, '完成指令選項', SHEETS.options, 'B2:B20');
  createNamedRange_(ss, '新增指令選項', SHEETS.options, 'C2:C20');
  createNamedRange_(ss, '修改指令選項', SHEETS.options, 'D2:D20');
  createNamedRange_(ss, '是否選項', SHEETS.options, 'E2:E20');
  createNamedRange_(ss, '時間選項', SHEETS.options, 'F2:F80');
  createNamedRange_(ss, '延時選項', SHEETS.options, 'G2:G20');
  createNamedRange_(ss, '月份選項', SHEETS.options, 'H2:H20');
  createNamedRange_(ss, '狀態查詢選項', SHEETS.options, 'I2:I20');
  createNamedRange_(ss, '生日月份選項', SHEETS.options, 'J2:J20');
  createNamedRange_(ss, '接單狀態選項', SHEETS.options, 'K2:K20');
  createNamedRange_(ss, '特殊類型選項', SHEETS.options, 'L2:L20');
  createNamedRange_(ss, '啟用選項', SHEETS.options, 'M2:M20');
  createNamedRange_(ss, '星期選項', SHEETS.options, 'N2:N20');
  createNamedRange_(ss, '美甲師選項', SHEETS.artists, 'A2:A200');
  createNamedRange_(ss, '美甲師全店選項', SHEETS.options, 'O2:O200');
  createNamedRange_(ss, '服務選項', SHEETS.services, 'A2:A500');

  applyValidation_(ss, SHEETS.week, 'B2', '週別選項');
  applyValidation_(ss, SHEETS.add, 'B2', '美甲師選項');
  applyValidation_(ss, SHEETS.add, 'B3', '服務選項');
  applyDateValidation_(ss, SHEETS.add, 'B4');
  applyValidation_(ss, SHEETS.add, 'B5', '時間選項');
  applyValidation_(ss, SHEETS.add, 'B7', '是否選項');
  applyValidation_(ss, SHEETS.add, 'B12', '新增指令選項');
  applyValidation_(ss, SHEETS.edit, 'B4', '美甲師選項');
  applyValidation_(ss, SHEETS.edit, 'B5', '服務選項');
  applyDateValidation_(ss, SHEETS.edit, 'B6');
  applyValidation_(ss, SHEETS.edit, 'B7', '時間選項');
  applyValidation_(ss, SHEETS.edit, 'B8', '延時選項');
  applyValidation_(ss, SHEETS.edit, 'B9', '是否選項');
  applyValidation_(ss, SHEETS.edit, 'B10', '修改指令選項');
  applyValidation_(ss, SHEETS.query, 'B2', '月份選項');
  applyValidation_(ss, SHEETS.query, 'E2', '狀態查詢選項');
  applyValidation_(ss, SHEETS.services, 'D2:E500', '是否選項');
  applyValidation_(ss, SHEETS.artists, 'B2:B200', '接單狀態選項');
  applyValidation_(ss, SHEETS.special, 'A2:A500', '美甲師全店選項');
  applyDateValidation_(ss, SHEETS.special, 'B2:B500');
  applyValidation_(ss, SHEETS.special, 'C2:C500', '特殊類型選項');
  applyValidation_(ss, SHEETS.special, 'D2:E500', '時間選項');
  applyValidation_(ss, SHEETS.special, 'G2:G500', '啟用選項');
  applyValidation_(ss, SHEETS.fixed, 'A2:A500', '美甲師選項');
  applyValidation_(ss, SHEETS.fixed, 'B2:B500', '星期選項');
  applyValidation_(ss, SHEETS.fixed, 'C2:C500', '是否選項');
  applyValidation_(ss, SHEETS.fixed, 'D2:E500', '時間選項');
  applyValidation_(ss, SHEETS.customers, 'F2:F5000', '生日月份選項');
}

function buildOptionRows_() {
  const cols = [
    ['週別', '本週', '下週', '下下週'],
    ['完成指令', '未執行', '標記完成', '更新預約畫面'],
    ['新增指令', '未執行', '執行現場新增', '更新預約畫面'],
    ['修改指令', '未執行', '載入預約', '修改預約', '延長時間', '取消預約', '更新預約畫面'],
    ['是否', '是', '否'],
    ['時間', ...buildTimeOptions_()],
    ['調整分鐘', 30, 60, -30, -60],
    ['月份', '全部', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    ['狀態查詢', '全部', '已確認', '待確認', '已完成', '已取消'],
    ['生日月份', '未填', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    ['接單狀態', '可接單', '暫停接單', '停用'],
    ['特殊類型', '休假', '加開'],
    ['啟用', '啟用', '停用'],
    ['星期', '週一', '週二', '週三', '週四', '週五', '週六', '週日'],
  ];
  const max = Math.max(...cols.map((col) => col.length));
  return Array.from({ length: max }, (_v, row) => cols.map((col) => col[row] || ''));
}

function buildTimeOptions_() {
  const rows = [];
  for (let minutes = 8 * 60; minutes <= 23 * 60; minutes += 30) rows.push(minutesToTime_(minutes));
  return rows;
}

function createNamedRange_(ss, name, sheetName, a1) {
  const existing = ss.getRangeByName(name);
  if (existing) ss.removeNamedRange(name);
  ss.setNamedRange(name, ss.getSheetByName(sheetName).getRange(a1));
}

function applyValidation_(ss, sheetName, a1, rangeName) {
  const range = ss.getRangeByName(rangeName);
  if (!range) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInRange(range, true).setAllowInvalid(false).build();
  ss.getSheetByName(sheetName).getRange(a1).setDataValidation(rule);
}

function applyDateValidation_(ss, sheetName, a1) {
  const rule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build();
  ss.getSheetByName(sheetName).getRange(a1).setDataValidation(rule);
}

function sortAndColorSheets_(ss) {
  const colors = {};
  [SHEETS.week, SHEETS.add, SHEETS.edit, SHEETS.query].forEach((name) => colors[name] = '#34a853');
  [SHEETS.bookings, SHEETS.customers, SHEETS.services, SHEETS.artists, SHEETS.special, SHEETS.fixed].forEach((name) => colors[name] = '#4285f4');
  [SHEETS.settings, SHEETS.slots, SHEETS.options].forEach((name) => colors[name] = '#9aa0a6');
  TAB_ORDER.forEach((name, index) => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(index + 1);
    sheet.setTabColor(colors[name] || null);
  });
}

function freezeFirstColumnAllSheets_(ss) {
  Object.values(SHEETS).forEach((name) => {
    const sheet = ss.getSheetByName(name);
    if (sheet) sheet.setFrozenColumns(1);
  });
}

function hideSystemSheets() {
  const ss = getAppSpreadsheet_();
  [SHEETS.settings, SHEETS.slots, SHEETS.options].forEach((name) => {
    const sheet = ss.getSheetByName(name);
    if (sheet) sheet.hideSheet();
  });
}

function showSystemSheets() {
  const ss = getAppSpreadsheet_();
  [SHEETS.settings, SHEETS.slots, SHEETS.options].forEach((name) => {
    const sheet = ss.getSheetByName(name);
    if (sheet) sheet.showSheet();
  });
}

function deleteLegacySheets() {
  const ss = getAppSpreadsheet_();
  const currentNames = new Set(Object.values(SHEETS));
  ss.getSheets().forEach((sheet) => {
    const name = sheet.getName();
    if (currentNames.has(name)) return;
    if (!/^\d{2}\s/.test(name)) return;
    if (ss.getSheets().length <= 1) return;
    ss.deleteSheet(sheet);
  });
}

function safeUiAlert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    console.log(message);
  }
}

function resetSheetForLayout_(sheet) {
  sheet.clear();
  sheet.clearConditionalFormatRules();
  const rows = Math.min(sheet.getMaxRows(), 5000);
  const cols = Math.min(sheet.getMaxColumns(), 30);
  sheet.getRange(1, 1, rows, cols).clearDataValidations();
}

function styleKeyValueSheet_(sheet, rows) {
  sheet.getRange(1, 1, rows, 3).setBorder(true, true, true, true, true, true);
  sheet.setColumnWidths(1, 1, 160);
  sheet.setColumnWidths(2, 1, 260);
  sheet.setColumnWidths(3, 1, 520);
}

function styleTable_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  sheet.getRange(1, 1, 1, lastCol).setBackground('#111827').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, lastCol);
}

function styleHeader_(range) {
  range.setBackground('#111827').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
}

function styleBand_(range, color) {
  range.merge().setBackground(color || '#dbeafe').setFontWeight('bold');
}

function artistBandColor_(index) {
  const colors = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#ccfbf1'];
  return colors[index % colors.length];
}

function styleWeekStatus_(sheet, startRow, numRows, statusRanges) {
  const range = sheet.getRange(startRow, 2, numRows, 7);
  range.setWrap(true);
  if (Array.isArray(statusRanges)) statusRanges.push(range);
}

function applyWeekStatusRules_(sheet, ranges) {
  if (!ranges.length) {
    sheet.setConditionalFormatRules([]);
    return;
  }
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('已完成').setBackground('#ede9fe').setRanges(ranges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('待確認').setBackground('#fef3c7').setRanges(ranges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('已確認').setBackground('#dbeafe').setRanges(ranges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('已取消').setBackground('#fee2e2').setRanges(ranges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('休假').setBackground('#e5e7eb').setRanges(ranges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('可約').setBackground('#f0fdf4').setRanges(ranges).build(),
  ];
  sheet.setConditionalFormatRules(rules);
}

function styleSlotStatus_(sheet) {
  const range = sheet.getRange('D2:D5000');
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('可預約').setBackground('#dcfce7').setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('已預約').setBackground('#dbeafe').setRanges([range]).build(),
  ];
  sheet.setConditionalFormatRules(rules);
}

function applyBookingStatusRowRules_(ss) {
  const canceledColor = '#e5e7eb';
  const query = ss.getSheetByName(SHEETS.query);
  if (query) {
    query.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$B4="已取消"')
        .setBackground(canceledColor)
        .setRanges([query.getRange('A4:K5000')])
        .build(),
    ]);
  }
  const bookings = ss.getSheetByName(SHEETS.bookings);
  if (bookings) {
    bookings.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$B3="已取消"')
        .setBackground(canceledColor)
        .setRanges([bookings.getRange('A3:T5000')])
        .build(),
    ]);
  }
}

function getSelectedWeekStart_(value) {
  const text = String(value || '本週').trim();
  const offset = text === '下週' ? 7 : text === '下下週' ? 14 : 0;
  return addDays_(getWeekStart_(new Date()), offset);
}

function getWeekStart_(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d;
}

function addDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function formatDate_(date) {
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatMaybeDate_(value) {
  if (!value) return '';
  return formatDate_(value);
}

function toDate_(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const match = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function getWeekday_(date) {
  return ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][new Date(date).getDay()];
}

function normalizeTimeText_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  const text = String(value).trim().replace('：', ':').replace('點半', ':30').replace('點', ':00');
  const match = text.match(/(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) return '';
  return `${String(match[1]).padStart(2, '0')}:${String(match[2] || '00').padStart(2, '0')}`;
}

function timeToMinutes_(value) {
  const text = normalizeTimeText_(value);
  if (!text) return 0;
  const [hour, minute] = text.split(':').map(Number);
  return hour * 60 + minute;
}

function minutesToTime_(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function mode_(values) {
  const counts = {};
  values.filter(Boolean).forEach((value) => counts[value] = (counts[value] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getAppSpreadsheet_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到 Google Sheet。若使用獨立 Apps Script，請先填入 SPREADSHEET_ID。');
  return ss;
}

function debugSystemTarget() {
  const ss = getAppSpreadsheet_();
  const bookingSheet = ss.getSheetByName(SHEETS.bookings);
  const slotSheet = ss.getSheetByName(SHEETS.slots);
  return {
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    bookingSheetName: SHEETS.bookings,
    bookingLastRow: bookingSheet ? bookingSheet.getLastRow() : 0,
    slotLastRow: slotSheet ? slotSheet.getLastRow() : 0,
    sheets: ss.getSheets().map((sheet) => sheet.getName()),
  };
}
