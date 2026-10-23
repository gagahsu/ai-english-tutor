import { APIErrorCode, ClientErrorCode, isNotionClientError } from "@notionhq/client";

/** An error whose code and message are safe to return to the browser. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notionNotConfigured = () =>
  new AppError(503, "NOTION_NOT_CONFIGURED", "尚未設定 Notion：請在 .env 設定 NOTION_TOKEN 與 NOTION_LESSONS_DATABASE_ID。");

export function fromNotionError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isNotionClientError(err)) {
    switch (err.code) {
      case APIErrorCode.Unauthorized:
        return new AppError(502, "NOTION_UNAUTHORIZED", "Notion Token 無效或已重新產生，請更新 .env 的 NOTION_TOKEN。");
      case APIErrorCode.ObjectNotFound:
      case APIErrorCode.RestrictedResource:
        return new AppError(
          502,
          "NOTION_NOT_SHARED",
          "讀不到 Notion 課程資料庫：請在 Notion 打開「Language bar」→ 右上角 ••• → Connections，加入這個 Integration，並確認資料庫 ID 正確。",
        );
      case APIErrorCode.RateLimited:
        return new AppError(503, "NOTION_RATE_LIMITED", "Notion 請求過於頻繁，請稍後再同步。");
      case ClientErrorCode.RequestTimeout:
        return new AppError(502, "NOTION_UNREACHABLE", "連線 Notion 逾時，請稍後再試。");
    }
    return new AppError(502, "NOTION_ERROR", `Notion 回傳錯誤（${err.code}），請稍後再試。`);
  }
  return new AppError(502, "NOTION_UNREACHABLE", "無法連線到 Notion，請檢查網路後再試。");
}
