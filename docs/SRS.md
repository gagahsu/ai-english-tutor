# AI 英文家教網站 — 軟體需求規格書（SRS）

版本 v1.1 \| 日期：2026-10-23 \| 狀態：開發基準／待實作

v1.1 變更：教材來源由「Notion HTML / Markdown 匯出檔」改為「Notion API 單向同步」；檔案匯入降為 P1 備援（FR-01、FR-16、§6、§7、NFR-04、AT-01、AT-13、§12、§13）。

v1.2 變更：依實際 Notion 頁面結構，改為「整頁教材僅存後端＋學生可見內容白名單」；同步時以 LLM 抽取章節結構化欄位，可人工修正（FR-02、§6.2、§6.4、§7、AT-01、§13）。

產品目標：使用既有 Notion 英文課程筆記，打造免費優先、以口說練習為核心、可持續複習的 AI 英文老師網站。

# 0. 文件定義與優先級

| 分類        | 定義                                                      |
|-------------|-----------------------------------------------------------|
| P0 / Must   | 第一版 MVP 必須具備，缺少則不可驗收                       |
| P1 / Should | 第二階段，強化可長期學習能力                              |
| P2 / Could  | 第三階段，強化流暢度與品質                                |
| 不在 P0     | 真人即時打斷、完整發音評分、寫回 Notion（P0 只做單向讀取）、多人付費訂閱 |

本文件由已確認需求整理；未經實測的免費 API 用量、跨瀏覽器 STT 可用性與特定服務價格均視為待驗證的技術風險，而非保證。

# 1. 產品範圍與目標

- 主要使用者：單一英文學習者，初始英文程度 A2，主要使用 Windows 11 桌面瀏覽器，介面需具備手機響應式布局。

- 主要目標：可以選一堂課，由 AI 老師口頭引導 warm-up、short talk、vocabulary、conversation 與相關活動，學生口頭回答。

- 輸入語言：英語、繁體中文或兩者混合。英文仍為老師主導教學語言。

- 教材來源：透過 Notion API 直接讀取使用者的 Notion 課程頁面，不需手動匯出檔案。

- 成本原則：免費開源前後端、本機 SQLite、瀏覽器 STT/TTS、Notion API（Internal Integration）、可用免費額度的 LLM；提供限制與降級處理。

- MVP 成功條件：以「A2 基礎會話 c 3/10」完成一輪可重複的語音課程，並保存進度與回饋。

# 2. 主要使用者流程

0\. （首次或教材更新時）按下「從 Notion 同步」→ 後端透過 Notion API 讀取課程資料庫 → 檢視同步結果與警告。

1\. 開啟網站 → 選擇課程 → 檢查麥克風與語音播放。

2\. 老師讀取課程及上一輪進度，使用英文開始 Warm-up，朗讀問題。

3\. 老師播放完成後，使用者按下麥克風回答（English / 中文 輸入模式）。

4\. 網站將語音轉為文字，顯示辨識結果；使用者可修改、重錄或提交。

5\. 後端傳送課程內容、對話上下文及學生回答至 LLM；由教師控制器決定追問、提示、糾錯或換章節。

6\. 老師以英文簡短回答並朗讀；如中文求助，先提供英文示範並邀請跟讀，再回到課程。

7\. 完成章節或主動結束課程時，產生摘要、字彙、錯誤紀錄、建議複習內容。

# 3. 功能需求（FR）

| ID    | 優先 | 需求與可觀察行為                                                                       |
|-------|------|----------------------------------------------------------------------------------------|
| FR-01 | P0   | 透過 Notion API 單向同步課程資料庫「Language bar」中的所有課程（排除 Template 等非課程列）；手動「重新同步」，以 last_edited_time 判斷是否有變更；同步結果與無法解析的區塊以警告列出。 |
| FR-02 | P0   | 顯示課程列表、標題、章節、字彙；LLM 抽取的章節結構（題目、字彙、參考答案）可人工檢視與修正，修正後不被下次同步覆蓋（除非該章節在 Notion 有變更並經確認）。 |
| FR-03 | P0   | 選課後由老師主動開始對話，一次只問一個主要問題。                                       |
| FR-04 | P0   | 輪流語音：老師播音完成後方可開始學生錄音；手動開始/結束、重錄、文字輸入備援。          |
| FR-05 | P0   | STT 結果必須可檢視及編輯；不得以未確認的 STT 錯字直接計算文法錯誤。                    |
| FR-06 | P0   | Mistral API 使用後端代理；支援上下文整理、逾時重試（限次）及明確額度錯誤。             |
| FR-07 | P0   | 老師使用英文 TTS 朗讀回答，可重播、暫停、停止、控制語速。                              |
| FR-08 | P0   | balanced 糾錯：只即時糾正阻礙理解的重要錯誤，其餘在課後總結。                          |
| FR-09 | P0   | 中文協助：可辨識中文求助，提供符合 A2、語意忠實的英文示範，朗讀，請學生跟讀，可跳過。  |
| FR-10 | P0   | 記錄課程進度、學生提交答案、老師回覆、糾錯及中文協助歷史。                             |
| FR-11 | P0   | 結束時輸出課後摘要、字彙、文法修正、更自然的說法及下一次練習建議。                     |
| FR-12 | P0   | 設定頁：糾錯 balanced、語速 normal(1.0)、老師語言 english、英/中文辨識切換與裝置檢查。 |
| FR-13 | P1   | 跨課程複習、間隔複習、個人薄弱項目標記。                                               |
| FR-14 | P1   | 多課程管理、章節進度條、複習歷史、搜尋及課程重新整理。                                 |
| FR-15 | P2   | 自動偵測回答結束；更穩定的中英混合語音辨識及品質更好的語音引擎。                       |
| FR-16 | P1   | 檔案匯入備援：匯入 Notion 匯出的 HTML / Markdown / ZIP（HTML 消毒、ZIP 防路徑穿越與壓縮炸彈），供無法使用 Notion API 時使用。 |

# 4. AI 老師教學行為規格

## 4.1 預設設定

> { "correctionMode": "balanced", "speechRate": 1.0, "teachingLanguage": "english", "studentLevel": "A2", "locale": "zh-TW" }

## 4.2 教師行為規則

- 以英文帶課；回答通常為 1–3 句，每輪只提出一個核心問題。

- 回答符合 A2 難度；必要時用簡單英文重述，仍不懂才用繁體中文說明。

- 依課程章節循序引導，但允許學生要求跳題、再說一次、解釋詞彙或結束。

- 老師應提問、等待、回饋、追問，而非直接把教材標準答案當作回覆。

- 說話節奏以瀏覽器 voice rate=1.0 作為初始值；不同語音實際語速可能有差異。

## 4.3 Balanced 糾錯判定

| 類型            | 處理                                     |
|-----------------|------------------------------------------|
| 妨礙語意/溝通   | 即時簡短糾正，最多一個重點，然後恢復話題 |
| 可理解的小錯誤  | 不中斷，加入課後回饋                     |
| 可能為 STT 誤聽 | 提示使用者確認，暫不判定語言能力         |
| 表達完全正確    | 自然鼓勵並追問，不強行找錯               |

## 4.4 中文求助 / Code-switch 行為

• 偵測使用者回答為中文、混合中英，或明確說「這句英文怎麼說」。

• 識別意圖；如果中文存在歧義，先確認關鍵意思。

• 提供一種簡單、自然、語意忠實的英文說法（必要時可附較口語的另一版）。

• TTS 只朗讀英文示範；畫面可顯示繁體中文簡短說明。

• 邀請使用者跟讀一次，允許跳過；勿將中文求助視為答錯。

• 完成練習後恢復原問題或適當追問，不得遺失章節狀態。

範例：使用者「我最喜歡沖繩的海灘，因為海水很清澈」→ 老師「You can say: I loved the beaches in Okinawa because the water was so clear. Can you try saying that?」

# 5. 語音互動狀態機

> IDLE → TEACHER_SPEAKING → WAITING_FOR_STUDENT → LISTENING → TRANSCRIPT_REVIEW → THINKING → TEACHER_SPEAKING

例外狀態：MIC_DENIED、STT_UNSUPPORTED、STT_NO_MATCH、NETWORK_ERROR、LLM_RATE_LIMIT、TTS_UNAVAILABLE；每種例外均可返回文字輸入/重試，不會遺失對話。

- STT 最初採用瀏覽器 SpeechRecognition，提供 en-US / zh-TW 明確切換；不可假設所有瀏覽器支援自動中英混合辨識。

- TTS 使用 speechSynthesis；選擇英文聲線，語速 1.0；voice 不可用時顯示文字且允許繼續。

- 老師播音時停用錄音，避免回音；使用者明確按下開始或重播才觸發相應動作。

- 短時間內請求重複提交需有 requestId 去重，避免同一個回答引發多次老師回覆。

# 6. Notion 同步與資料模型

Notion 原始章節名稱需保留。例如樣本「A2 基礎會話c 3/10」包含 Learning materials、Warm-up、Short Talk、Vocabulary、Conversation、GROUP ACTIVITY。

實際頁面以答案與筆記為主（中英對照、完整填空答案、範例回答、學生本人的 Short Talk 回答與 Warm-up 日記），且沒有任何「這是答案」的標記；題目與圖片主要在 Learning materials 的 PDF 中。因此：**整頁 Notion 內容視為老師教材，只存在後端並提供給 LLM；學生端只顯示白名單欄位**（見 §6.4），其餘一律不輸出，避免提前洩題。

## 6.1 Notion 連線

- 使用 Notion Internal Integration，只開啟「讀取內容」權限；Token 存於伺服器環境變數 `NOTION_TOKEN`。
- 使用者需在 Notion 將課程頁面（或其上層頁面/資料庫）透過 Connections 分享給此 Integration，否則 API 讀不到；未分享時需顯示明確的設定指引。
- 後端使用官方 SDK `@notionhq/client`，並固定 API 版本（Notion-Version）；版本升級須重新驗證解析結果。

## 6.2 同步流程

- 讀取頁面屬性與完整 block 樹：遞迴讀取 `has_children` 的子區塊，並處理分頁（每次最多 100 筆）。
- 課程清單：教材來源為 Notion 資料庫「Language bar」，每一列（頁面）為一堂課。目前欄位只有 Doc name、Created by、Created time、Last edited by、Last updated time，沒有程度或主題欄位。
- 排除非課程列：例如「Template」。標題不符合課程命名規則的列不匯入，並列入警告。
- 從標題解析課程資訊：例如「A2 基礎會話c 3/10」→ level `A2`、course `基礎會話`、series `c`、unit `3`、totalUnits `10`。實際標題前後可能有多餘空白（例如開頭空格），系列字母前也可能沒有空格，解析前需 trim 並容許空白差異。課程列表依 series、unit 排序。
- 增量同步：查詢資料庫時比較每列的 last_edited_time 與本機快照，只重新讀取有變更的頁面的 block 樹。
- 章節切分（固定規則）：每個頂層、可收合的 heading_1 為一個 Section，保留原始標題文字；其下所有區塊轉為 Markdown 存入 `sourceMarkdown`。頂層但不在任何 heading_1 收合區內的區塊，歸入前一個 Section。
- 章節名稱每課不同（例如 Reading、Grammar／拼錯的 Gramma、Expression、Discussion、Statement Debate），`kind` 以已知名稱對應（warm-up、short-talk、vocabulary、conversation、grammar、group-activity、speaking、learning-materials 等），無法對應者為 `other`，不得因未知名稱而略過內容。
- 空殼章節：內容為空、或只重複標題文字（例如 Template 遺留的「Extended Learning」）的 Section 不匯入。
- 段落內部格式不一致（題目可能是 heading_2/heading_3/編號清單，答案寫法多樣），不以固定規則解析題目與答案，改由 §6.4 的 LLM 抽取。
- 不支援或無法解析的區塊（例如 unsupported、embed）不中斷同步，列入警告。
- 同步結果為 SQLite 快照：上課時只讀 SQLite，不在每輪對話呼叫 Notion API；Notion 斷線時已同步的課程仍可上課。
- 重新同步以 Notion page id / block id 作為穩定 ID 更新快照，不重複建立課程；已存在的 Session 進度保留，對應章節被刪除時標示為失效而非直接刪除紀錄。
- 遵守 Notion API 速率限制（平均約每秒 3 個請求）：同步時節流，收到 429 時依 Retry-After 重試。
- Learning materials 的 PDF 可能是外部連結（例如 storage.googleapis.com）或 Notion 託管檔案。P0 只提供連結/嵌入檢視，不解析 PDF 內容。Notion 託管檔案的下載連結會過期，不可永久保存原始 URL，需於檢視時重新取得；外部連結是否會過期待觀察。

## 6.3 資料模型

> Lesson { id, notionPageId, title, level, course, series, unit, totalUnits, topic, sections\[\], notionLastEditedAt, lastSyncedAt }
>
> Section { id, lessonId, notionBlockId, kind, title, sourceMarkdown, sourceHash, prompts\[\], vocabulary\[\], referenceAnswers\[\], resources\[\], extractionStatus, editedByUser, stale }
>
> Session { id, lessonId, sectionId, state, startedAt, endedAt, settingsSnapshot }
>
> Turn { id, sessionId, role, inputLanguage, transcript, verifiedByStudent, teacherText, createdAt }
>
> Feedback { id, turnId, type, original, suggestion, reasonZh, deferred, reviewStatus }

使用 SQLite 儲存結構化課程、對話與設定。Notion 內容在前端呈現時須跳脫，連結只允許 http(s)。

## 6.4 章節內容抽取與學生可見範圍

- 同步後，對每個新增或 `sourceHash` 有變更的 Section 呼叫一次 LLM，從 `sourceMarkdown` 抽取 `prompts`（老師可問的題目）、`vocabulary`（單字＋中文）、`referenceAnswers`（標準答案、範例回答、學生先前的回答）。輸出需以 schema 驗證，失敗時重試一次，再失敗則標記 `extractionStatus = failed`，上課時退回直接以 `sourceMarkdown` 作為老師教材。
- 未變更的 Section 不重新抽取，以節省 LLM 用量。使用者手動修正過的 Section（`editedByUser`）在 Notion 有變更時，需提示使用者選擇保留修正或重新抽取，不得自動覆蓋。
- 學生端白名單：課程標題、章節標題、`prompts`、`vocabulary` 的單字表、Learning materials 連結。`sourceMarkdown`、`referenceAnswers` 及其他欄位只在後端使用，不由學生端 API 輸出。
- 教材中含學生個人生活內容（例如 Warm-up 日記），會隨課程內容傳給 LLM 供應商；需依 §9 在介面標示第三方資料傳輸。

# 7. 系統架構與 API

建議：React + Vite + TypeScript（前端） / Node.js + Express（後端） / SQLite（本機儲存） / Mistral（LLM），並以 LLM Provider Adapter 隔離廠商。

> Browser (UI + STT + TTS) ⇄ Node API (auth/config/session/prompt) ⇄ Mistral LLM
>
> ⇅ SQLite（課程快照、對話、設定）
>
> Node API → Notion API（僅同步時，唯讀）

| Endpoint                      | 用途                                           |
|-------------------------------|------------------------------------------------|
| GET /api/notion/status        | 檢查 Notion Token 是否設定、是否可連線         |
| POST /api/lessons/sync        | 同步「Language bar」資料庫（資料庫 ID 存於 `NOTION_LESSONS_DATABASE_ID`，也可傳入連結），回傳警告與課程清單 |
| POST /api/lessons/:id/sync    | 重新同步單一課程                               |
| PUT /api/lessons/:id/sections/:sectionId | 人工修正 LLM 抽取的題目、字彙與參考答案 |
| POST /api/lessons/import      | （P1）檔案匯入備援：HTML、Markdown 或 ZIP      |
| GET /api/lessons              | 列出可上課教材                                 |
| GET /api/lessons/:id          | 讀取教材與章節（只輸出 §6.4 白名單欄位）       |
| POST /api/sessions            | 開始課程、載入設定與進度                       |
| POST /api/sessions/:id/turns  | 提交已確認逐字稿，取得老師回覆、糾錯與下一步   |
| POST /api/sessions/:id/finish | 結束課程並產生課後回顧                         |
| GET /api/sessions/:id         | 續課與讀取紀錄                                 |
| GET/PUT /api/settings         | 取得/修改教學與語音設定                        |

所有 API Key（Mistral、Notion）只存伺服器環境變數，禁止在瀏覽器 JavaScript 或匯出教材中出現；後端應限制請求大小、頻率與來源。

# 8. LLM 輸出協定（建議）

> {  
> "teacherReply": "You can say: I loved the beaches in Okinawa...",  
> "intent": "chinese_assistance",  
> "nextAction": "repeat_or_skip",  
> "lessonSectionId": "short-talk",  
> "corrections": \[\],  
> "assistance": {"english": "I loved the beaches in Okinawa because the water was so clear.", "zhExplanation": "用過去式描述旅行經驗。"}  
> }

後端需以 schema 驗證模型輸出；若回傳格式不正確，應允許安全重試一次或降級成純文字老師回覆，不直接造成整堂課崩潰。

# 9. UI / UX 規格

- 桌機：左側課程/章節清單、中央老師聊天與錄音操作、右側字彙及老師筆記。

- 手機：單欄介面、可切換教材/對話/筆記；核心開始/停止錄音按鈕固定易操作位置。

- 語音狀態清楚顯示：老師說話中、等待回答、錄音中、正在辨識、AI 思考中、出錯。

- 字幕隨時可見；TTS 重播、文字提交及編輯入口不可隱藏。

- 顯示麥克風授權、音量測試、英/中文輸入模式及語音引擎備援提示。

- 保護學習者隱私：預設只儲存文字及糾錯紀錄，不儲存原始錄音；需明確說明第三方 STT/LLM 的資料傳輸。

# 10. 非功能需求（NFR）

| ID     | 標準                                                                                    |
|--------|-----------------------------------------------------------------------------------------|
| NFR-01 | 使用者可在 Windows 11 最新 Chrome / Edge 執行；手機為響應式，語音功能以相容性實測為準。 |
| NFR-02 | 單輪請求需有明確載入狀態、逾時提示與可重新送出的操作。                                  |
| NFR-03 | 未授權麥克風或 STT 不支援時，可完整使用文字模式完成課程。                               |
| NFR-04 | 伺服器不暴露 Mistral API Key 與 Notion Token；Notion Integration 僅授予讀取權限；同步內容在前端呈現時跳脫。 |
| NFR-05 | 保留可匯出/刪除課程與學習資料的操作；對第三方服務標示傳輸與保存限制。                   |
| NFR-06 | 集中記錄非敏感錯誤碼、回應耗時與 Token 用量，避免記錄完整私人逐字稿於應用程式日誌。     |

# 11. 驗收測試（P0）

| 編號  | 情境                  | 通過條件                                         |
|-------|-----------------------|--------------------------------------------------|
| AT-01 | 透過 Notion API 同步樣本課程 | 保留課程標題、原始章節名稱與字彙，可在課程頁選擇；略過 Template 與空殼章節；學生端 API 不含 `sourceMarkdown` 與參考答案；重新同步不重複建立課程、不遺失進度與人工修正 |
| AT-02 | 老師主動開課          | 從 Warm-up 自動提出首題且播放英文語音            |
| AT-03 | 英文語音回答          | 結束錄音後出現可修改逐字稿，提交後有貼題追問     |
| AT-04 | 中文回答              | 得到忠實自然的 A2 英文說法、朗讀、跟讀或跳過選項 |
| AT-05 | 中英混合              | 不因中文詞彙被誤判失敗，能提出完整英文示範       |
| AT-06 | balanced 小錯誤       | 先繼續對話，課後列出修正                         |
| AT-07 | 嚴重語意問題          | 立即只糾正一個關鍵錯誤，再回到課題               |
| AT-08 | STT 辨識錯誤          | 學生可以編輯，未確認辨識文字不計入文法評分       |
| AT-09 | 麥克風拒絕/無語音服務 | 可改文字聊天，課程不中斷                         |
| AT-10 | LLM 額度用完/斷線     | 顯示明確錯誤、保留原始回答及課程狀態             |
| AT-11 | TTS 失敗              | 文字內容仍顯示且可繼續上課                       |
| AT-12 | 完成課程              | 保存章節狀態及課後回饋；重新開啟可查閱           |
| AT-13 | Notion Token 無效/頁面未分享/Notion 斷線 | 顯示明確錯誤與分享設定指引；已同步的課程仍可正常上課 |

# 12. 開發里程碑與定義

- P0-1 資料層：Notion API 同步、課程列表、課程資料模型、SQLite。

- P0-2 教學引擎：Mistral Provider Adapter、老師指令、結構化輸出、課程狀態機。

- P0-3 語音介面：STT/TTS、英/中文切換、文字備援、字幕與重播。

- P0-4 學習資料：balanced 糾錯、中文求助、課後摘要、保存與續課。

- P0-5 品質驗收：執行 AT-01 至 AT-13，修復後再視為 MVP 完成。

- P1：跨課程複習、錯誤統計、搜尋及管理、檔案匯入備援。P2：更自然的中英混合 STT、語音品質、自動端點偵測及部署。

# 13. 技術風險與待確認事項

- Mistral 免費 API 限制會變動，部署前應以實際帳號的模型清單與 Limits 為準；架構須允許更換供應商。

- Web Speech STT 並非所有瀏覽器均完整支援，且可能由瀏覽器供應商於雲端處理；需在目標瀏覽器實測。

- 中英混合「自動識別」不列入 P0 保證；第一版透過明確語言切換及文字修正處理。

- 語音朗讀速度 1.0 不保證各作業系統聽感相同；要給使用者調整與重播。

- 若要公開部署且多人使用，需加入身份驗證、資源隔離、API 限流與主機成本重新評估。

- 課程 PDF 與外部連結是否可存取不能只依 URL 推定；Notion 託管檔案連結會過期，同步介面應標示缺失或無法取得的資源。

- Notion API 版本、區塊類型與速率限制可能變動；實作時以官方文件為準，並固定 API 版本。

- Notion 新版 API 將資料庫拆為 database 與 data source，查詢端點依 API 版本不同；實作時以固定的版本為準。

- LLM 抽取章節結構可能漏抓或誤判，尤其是格式特殊的章節；以人工修正（FR-02）與 `sourceMarkdown` 退回機制降低影響，並以多課實際頁面（至少 b、c 兩個系列）測試抽取品質。

- 題目與圖片主要在 PDF 中而 P0 不解析 PDF，部分練習（例如看圖說明）老師只能依 Notion 筆記引導；是否於 P1 解析 PDF 待評估。

文件結束 — 本規格適用於單一使用者、免費優先的 MVP；追加需求需標註 P0/P1/P2 與驗收標準。
