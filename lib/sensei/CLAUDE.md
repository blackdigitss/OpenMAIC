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
- Audio: OpenAI `whisper-1` in the cloud (words + segments), proofread by the strong model; Gemini as backup;
  local whisper.cpp only with `SENSEI_LOCAL_AUDIO=1`.
- Lessons: OpenMAIC generation → `com.sensei.bridge` (OpenAI-compatible, 127.0.0.1:3002) → Claude.
  Narration: OpenMAIC's OpenAI TTS (`TTS_OPENAI_API_KEY`); local Kokoro only with `SENSEI_LOCAL_VOICE=1`.
- Every call starts from the standing brief in `lib/sensei/brief.ts`. Change agent behavior there, and bump `BRIEF_VERSION`.

## Content rules the code enforces
- Slides are the backbone, class audio adds emphasis and context, and Egan's is ground truth for details. Never
  overwrite course facts with the textbook; show disagreements.
- Every generated item (card, drill, practice question, gap note) must cite the facts it came from, or it is dropped.
- Numbers are checked against their source (`normalize.ts` fidelity checks); unverified numbers never become answers.
- Knowledge is append-only with supersede-on-rerun; ids are content keys so re-runs are idempotent.

## Working conventions
- Every change goes through a PR on `blackdigitss/OpenMAIC` with base `sensei` (`gh` defaults to upstream; the
  worktree has `gh repo set-default blackdigitss/OpenMAIC`). Commit bodies explain why.
- Before merging, run: `npx tsc --noEmit -p tsconfig.json` (the production build type-checks tests too),
  `npx eslint` on Sensei paths, and `npx vitest run tests/sensei --testTimeout 60000 --hookTimeout 60000`.
- Deploy with `zsh scripts/sensei/ops/update.sh` (refuses while a lecture is processing; verifies the live app and
  rolls back). The `sensei` branch has Vercel deployments disabled; don't push branches that lack that.
- Migrations: append to `lib/sensei/db/migrations.ts` (numbered, additive).

## Code knowledge graph (codebase-memory-mcp)
- This repo is indexed by the `codebase-memory` MCP server (installed for Claude Code, 2026-09-25). Prefer its
  tools (search_graph, trace_path, get_architecture, impact analysis) over file-by-file grep/read to understand
  structure, callers and the blast radius of a change.
- Its Architecture Decision Record (`manage_adr`) holds Sensei's purpose, architecture, patterns and trade-offs.
  Read it before architectural changes, and update it when a decision changes.
- Indexing runs at session start (auto_index); the background watcher is off on purpose (no constant load on the
  iMac). Re-index after large changes: `codebase-memory-mcp cli index_repository '{"repo_path":"<repo>"}'`.
