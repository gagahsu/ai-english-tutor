# AI English Tutor

使用 Notion 英文課筆記作為教材的 AI 英文家教網站規劃專案，目標是讓學習者透過**輪流語音對話**練習英語口說，並以免費優先的技術方案實作。

> 專案狀態：P0-1 資料層（Notion 同步、SQLite、課程 API）、P0-2 教學引擎（Mistral 介接、章節抽取、教師控制器、上課 API）與 P0-3 語音介面（網站前端、語音辨識／朗讀、文字備援）已完成；下一步為 P0-4 學習資料（課後摘要、續課）。

## 開發

需要 Node.js 22。複製 `.env.example` 為 `.env` 並填入 Notion 與 Mistral 設定後：

```sh
npm install
npm run dev    # 開發模式：打開 http://127.0.0.1:5173
npm test

# 或建置後以單一程式執行：
npm run build
npm start      # 打開 http://127.0.0.1:3001
```

語音功能請用 Windows 上的 Chrome 或 Edge，並允許麥克風；可先到「設定與裝置檢查」測試麥克風與英文語音。沒有麥克風或語音時，全程可改用打字上課。

## 產品目標

- 透過 Notion API 直接同步 Notion 英文課教材，依課程段落進行教學。
- AI 老師主動提問，學生透過麥克風回答，使用語音辨識與語音播放完成輪流對話。
- 採用 **Balanced 糾錯**：重要錯誤當下糾正，一般錯誤留到課後整理。
- 老師使用**英文為主**，預設 A2 程度，語速 Normal (`1.0`)。
- 學生可用**繁體中文或中英混用**表達不會說的內容；老師會提供自然英文說法、朗讀、邀請學生重述後繼續課程。
- 儲存課程進度、學習紀錄與課後回饋。

## 規格文件

- [軟體需求規格書（SRS）](docs/SRS.md) — 功能需求、教學邏輯、資料架構、API、驗收條件、開發階段與技術風險。

## 預計技術架構（尚待 P0 驗證）

| 類別 | 方案 |
| --- | --- |
| 前端 | React + Vite + TypeScript |
| 後端 | Node.js + Express |
| LLM | Mistral API（可替換模型供應商） |
| STT | Browser Web Speech API |
| TTS | Browser SpeechSynthesis |
| 資料保存 | SQLite |
| 教材來源 | Notion API（Internal Integration，唯讀）；HTML / Markdown 匯入為 P1 備援 |

免費 API 額度、語音辨識的瀏覽器支援與語音品質依實際環境而異，不能保證完全免費或所有裝置一致。

## 開發路線圖

- **P0｜可上完一堂課**：Notion 教材同步、語音輪流互動、AI 課程引導、中英混用求助、Balanced 糾錯、基本學習紀錄、錯誤處理與驗收測試。
- **P1｜長期學習**：批次課程管理、歷史紀錄、錯誤複習、課後報告與更多設定。
- **P2｜體驗優化**：自動判斷說話結束、更佳語音模型、進階情境練習及跨裝置體驗。

詳細需求與各階段範圍以 [docs/SRS.md](docs/SRS.md) 為準。

## 初始驗收教材

以使用者 Notion 課程「A2 基礎會話 c 3/10」（Airport & Travel）作為首個端到端測試案例。教材內容尚未加入本儲存庫；未經同意不公開個人課堂筆記。

## 安全原則

- 不將 Mistral API Key、Notion Integration Token 寫入前端程式或提交至 Git。
- 使用 `.env`（排除版本控制）管理敏感設定。
- 優先以私有儲存庫管理規格和後續課程資料。

## License

尚未指定授權條款。
