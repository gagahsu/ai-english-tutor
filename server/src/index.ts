import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { loadConfig, loadEnvFile, repoRoot } from "./config.js";
import { openDatabase } from "./db.js";
import { createMistralProvider } from "./llm/mistral.js";
import { createNotionGateway } from "./notion/gateway.js";

loadEnvFile();
const config = loadConfig();
const db = openDatabase(config.databasePath);
const notion =
  config.notionToken && config.notionLessonsDatabaseId
    ? { gateway: createNotionGateway(config.notionToken), databaseId: config.notionLessonsDatabaseId }
    : null;

const llm = config.mistralApiKey ? createMistralProvider({ apiKey: config.mistralApiKey, model: config.mistralModel }) : null;

if (!notion) console.warn("Notion is not configured (NOTION_TOKEN / NOTION_LESSONS_DATABASE_ID); sync is disabled.");
if (!llm) console.warn("MISTRAL_API_KEY is not set; the AI teacher is disabled.");

// Serve the built frontend when there is one (npm run build); in dev, Vite serves it on :5173.
const builtWeb = path.join(repoRoot, "web", "dist");
const webDir = fs.existsSync(path.join(builtWeb, "index.html")) ? builtWeb : undefined;

// Single-user app: listen on loopback only.
createApp({ db, notion, llm, webDir }).listen(config.port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${config.port}${webDir ? " (serving web/dist)" : ""}`);
});
