/** Lesson links come from Notion: allow only http(s) and the app's own resource proxy (SRS §6.3). */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/api/resources/")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
