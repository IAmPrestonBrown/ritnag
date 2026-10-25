# Imp

> You answer once. Your imp handles the next interruption, with your memory and its own attitude.

A mischievous desktop companion for Cal Hacks 13.0. It listens during a session you start, remembers your answers, recognizes paraphrased repeat questions, answers them aloud in a tone you chose for each person, and gets you when something important comes up that it can't answer.

**Stack:** React + Vite · Node/Express + `ws` · Deepgram (STT + diarization) · **Moss** (semantic retrieval) · Claude (judgment + wording) · **Cartesia** (voice) · local JSON (source of truth).

## Run

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev
```

Open the `http://localhost:3000/#token=…` link the server prints. The token is stored in your browser after the first visit.

| Command | |
| --- | --- |
| `npm run dev` | Dev server with Vite middleware (one origin) |
| `npm test` | Session/pipeline tests |
| `npm run typecheck` | TypeScript |
| `npm run build && npm start` | Production build served by Node |

Data lives in `data/` (gitignored): `imp-memory.json` is the authoritative store, and `workspace-token` holds the browser access token.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Build plan](docs/BUILD_PLAN.md)
- [Progress](docs/PROGRESS.md)
- [Demo script](docs/DEMO.md)
- [Speaker identification design](docs/SPEAKER_ID.md)
- [Cal Hacks notes + sponsor evidence](docs/CALHACKS.md)
