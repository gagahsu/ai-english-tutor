# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Spec-only. No application code, `package.json`, build, lint, or test tooling exists yet. The source of truth is `docs/SRS.md` (Traditional Chinese); `README.md` summarizes it. When implementation starts, add the real commands to this file. Project docs are written in Traditional Chinese (zh-TW), so keep new user-facing docs in that language unless asked otherwise.

## What is being built

A single-user AI English tutor website. It teaches from the user's Notion English-lesson exports (HTML/Markdown, optionally ZIP) through **turn-based voice conversation**, with a free-first cost model. The first end-to-end acceptance lesson is "A2 基礎會話 c 3/10" (Airport & Travel). That lesson material is private and is deliberately **not** in the repo, so don't commit lesson content without consent.

Planned stack (still to be validated in P0): React + Vite + TypeScript frontend, Node.js + Express backend, SQLite, Mistral LLM behind a provider adapter, browser Web Speech API for STT, and `speechSynthesis` for TTS.

## Architecture (from SRS §5–8)

```
Browser (UI + STT + TTS) ⇄ Node API (config/session/prompt) ⇄ LLM provider adapter → Mistral
                               ⇅ SQLite + imported lesson assets
```

- **LLM only via the backend.** The API key lives in server env vars (`.env`, gitignored; `.env.example` is allowed) and never in browser JS or exported lesson data. Keep the provider behind an adapter so it can be swapped, because Mistral free-tier limits change.
- **Structured LLM output.** The model returns JSON (`teacherReply`, `intent`, `nextAction`, `lessonSectionId`, `corrections[]`, `assistance{english, zhExplanation}`). The backend validates it against a schema. On invalid output it retries once, then degrades to a plain-text teacher reply. It must never crash the lesson.
- **A teacher controller, not the LLM, owns lesson progression** (follow-up, hint, correct, or advance section). Section state must survive Chinese-assistance detours and errors.
- **Voice state machine (frontend):** `IDLE → TEACHER_SPEAKING → WAITING_FOR_STUDENT → LISTENING → TRANSCRIPT_REVIEW → THINKING → TEACHER_SPEAKING`. The exception states are `MIC_DENIED`, `STT_UNSUPPORTED`, `STT_NO_MATCH`, `NETWORK_ERROR`, `LLM_RATE_LIMIT`, and `TTS_UNAVAILABLE`. Every one must fall back to text input or retry without losing the conversation. Recording is disabled while the teacher speaks. Turn submissions carry a `requestId` for dedup.
- **STT transcripts must be reviewed by the student** (editable, `verifiedByStudent`) before submission. Unverified STT text must not count toward grammar errors. The STT language is an explicit en-US / zh-TW toggle; don't assume mixed-language auto-detection.
- **Data model:** `Lesson → Section` (kind keeps the original Notion headings such as Warm-up, Short Talk, Vocabulary, Conversation, and GROUP ACTIVITY). `Session → Turn → Feedback` (`deferred` flag for after-class corrections). `referenceAnswers` are stored separately and must not be returned by student-facing endpoints (`GET /api/lessons/:id`).
- **Import safety:** sanitize HTML by removing scripts, event handlers, and dangerous links. ZIP imports must guard against path traversal and zip bombs. Enforce size limits.
- **API surface:** `/api/lessons` (import, list, get), `/api/sessions` (create, `:id/turns`, `:id/finish`, get), `/api/settings`. See SRS §7.

## Teaching behavior invariants (SRS §4)

- Defaults: `correctionMode: "balanced"`, `speechRate: 1.0`, `teachingLanguage: "english"`, `studentLevel: "A2"`, `locale: "zh-TW"`.
- The teacher speaks English, uses 1–3 sentences, and asks one core question per turn at A2 level.
- **Balanced correction:** correct immediately only errors that block meaning, and only one point at a time before resuming. Defer minor errors to the post-lesson summary. If a possible STT mishearing is suspected, ask the student to confirm instead of grading it.
- **Chinese / code-switch help is not a wrong answer.** Give one natural A2 English phrasing, have TTS read only the English, invite the student to repeat it (skippable), then return to the original question.
- Privacy: store text and corrections only, never raw audio. Don't log full transcripts in application logs.

## Roadmap

The P0 milestones (P0-1 data layer through P0-5 acceptance) are in SRS §12. The MVP is done only when acceptance tests AT-01 to AT-12 (SRS §11) pass. Features tagged P1/P2 are out of scope for P0. New requirements should be tagged P0/P1/P2 with acceptance criteria.
