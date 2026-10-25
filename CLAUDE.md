# Imp: notes for Claude Code

Imp is a mischievous desktop companion for Cal Hacks 13.0 (deadline **Sun Oct 25, 9:00 a.m. PDT**). It listens during a session, remembers the owner's answers, recognizes paraphrased repeat questions, answers aloud with per-person attitude, and gets the owner when something important comes up.

Three people work in parallel, each with their own Claude Code. **Before doing anything, read `docs/WORKSTREAMS.md`.** It says which workstream you're on, which files you own, and what your tasks and acceptance tests are. If you don't know whose session you are, ask the human.

## Commands

| Command | What |
| --- | --- |
| `npm run dev` | Dev server, UI + API on one origin (prints a `localhost:3000/#token=…` link) |
| `npm run check` | **Run before every PR**: typecheck + tests + build |
| `npm test` | Vitest |
| `npm run voice:model` | Prefetch the speaker-verification model |

The server restarts on every save (`tsx watch`). That drops the live mic stream and speaker state, so warn the human before editing server files while they're testing live.

## Architecture (read before changing anything)

- `docs/ARCHITECTURE.md`: the turn pipeline: STT → turn assembly → Moss retrieval → Claude decision → executor → Cartesia.
- `docs/SPEAKER_ID.md`: how the owner and visitors are identified.
- `docs/BUILD_PLAN.md`: the original brief and its revisions; product rules live there.
- Local JSON in `data/` is the source of truth. Moss is only a search index. Provider keys stay server-side.

## Rules

1. **Stay in your workstream's files** (`docs/WORKSTREAMS.md` → File ownership). If you need a change elsewhere, make the smallest additive change possible and call it out in the PR under "Touches other areas".
2. **Shared contracts** (`shared/schemas.ts`, `shared/events.ts`): additive changes only (new optional fields, new types). Never rename or remove a field another stream uses.
3. **Branch per task**: `<name>/<task-id>-<slug>`, e.g. `ritvik/R1-demo-mode`. Never commit to `main` directly; open a PR. Preston merges.
4. **Before opening a PR**: `git pull origin main` (rebase or merge), then `npm run check` must pass. Paste its summary into the PR. CI can't run right now (GitHub billing), so this local check is the gate.
5. **Tests**: add or extend tests for logic you change. `tests/session.test.ts` shows how to test the pipeline with a scripted decider and a fake index, with no network.
6. **Never commit secrets.** `.env` and `data/` are gitignored; keep it that way. Don't print key values.
7. **Product guardrails** (non-negotiable, from the build plan): only the owner (verified, or confirmed in the UI) can teach facts or change people. Approval or commit requests always escalate. Roasts target behavior; no slurs and nothing about appearance, race, gender, sexuality, religion, disability or health. Never present manual identity as automatic.
8. Keep `docs/PROGRESS.md` honest: mark what you finished and what you verified live versus only in tests.

## Setup on a new machine

```bash
npm install
cp .env.example .env    # get key values from Preston directly, never through the repo
npm run dev
```
