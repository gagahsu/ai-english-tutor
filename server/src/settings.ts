import { z } from "zod";
import type { Db } from "./db.js";

// FR-12 / SRS §4.1. P0 offers a single correction mode and teaching language; the enums
// leave room for more without a schema change.
export const settingsSchema = z.object({
  correctionMode: z.enum(["balanced"]),
  speechRate: z.number().min(0.5).max(2),
  teachingLanguage: z.enum(["english"]),
  studentLevel: z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]),
  locale: z.enum(["zh-TW"]),
  sttLanguage: z.enum(["en-US", "zh-TW"]),
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = settingsSchema.partial().strict();

export const DEFAULT_SETTINGS: Settings = {
  correctionMode: "balanced",
  speechRate: 1.0,
  teachingLanguage: "english",
  studentLevel: "A2",
  locale: "zh-TW",
  sttLanguage: "en-US",
};

export function getSettings(db: Db): Settings {
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string } | undefined;
  // Fill in defaults for keys added after the row was written.
  return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) } : DEFAULT_SETTINGS;
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  const next = settingsSchema.parse({ ...getSettings(db), ...patch });
  db.prepare("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data").run(
    JSON.stringify(next),
  );
  return next;
}
