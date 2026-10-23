import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

// Append-only: each entry runs once, tracked by PRAGMA user_version.
const migrations: string[] = [
  `
  CREATE TABLE lessons (
    id                    TEXT PRIMARY KEY,
    notion_page_id        TEXT UNIQUE,
    title                 TEXT NOT NULL,
    level                 TEXT,
    course                TEXT,
    series                TEXT,
    unit                  INTEGER,
    total_units           INTEGER,
    topic                 TEXT,
    notion_last_edited_at TEXT,
    last_synced_at        TEXT NOT NULL,
    stale                 INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sections (
    id                TEXT PRIMARY KEY,
    lesson_id         TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    notion_block_id   TEXT,
    position          INTEGER NOT NULL,
    kind              TEXT NOT NULL,
    title             TEXT NOT NULL,
    source_markdown   TEXT NOT NULL,
    source_hash       TEXT NOT NULL,
    prompts           TEXT NOT NULL DEFAULT '[]',
    vocabulary        TEXT NOT NULL DEFAULT '[]',
    reference_answers TEXT NOT NULL DEFAULT '[]',
    resources         TEXT NOT NULL DEFAULT '[]',
    extraction_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (extraction_status IN ('pending', 'done', 'failed', 'needs_review')),
    edited_by_user    INTEGER NOT NULL DEFAULT 0,
    stale             INTEGER NOT NULL DEFAULT 0,
    UNIQUE (lesson_id, notion_block_id)
  );
  `,
];

export function openDatabase(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
