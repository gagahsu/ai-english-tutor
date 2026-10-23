import fs from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../..");

export interface Config {
  port: number;
  databasePath: string;
  notionToken: string | undefined;
  notionLessonsDatabaseId: string | undefined;
}

/** Loads the repo-root .env into process.env without overriding variables that are already set. */
export function loadEnvFile(file = path.join(repoRoot, ".env")): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databasePath = env.DATABASE_PATH ?? path.join(repoRoot, "data", "tutor.db");
  return {
    port: Number(env.PORT ?? 3001),
    databasePath: databasePath === ":memory:" ? databasePath : path.resolve(repoRoot, databasePath),
    notionToken: env.NOTION_TOKEN || undefined,
    notionLessonsDatabaseId: env.NOTION_LESSONS_DATABASE_ID || undefined,
  };
}
