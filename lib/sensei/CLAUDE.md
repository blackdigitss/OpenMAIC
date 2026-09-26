# Sensei: notes for Claude Code sessions working on this code

Sensei is a personal respiratory-therapy study companion built as new files inside an
OpenMAIC fork (branch `sensei`). Keep OpenMAIC core files untouched unless there is no
other way; Sensei code lives in `lib/sensei`, `components/sensei`, `app/sensei`,
`app/api/sensei`, `scripts/sensei`, `tests/sensei`.

## The user
- One student, iPhone/iPad only, expects native-iOS quality. Accuracy of study content is the top priority.
- Cost-aware: no paid-API test runs without stating the cost first; cheapest adequate model for mechanical work.
- Does not want continuous CPU load on the 2013 iMac that hosts everything.

## Where AI work runs (see `sensei.env`, `lib/sensei/llm.ts`)
- Model routes are `provider:model` lists tried in order: `claude:<alias>` (Claude subscription via the
  Claude Code CLI, lean flags), then `google:` / `openai:` API backups.
- strong = `claude:opus` (facts, flashcards, drills, textbook notes, transcript proofreading, scanned slides);
  fast = `claude:sonnet` (titles, tags, in-app answers).
- Audio follows Settings → Audio processing (`audioEngine`, default `local`), with the other engine as automatic
  backup and Gemini last:
  - local: whisper.cpp large-v3-turbo transcribes on the Mac (CPU heavy, accepted by the user for audio), Kokoro
    voices lesson narration (`com.sensei.voice`, 127.0.0.1:13305).
  - cloud: OpenAI `whisper-1` (words + segments) and OpenAI `gpt-4o-mini-tts` through the same voice service.
  - Either way the strong model proofreads transcripts against the slides.
- Lessons: OpenMAIC generation → `com.sensei.bridge` (OpenAI-compatible, 127.0.0.1:3002) → Claude. Narration goes
  through OpenMAIC's Lemonade TTS provider pointed at `com.sensei.voice`.
- Every call starts from the standing brief in `lib/sensei/brief.ts`. Change agent behavior there, and bump `BRIEF_VERSION`.

## Content rules the code enforces
- Slides are the backbone, class audio adds emphasis and context, and Egan's is ground truth for details. Never
  overwrite course facts with the textbook; show disagreements.
- Every generated item (card, drill, practice question, gap note) must cite the facts it came from, or it is dropped.
- Numbers are checked against their source (`normalize.ts` fidelity checks); unverified numbers never become answers.
- Knowledge is append-only with supersede-on-rerun; ids are content keys so re-runs are idempotent.

## Major changes (newest first). Add an entry for anything that changes architecture, data flow or where work runs.
- 2026-09-26: lessons taught by the professor (first person, present tense, knowing asides, the professor's own
  quotes as VOICE SAMPLES) and tied to Sensei (exam timing, NBRC tasks, drills, calcs, textbook disagreements,
  what to do next); `agentMode: 'generate'` for English classmates. Voice service (`voice-server.py`) now also does
  speech-to-text for the lesson mic (ElevenLabs Scribe → local whisper → OpenAI) and a Lesson voice setting
  (Kokoro / ElevenLabs for the professor only, credit reserve 10% / OpenAI). In-lesson chat uses OpenMAIC's legacy
  tool-less `/api/chat` (`NEXT_PUBLIC_PI_CHAT_ENABLED=false`, build time) because the Claude bridge has no tool calls;
  browser speech is disabled (`TTS_/ASR_BROWSER_NATIVE_ENABLED=false`) so the client uses the voice service.
- 2026-09-25: lesson narration served correctly (OPENMAIC_CLASSROOMS_DIR real path); existing lessons narrated.
- 2026-09-25: audio engine setting (local Whisper + Kokoro by default, OpenAI as backup or by choice); lessons on
  request (`POST /lesson/<lectureId>`, Library → Lessons tab, "Make a lesson" on any lecture or deck).
- 2026-09-25: codebase-memory-mcp code graph + ADR; standing agent brief (`brief.ts`); per-clip saved reel audio.
- 2026-09-25: Claude subscription for every text step (bridge for lessons); lab drills; re-transcribe command.
- 2026-09-24: model routing with provider fallback; scanned-slide reading; billing-aware job retries.

## Working conventions
- Every change goes through a PR on `blackdigitss/OpenMAIC` with base `sensei` (`gh` defaults to upstream; the
  worktree has `gh repo set-default blackdigitss/OpenMAIC`). Commit bodies explain why.
- Before merging, run: `npx tsc --noEmit -p tsconfig.json` (the production build type-checks tests too),
  `npx eslint` on Sensei paths, and `npx vitest run tests/sensei --testTimeout 60000 --hookTimeout 60000`.
- Deploy with `zsh scripts/sensei/ops/update.sh` (refuses while a lecture is processing; verifies the live app and
  rolls back). The `sensei` branch has Vercel deployments disabled; don't push branches that lack that.
- Migrations: append to `lib/sensei/db/migrations.ts` (numbered, additive).
- `OPENMAIC_CLASSROOMS_DIR` in sensei.env must be the real path of `Library/openmaic-data/classrooms`: each slot's
  `data/` is a link into Library, and OpenMAIC's media route rejects files whose real path differs (lesson audio and
  images would 404).

## Code knowledge graph (codebase-memory-mcp)
- This repo is indexed by the `codebase-memory` MCP server (installed for Claude Code, 2026-09-25). Prefer its
  tools (search_graph, trace_path, get_architecture, impact analysis) over file-by-file grep/read to understand
  structure, callers and the blast radius of a change.
- Its Architecture Decision Record (`manage_adr`) holds Sensei's purpose, architecture, patterns and trade-offs.
  Read it before architectural changes, and update it when a decision changes.
- Indexing runs at session start (auto_index); the background watcher is off on purpose (no constant load on the
  iMac). Re-index after large changes: `codebase-memory-mcp cli index_repository '{"repo_path":"<repo>"}'`.
