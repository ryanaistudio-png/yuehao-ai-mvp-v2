# 約好 AI MVP v3 安裝包

這版是給美甲店、小型工作室 Demo 用的安全版。

主要功能：

- 客人用 LINE 自然語言預約
- 客人可從 LINE 取消自己的預約
- 店家用 Google Sheet 看本週、下週、下下週預約
- 店家可用 `02 現場新增` 建立現場客預約
- 店家可用 `03 修改預約` 載入預約後修改、延長或取消
- 預約編號改為月份流水號，例如系統內部 `202605-001`，LINE 顯示 `001號`
- 客戶資料庫加入生日月份，方便之後做活動

## v3.2.0 AI 模型切換

v3.2.0 開始，LINE bot 支援 AI Provider Adapter，可以在 Zeabur 用環境變數切換模型。

v3.2.1 補強判斷紀錄：Zeabur logs 會同時出現 `LOCAL_PARSE`、`AI_DECISION`、`FINAL_BOOKING`，方便判斷問題出在 AI、程式本地解析，還是最後合併流程。

v3.2.2 補強 LINE 對話體感：支援 `3點`、`三點`、`5/16 2100` 這類時間輸入；選時段時輸入 `晚一點`、`下午`、`晚上` 會繼續查時段，不會誤判成修改預約；確認預約改為回覆 `888`。

v3.2.3 收斂 bot 對話：服務選單依時間分組且不顯示價格；同時間多服務會二次詢問；美甲師選單預設只顯示名字；`算了 / 不約了 / 取消` 在預約流程中只取消本次流程；補強查空檔上下文、價格詢問、基本美甲師狀態問答。
v3.2.4 補上真正的全局訊息判斷：每則 LINE 訊息先判斷是否為重來、放棄流程、改時間、取消預約、數字選項、多人/多美甲師需求，再進預約流程。多人同行或同時指定多位美甲師會改由店家確認並通知店家；休假日或班表未開放時會用更清楚的文字回覆。
v3.2.5 所有數字選單新增 `0. 重新開始`，客人選錯時可直接清除本次流程；程式會優先處理 `0`，不交給 AI 判斷，也不會和預約編號混淆。
v3.2.6 修正 `20號晚上可以嗎` 這類改日期加時段時仍沿用舊日期的問題；若指定美甲師沒有足夠空檔，會退回美甲師選單讓客人重新選。
v3.3.0 改為 AI 主體理解架構：LINE 每則訊息會帶最近 4 輪對話、上一題與上一題選項給 AI 判斷；程式也會先用上一題選項比對「Amy」「第二個」「款式諮詢」這類文字回答，再交給預約規則驗證。Google Sheet 也同步整理 01 表、跨時段顯示與美甲師增減後的固定班表聯動。90 系統設定新增美甲師專長顯示開關，以及新預約、取消、改時間、待回答通知開關。

### 使用 OpenAI GPT-4.1 mini

```text
AI_PROVIDER=openai
OPENAI_API_KEY=你的 OpenAI API key
OPENAI_MODEL=gpt-4.1-mini
```

### 切回 DeepSeek

```text
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的 DeepSeek API key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

### 共用必要變數

```text
PORT=3000
DEFAULT_TIMEZONE=Asia/Taipei
SESSION_TTL_MINUTES=10
APPS_SCRIPT_WEB_APP_URL=你的 Apps Script Web App /exec 網址
APPS_SCRIPT_API_TOKEN=必須等於 Google Sheet 90 系統設定的 api_token
LINE_CHANNEL_ACCESS_TOKEN=你的 LINE token
LINE_CHANNEL_SECRET=你的 LINE secret
```

注意：API key 不要貼到 GitHub，也不要截圖公開。

### AI 判斷紀錄

v3.2.1 會在 Zeabur logs 印出 `LOCAL_PARSE`、`AI_DECISION`、`FINAL_BOOKING`，方便比較 DeepSeek 和 OpenAI 判斷差異，例如：

```text
LOCAL_PARSE {"text":"明天下午3點可以嗎","date":"2026-05-15","time":"15:00","period":"afternoon"}
AI_DECISION {"source":"openai","text":"我要改預約時間","intent":"reschedule","date":"","time":""}
FINAL_BOOKING {"text":"明天下午3點可以嗎","date":"2026-05-15","time":"15:00","period":"afternoon"}
```

這可以幫助判斷問題到底是 AI 判斷錯，還是後面的流程覆蓋錯。

## 檔案結構

- `google-sheets/Code.gs`：貼到 Google Sheets Apps Script，建立 MVP v3 表格
- `line-deepseek-zeabur-demo/`：部署到 Zeabur 的 LINE webhook 程式
- `docs/MVP_v3_設計與安裝.md`：v3 架構與小白安裝流程
- `docs/客戶手機維護指南.md`：給店家看的手機操作說明
- `docs/線上教學腳本.md`：交付客戶時可照著講的教學流程

## 建議安裝方式

請優先建立一份新的 Google Sheet 測試 v3，不要直接覆蓋正在使用的客戶資料。

如果要升級正式客戶，建議先備份舊表格，再建立 v3 新表，確認 LINE 預約、取消、現場新增、修改預約都正常後再切換。

完整步驟請看：

`docs/MVP_v3_設計與安裝.md`
