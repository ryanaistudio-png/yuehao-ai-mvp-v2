# 約好 AI MVP v3 設計與安裝

## 這版解決什麼

MVP v3 的目標是讓店家不要被十幾張表嚇到，只保留預約需要的核心流程：

- `01 一週預約表`：看本週、下週、下下週預約，也可標記已完成
- `02 現場新增`：只負責新增現場客或電話客
- `03 修改預約`：輸入預約編號後，載入資料再修改、延長或取消
- `04 預約查詢`：依月份和狀態查看預約資料
- `05 預約資料庫`：系統資料，不建議直接修改
- `06 客戶資料庫`：保存客戶資料和生日月份

## 安裝流程

### 第 1 步：建立 Google Sheet

1. 開 Google Drive
2. 新增一份 Google 試算表
3. 建議命名：`Demo 約好 AI MVP v3`
4. 點上方 `擴充功能 -> Apps Script`
5. 刪掉原本的範例程式
6. 貼上 `google-sheets/Code.gs`
7. 儲存
8. 在上方函式下拉選單選 `setupYuehaoV3`
9. 點執行，依畫面完成授權
10. 回到 Google Sheet，重新整理頁面

提醒：`setupYuehaoV3` 會建立 Demo 表格，正式客戶資料不要直接執行覆蓋。

### 第 2 步：部署 Apps Script Web App

1. 回到 Apps Script
2. 右上角點 `部署`
3. 選 `新增部署作業`
4. 類型選 `網頁應用程式`
5. 執行身分選 `我`
6. 誰可以存取選 `所有人`
7. 點 `部署`
8. 複製 `/exec` 結尾的網址

這個網址要填到 Zeabur 的：

```text
APPS_SCRIPT_WEB_APP_URL
```

### 第 3 步：確認 API Token

打開 Google Sheet 的 `90 系統設定`。

找到：

```text
api_token
```

它的值要和 Zeabur 的這個環境變數一樣：

```text
APPS_SCRIPT_API_TOKEN
```

### 第 4 步：更新 GitHub 程式

把 v3 安裝包中的程式上傳到 GitHub repo。

至少要更新：

- `line-deepseek-zeabur-demo/server.js`
- `line-deepseek-zeabur-demo/package.json`
- `line-deepseek-zeabur-demo/package-lock.json`
- `Dockerfile`

### 第 5 步：Zeabur 環境變數

Zeabur 需要這些變數：

```text
PORT=3000
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
APPS_SCRIPT_WEB_APP_URL=
APPS_SCRIPT_API_TOKEN=
SESSION_TTL_MINUTES=120
DEFAULT_TIMEZONE=Asia/Taipei
```

### 第 6 步：LINE Webhook

Zeabur 網址後面加：

```text
/line/webhook
```

例如：

```text
https://你的服務名稱.zeabur.app/line/webhook
```

把這個填到 LINE Developers 的 Webhook URL，並開啟 `Use webhook`。

## 上線前測試

至少測這幾件事：

- LINE 傳 `預約` 會回服務選單
- 可以完成一筆 LINE 預約
- 客人可以取消自己的預約
- `02 現場新增` 可以新增現場客
- `03 修改預約` 可以載入、修改時間、延長時間、取消
- `01 一週預約表` 可以看到資料
- `04 預約查詢` 可以依月份查詢
