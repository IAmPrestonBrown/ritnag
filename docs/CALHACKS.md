# Cal Hacks 13.0 notes

Verified 2026-10-24. Re-check organizer announcements before submitting.

## Event

- Cal Hacks 13.0. In person at the Palace of Fine Arts, San Francisco, Oct 23–25, 2026.
- **Deadline: Sunday Oct 25, 9:00 a.m. PDT** (Devpost header; some body text says PST, so use SF local time and confirm).
- Requirements: arrive at the venue by 8 a.m., a project image, a code repo, work done during the event, and a demo.
- Pitch is 3 min plus 2 min Q&A. Include a video, because some sponsors judge asynchronously. [E1, E2, E4]
- Judging covers practical value, intentional design, working behavior, originality, and engineering depth. [E1]
- Teams informally report sponsors stressing impact, ambition, and "physical AI". Those are informal and unpublished, and this project isn't robotics, so don't claim that category.

## Sponsor decisions (revised 2026-10-24)

| Sponsor | Status | Real integration | Code | Demo evidence |
| --- | --- | --- | --- | --- |
| **Moss** | Primary | Semantic retrieval over saved questions/answers/facts. Stable memory ids shared with local store. In-process `SessionIndex`, cloud push, rebuild-from-local | `server/providers/moss.ts`, `Session.retrieve()` in `server/session.ts` | Paraphrased question → correct memory; the decision line shows "Moss N hits" with cited id highlighted; Moss status pill + Rebuild index |
| **Cartesia** | Primary | All spoken responses (`/tts/bytes`, sonic-3.6) | `server/providers/cartesia.ts`, `src/audio/playback.ts` | Same fact, different person → different delivery |
| Anthropic | Used (category fit weaker) | Relevance/freshness judgment, routing, learning, wording | `server/decision.ts`, `server/providers/claude.ts` | Escalates "approve the rollback"; refuses to answer without support |
| Deepgram | Technical choice, not a known sponsor | Live STT + diarization | `server/audioRelay.ts`, `server/providers/deepgram.ts`, `server/turnAssembler.ts` | Speaker labels in transcript; `npm run smoke:voice` |
| Convex | **Dropped** | None. Don't claim it | — | — |

Anthropic's category is "Claude for Public Benefit". The implementation fits, but the theme fit for a comedy imp is weak. Don't invent an accessibility angle.

Not pursued: SpacetimeDB, Gemini, Elastic, Fetch.ai, Factory, Apify, Bright Data, fintech/crypto sponsors, infra sponsors. Sponsor presence alone doesn't make us eligible, so record only real usage.

## Sponsor roster (for reference)

- Anchor: Anthropic, Annapurna Labs/AWS, SpacetimeDB, Hyphenate.
- Golden Bear: Microsoft, Visa, Fetch.ai, Supercell.
- Silver: Moss, Bright Data, AfterQuery, Meta, SpaceX, CRS, Factory, Convex, Cartesia, CREAO, Elastic, Apify, Armadin, Bitdeer AI, Moonpay, Capital One. [E3]
- Also on the prize listing: Gemini/Google, Solana, Tiger Data, Vultr, Commit Fellowship/Transcend Network, Snowflake, GoDaddy Registry, Figma, Coinbase, Notability, Mana, Atlassian, SpaceXSI. [E1, E4]

Before submitting to a category, read its full instructions and current judging process.

## Submission checklist

- [~] Working local app; README setup commands verified on a clean checkout. *`npm ci` + `npm run check` + `npm run dev` from a fresh worktree on 2026-10-24 (typed + synthetic voice paths work). Still needs the live mic run.*
- [~] `.env.example` has names only; no secrets in the repo, the video, or screenshots (the server prints the workspace token, so crop it out). *Repo side checked 2026-10-24: every key/id in `.env.example` is empty and a grep for key patterns finds nothing. Video and screenshots still to check.*
- [ ] `docs/BUILD_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/CALHACKS.md`, `docs/PROGRESS.md`, `docs/DEMO.md` current
- [x] Project image: `assets/ritnag-cover.png` (1500×1000, 3:2), source `assets/cover.html`
- [ ] Repo link (public or shared with judges). *The repo is **private** as of 2026-10-24: make it public or add judges before submitting. Owner decision.*
- [ ] Short video of real behavior (live learning, recall, escalation)
- [~] Devpost text: the interruption problem, who uses it, what we built, architecture, real Moss/Cartesia usage with code paths, limitations, and what was built during the event. *Drafted in `docs/DEVPOST.md`; two lines marked **[update after rehearsal]**.*
- [ ] Honest split between live behavior, seeded facts, manual corrections, and future work
- [ ] Moss + Cartesia prize categories entered, instructions re-read
- [ ] At venue by 8 a.m. Sunday

## Sources

- [E1] https://cal-hacks-13-0.devpost.com/
- [E2] https://cal-hacks-13-0.devpost.com/rules
- [E3] https://www.linkedin.com/company/cal-hacks
- [E4] https://www.mlh.com/events/cal-hacks-13-0
- Event site: https://www.calhacks.io/ · On-site: https://hive.hackberkeley.org/prizes
