# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

P0-1 (data layer: Notion sync, SQLite, lesson API) and P0-2 (teaching engine: Mistral adapter, section extraction, teacher controller, sessions/turns, settings) are implemented in `server/`. There is no frontend yet. P0-3 (voice UI) is next. From P0-4, `POST /api/sessions/:id/finish` (after-class summary) and resuming a session are not built yet; deferred corrections are already stored as `feedback` rows for that summary. The source of truth for requirements is `docs/SRS.md` (Traditional Chinese); `README.md` summarizes it. Project docs are written in Traditional Chinese (zh-TW), so keep new user-facing docs in that language unless asked otherwise.

## Commands

npm workspaces (Node 22). Run these from the repo root:

```sh
npm install
npm run dev         # API with reload on http://127.0.0.1:3001 (tsx watch)
npm test            # vitest, all server tests
npm run typecheck
npm run build       # server/dist
npx -w server vitest run test/sync.test.ts   # single file; add -t "<name>" for one test
```

Config comes from the repo-root `.env` (see `.env.example`): `NOTION_TOKEN`, `NOTION_LESSONS_DATABASE_ID`, `MISTRAL_API_KEY`, and optionally `MISTRAL_MODEL`, `PORT` and `DATABASE_PATH` (default `data/tutor.db`, gitignored). Without Notion config the server still starts, sync returns `NOTION_NOT_CONFIGURED`, and already-synced lessons keep working. Without `MISTRAL_API_KEY`, sessions open with a fixed line and turns return `LLM_NOT_CONFIGURED`.

The Mistral free tier gives no quota at all for `mistral-small`/`mistral-medium` on this account (a 429 with `x-ratelimit-limit-req-minute: 0`, mapped to `LLM_MODEL_UNAVAILABLE`), so the default model is `ministral-14b-latest` (30 req/min). The free tier also throws transient 429s without quota headers during bursts. The adapter retries twice with backoff, then returns `LLM_RATE_LIMIT`.

A full first sync of all lessons takes about 2 minutes because of Notion's ~3 req/s limit (one request per block that has children). Re-syncs only re-read lessons whose `last_edited_time` changed.

## Server layout

- `src/notion/gateway.ts` holds the only code that talks to Notion. It throttles requests and maps SDK errors to `AppError` codes with zh-TW guidance (`src/errors.ts`). Tests use `FakeGateway` (`test/fixtures.ts`). Test fixtures are synthetic; never copy real lesson content into the repo.
- `src/notion/markdown.ts` converts blocks to Markdown and collects resources. `src/lessons/sections.ts` splits lessons into sections and maps kinds. `src/lessons/title.ts` parses titles. All three are pure functions.
- `src/lessons/sync.ts` orchestrates sync. Only one sync can run at a time (409 `SYNC_IN_PROGRESS`). `src/lessons/repository.ts` holds the SQLite access and the snapshot merge rules. `src/db.ts` holds the schema as append-only migrations tracked by `PRAGMA user_version`.
- `src/llm/provider.ts` is the vendor-neutral `LlmProvider` interface, and `src/llm/mistral.ts` is the only code that talks to Mistral (fetch, JSON mode, retries, error mapping, one non-sensitive usage log line per call). `src/llm/structured.ts` validates JSON output against a zod schema and retries once with the validation error. Tests use `FakeLlm` (`test/fixtures.ts`).
- `src/lessons/extract.ts` runs the §6.4 extraction **per lesson on demand** (`POST /api/lessons/:id/extract`), not during sync, so a first sync doesn't spend about 150 LLM calls on lessons that are never taught. Until a section is extracted, the teacher works from `sourceMarkdown`. Warm-up is open small talk: it always uses the fixed `WARM_UP_PROMPTS` ("How was your week?" and so on), and the diary in the notes is stored as `referenceAnswers` for the teacher to use as background, never as quiz questions (the user's decision, 2026-10-29). `tidy()` strips Markdown and drops duplicate prompts.
- `src/sessions/controller.ts` is the pure teacher controller. It owns progression (`Progress`: section, question index, follow-ups used, pending Chinese-help phrase). The model only proposes `nextAction`, and `decide()` overrides it: it caps follow-ups and forces an advance, only the student can end early, Chinese help costs no follow-up, and balanced correction allows at most one immediate fix and never grades unverified STT. `src/sessions/prompt.ts` builds the teacher prompt. `src/sessions/engine.ts` runs a turn (LLM → controller → one transaction) and post-processes the reply so it matches the decision: at most about 3 sentences with exactly one question, an advance actually asks the next question, sentence help is always "You can say: … Can you try saying that?", a word request gets "It's <word>.", and there is no Markdown for TTS. Live testing showed that `ministral-14b` follows prompt rules only some of the time, so rules that matter are enforced in code. For example, a mixed-Chinese answer without help, or a word request (`wordRequest()`) answered wrongly, gets one `turn-recheck` call, and overlapping corrections are deduped per session. On an LLM error nothing is saved, so the same `requestId` can be resent.
- `src/lessons/views.ts` holds the student-facing whitelist projections. `GET /api/lessons/:id/sections/:sectionId` is the deliberate exception: it is the full editing view for FR-02.

## What is being built

A single-user AI English tutor website. It teaches from the user's Notion English-lesson pages, read via the **Notion API** (one-way, read-only sync; HTML/Markdown file import is only a P1 fallback), through **turn-based voice conversation**, with a free-first cost model. The first end-to-end acceptance lesson is "A2 基礎會話 c 3/10" (Airport & Travel). That lesson material is private and is deliberately **not** in the repo, so don't commit lesson content without consent.

Planned stack (still to be validated in P0): React + Vite + TypeScript frontend, Node.js + Express backend, SQLite, Mistral LLM behind a provider adapter, browser Web Speech API for STT, and `speechSynthesis` for TTS.

## Architecture (from SRS §5–8)

```
Browser (UI + STT + TTS) ⇄ Node API (config/session/prompt) ⇄ LLM provider adapter → Mistral
                               ⇅ SQLite (lesson snapshots, sessions, settings)
                           Node API → Notion API (sync only, read-only)
```

- **Notion sync (SRS §6):** use `@notionhq/client` with a read-only internal integration token (`NOTION_TOKEN`) and a pinned API version. Pages must be shared with the integration through Connections. Sync walks the block tree recursively, handling pagination and throttling with 429/Retry-After. Headings split the content into Sections, and unsupported blocks become warnings. The result is a SQLite **snapshot**: lessons never call Notion during a turn. Notion page/block IDs are the stable keys, so a re-sync updates the snapshot in place without losing session progress, and sections that disappear are marked `stale`. Notion-hosted file URLs expire, so never persist them. The lesson source is one Notion database ("Language bar", ID in `NOTION_LESSONS_DATABASE_ID`), with one row per lesson. It has no level/topic properties, so metadata is parsed from titles like `A2 基礎會話c 3/10` (level, course, series, unit/total; spacing varies). Rows that don't match, such as `Template`, are skipped with a warning. Sync is incremental by `last_edited_time`. Section splitting is deterministic: each top-level toggleable `heading_1` is one Section, stray top-level blocks join the preceding Section, and empty or title-only template sections are dropped. Section names vary per lesson (including typos like `Gramma`), so map known names to `kind` and fall back to `other`. Never drop content because a name is unknown.
- **Answers are not marked in Notion** (SRS §6, §6.4). Pages are mostly answer keys and personal notes, while the real questions live in the Learning-materials PDF, which P0 doesn't parse. So the whole page (`sourceMarkdown`) is teacher-only and stays on the backend. A one-time LLM extraction per changed section (`sourceHash`) fills `prompts`, `vocabulary`, and `referenceAnswers`. The output is schema-validated, and on failure the lesson falls back to `sourceMarkdown`. Sections the user corrected (`editedByUser`) are never silently overwritten. Student-facing APIs return only a **whitelist**: titles, `prompts`, the vocabulary list, and material links.
- **LLM and Notion only via the backend.** Both API keys live in server env vars (`.env`, gitignored; `.env.example` is allowed) and never in browser JS or exported lesson data. Keep the provider behind an adapter so it can be swapped, because Mistral free-tier limits change.
- **Structured LLM output.** The model returns JSON (`teacherReply`, `intent`, `nextAction`, `lessonSectionId`, `corrections[]`, `assistance{english, zhExplanation}`). The backend validates it against a schema. On invalid output it retries once, then degrades to a plain-text teacher reply. It must never crash the lesson.
- **A teacher controller, not the LLM, owns lesson progression** (follow-up, hint, correct, or advance section). Section state must survive Chinese-assistance detours and errors.
- **Voice state machine (frontend):** `IDLE → TEACHER_SPEAKING → WAITING_FOR_STUDENT → LISTENING → TRANSCRIPT_REVIEW → THINKING → TEACHER_SPEAKING`. The exception states are `MIC_DENIED`, `STT_UNSUPPORTED`, `STT_NO_MATCH`, `NETWORK_ERROR`, `LLM_RATE_LIMIT`, and `TTS_UNAVAILABLE`. Every one must fall back to text input or retry without losing the conversation. Recording is disabled while the teacher speaks. Turn submissions carry a `requestId` for dedup.
- **STT transcripts must be reviewed by the student** (editable, `verifiedByStudent`) before submission. Unverified STT text must not count toward grammar errors. The STT language is an explicit en-US / zh-TW toggle; don't assume mixed-language auto-detection.
- **Data model:** `Lesson → Section` (kind keeps the original Notion headings such as Warm-up, Short Talk, Vocabulary, Conversation, and GROUP ACTIVITY). `Session → Turn → Feedback` (`deferred` flag for after-class corrections). `sourceMarkdown` and `referenceAnswers` must not be returned by student-facing endpoints (`GET /api/lessons/:id`).
- **Rendering safety:** escape Notion content when rendering and allow only http(s) links. The P1 file import must sanitize HTML and guard ZIPs against path traversal and zip bombs.
- **API surface:** `/api/notion/status`, `/api/lessons` (sync, `:id/sync`, list, get, `PUT :id/sections/:sectionId` for corrections; `import` is P1), `/api/sessions` (create, `:id/turns`, `:id/finish`, get), `/api/settings`. See SRS §7.

## Teaching behavior invariants (SRS §4)

- Defaults: `correctionMode: "balanced"`, `speechRate: 1.0`, `teachingLanguage: "english"`, `studentLevel: "A2"`, `locale: "zh-TW"`.
- The teacher speaks English, uses 1–3 sentences, and asks one core question per turn at A2 level.
- **Balanced correction:** correct immediately only errors that block meaning, and only one point at a time before resuming. Defer minor errors to the post-lesson summary. If a possible STT mishearing is suspected, ask the student to confirm instead of grading it.
- **Chinese / code-switch help is not a wrong answer.** Give one natural A2 English phrasing, have TTS read only the English, invite the student to repeat it (skippable), then return to the original question.
- Privacy: store text and corrections only, never raw audio. Don't log full transcripts in application logs.

## Roadmap

The P0 milestones (P0-1 data layer through P0-5 acceptance) are in SRS §12. The MVP is done only when acceptance tests AT-01 to AT-13 (SRS §11) pass. Features tagged P1/P2 are out of scope for P0. New requirements should be tagged P0/P1/P2 with acceptance criteria.
