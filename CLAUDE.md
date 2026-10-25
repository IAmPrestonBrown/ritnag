# Imp: notes for Claude Code

Imp is a mischievous desktop companion for Cal Hacks 13.0 (deadline **Sun Oct 25, 9:00 a.m. PDT**). It listens during a session, remembers the owner's answers, recognizes paraphrased repeat questions, answers aloud with per-person attitude, and gets the owner when something important comes up.

The team is speed-running the finish: small, working changes, merged quickly. Pull `main` before starting, and keep changes focused.

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

1. **Before pushing**: `git pull origin main`, then `npm run check` must pass. CI can't run right now (GitHub billing), so this local check is the gate.
2. **Shared contracts** (`shared/schemas.ts`, `shared/events.ts`): additive changes only. Don't rename or remove fields other code uses.
3. **Tests**: extend tests for logic you change. `tests/session.test.ts` shows how to test the pipeline with a scripted decider and a fake index, with no network.
4. **Never commit secrets.** `.env` and `data/` are gitignored; keep it that way. Don't print key values.
5. **Product guardrails** (non-negotiable, from the build plan): only the owner (verified, or confirmed in the UI) can teach facts or change people. Approval or commit requests always escalate. Roasts target behavior; no slurs and nothing about appearance, race, gender, sexuality, religion, disability or health. Never present manual identity as automatic.
6. Keep `docs/PROGRESS.md` honest: what works, what was verified live versus only in tests.

## Setup on a new machine

```bash
npm install
cp .env.example .env    # get key values from Preston directly, never through the repo
npm run dev
```
