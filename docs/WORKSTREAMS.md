# Workstreams

Three parallel streams, one owner each, merged at the end. Each task has an ID, files, acceptance criteria and a test, so a Claude Code session can pick it up cold. Every task also has a GitHub issue (label `stream:<name>`); comment progress there.

| Stream | Owner | GitHub | Focus |
| --- | --- | --- | --- |
| **Ears**: transcription + speaker identity | Preston | `IAmPrestonBrown` | Hardest: live audio, providers, who's speaking |
| **Face**: UI, avatar, demo UX | Ritvik | `RCSharm07` | Everything the audience sees |
| **Voice & Story**: personality + submission | Leon | `lkhoshnevis` | What the imp says, plus everything we hand the judges |

Preston also reviews and merges all PRs and runs the final integration.

## Timeline (Sat Oct 24 → Sun Oct 25, PDT)

| Time | Milestone |
| --- | --- |
| **9:00 p.m.** | Each person has a branch, their first task started, and `npm run check` green locally |
| **11:30 p.m.** | First PR from each stream merged (each stream's task 1) |
| **1:30 a.m.** | **Feature freeze.** Everything that's going in is merged to `main` |
| 1:30–3:00 a.m. | Integration fixes on `main` (Preston), full demo run-through |
| 3:00–5:00 a.m. | Rehearsals with the real mic and speaker; bug fixes only |
| **6:00 a.m.** | Demo video recorded |
| **7:00 a.m.** | Devpost submitted (deadline 9:00; arrive at the venue by 8:00) |

Anything not merged by the freeze waits for "future work" in the Devpost.

## File ownership

Edit freely inside your area. Outside it, follow the "Touches other areas" rule in `CLAUDE.md`.

| Area | Owner |
| --- | --- |
| `server/audioRelay.ts`, `server/turnAssembler.ts`, `server/providers/deepgram.ts`, new `server/providers/speechmatics.ts`, `server/voice/**`, `src/audio/**`, `src/components/VoiceOnboarding.tsx`, `src/components/MicPicker.tsx`, `src/components/RecordClips.tsx`, `tests/voice.test.ts`, `tests/recordings.test.ts`, `tests/turnAssembler.test.ts`, `scripts/bakeoff/**` | **Preston** |
| `src/App.tsx`, `src/components/**` (except the two above), `src/styles.css`, `src/main.tsx`, `index.html`, new `tests/ui/**` | **Ritvik** |
| `server/decision.ts` (prompt text and `buildUserMessage`), `server/providers/cartesia.ts` (delivery table only), new `eval/**`, new `scripts/seed.ts`, `docs/DEVPOST.md`, `docs/DEMO.md`, `docs/CALHACKS.md`, new `assets/**` | **Leon** |
| **Shared hot spots** (`shared/*.ts`, `server/session.ts`, `server/executor.ts`, `server/index.ts`, `package.json`): small additive changes only, called out in the PR. Preston reviews these closely. | everyone |

Docs everyone may append to: `docs/PROGRESS.md` (your own lines), `README.md` (commands for things you add).

---

## Ears (Preston)

### P1: Speaker-ID bake-off
Per-turn embeddings on one laptop mic don't separate the owner from teammates: live scores overlap (owner 0.45–0.81, Leon 0.57–0.70). Measure the candidates on real recordings before switching.
- **Do:** a dev-only "record test clip" control (`src/audio/`, `src/components/VoiceOnboarding.tsx`) that saves WAVs to `data/recordings/`. Then `scripts/bakeoff/` runs the same recordings through (a) the current sherpa verifier, (b) Speechmatics realtime speaker ID, and (c) Picovoice Eagle if a key is available, and prints accuracy per speaker.
- **Accept:** a table in `docs/SPEAKER_ID.md` showing correct-speaker rate on about 2 minutes of natural owner+Leon conversation recorded on the demo mic, plus a decision.
- **Test:** `npx tsx scripts/bakeoff/run.ts data/recordings/<set>`.

### P2: Speechmatics realtime provider (if P1 says so)
- **Do:** put Deepgram and Speechmatics behind one interface (`STT_PROVIDER=deepgram|speechmatics`) producing the same `AssembledTurn` stream into `Session.ingest`. Map enrolled-speaker labels to `speakerLabel` and set the owner from the enrolled `owner` label.
- **Accept:** a live run where one spoken question gets exactly one answer, with no feedback loop. Owner turns are attributed correctly in the P1 conversation set at the rate P1 measured.
- **Test:** unit tests that replay recorded Speechmatics messages (fixtures in `tests/fixtures/`) through the mapper; `npm run check`.

### P3: Enrolled visitors
- **Do:** enroll teammates (Bob/Leon/Maya…) as known speakers, so visitor names bind automatically. Mark them as voice-identified, distinct from manual binding in the UI.
- **Accept:** in a live run, an enrolled teammate's repeat question is answered with their name and tone, with no manual binding.

### P4: Echo check
- **Accept:** a test or recorded proof that the imp's own TTS playback never becomes an owner turn and never reaches the decider.

---

## Face (Ritvik)

Work entirely in the browser UI. Run `npm run dev`, open the printed link, and use the **typed input drawer** at the bottom to drive any scenario without a mic.

### R1: Demo mode
- **Do:** `?demo=1` (and a keyboard toggle, e.g. `D`) hides the debug drawer, provider pills and other technical clutter. It enlarges the imp and the caption for a projector, and keeps only the panels the demo script needs (memory, people, alerts).
- **Accept:** readable from 4 m away on a 1080p projector, with no layout overflow at 1280×720 or 1920×1080. Leaving demo mode restores the normal view.
- **Test:** `npm run check`, plus a screenshot of each mode in the PR.

### R2: Avatar polish
- **Do:** drive the mouth from real playback **amplitude** (Web Audio `AnalyserNode` on the `<audio>` element in `src/audio/playback.ts`; that file is Preston's area, so keep the change to exposing the element or analyser). Give each state (idle, listening, thinking, speaking, alert, error) a distinct look; add a "savage" face (narrowed eyes, smirk) when the reply tone is savage or annoyed. `speech.ready` carries `tone`.
- **Accept:** the mouth visibly tracks speech loudness, and states change on real pipeline events, not timers. `prefers-reduced-motion` is still respected.
- **Test:** unit-test the amplitude→mouth-openness mapping (pure function); manual check with **Test voice**.

### R3: Receipts
- **Do:** when the imp answers, show *why*: who asked, the cited memory card (from `decision.completed.memoryIds`), the Moss hit score, and the person's repeat count ticking up with an animation. Alerts get a distinct accent and stay visible until acknowledged.
- **Accept:** from the typed Bob scenario in `docs/DEMO.md`, a viewer can tell from the screen alone what was learned, what was recalled, and why it escalated.

### R4: Perceived speed
- **Do:** a mic level meter while listening; show the live partial transcript prominently; when a question finishes, show an immediate "thinking" caption or animation before the answer arrives.
- **Accept:** there's never more than about 300 ms of frozen UI after someone stops talking.

---

## Voice & Story (Leon)

Mostly prompt writing and docs, with Claude Code doing the coding. Your tests run with no mic: they call Claude directly with scripted scenarios.

### L1: Personality eval harness (do this first)
- **Do:** `npm run eval` runs about 20 scripted scenarios from `eval/scenarios.json` (person, tone, times asked, memory, question) through the real decision path (`claudeDecide(SYSTEM_PROMPT, buildUserMessage(ctx))`, see `server/decision.ts`). It prints each spoken line and **automatically checks the hard rules**:
  - the spoken line contains the stored fact;
  - at most 2 sentences;
  - no speaker labels (`spk1`, `guest-A`);
  - no words from a banned-slur list;
  - approval/deploy requests come back as `ALERT_OWNER`;
  - unknown questions never get an invented answer.

  It exits non-zero if any rule fails.
- **Accept:** `npm run eval` runs end to end and prints a pass/fail table plus all lines. The README documents how to add a scenario.
- **Test:** the eval itself. Keep the pure rule-checker functions under `eval/` with a unit test in `tests/eval.test.ts`.

### L2: Make it funny (prompt tuning)
- **Do:** tune the tone section of `SYSTEM_PROMPT` in `server/decision.ts` and the delivery table in `server/providers/cartesia.ts` until savage, sarcastic and annoyed lines are genuinely funny, varied, escalate with repeats, and still pass every L1 rule. Don't change the decision rules or the field definitions; those are product logic.
- **Accept:** `npm run eval` passes. Include the before/after lines for 5 scenarios in the PR.

### L3: Demo seed + reset
- **Do:** `npm run demo:seed` resets local data and loads a known starting state (people with tones, 2–3 clearly seeded memories) for rehearsals, per the "tell the audience what's preloaded" rule. Use the existing store API (`server/memory.ts`); don't edit that file.
- **Accept:** a seed, then the demo script in `docs/DEMO.md` runs from a clean, predictable state. `docs/DEMO.md` lists exactly what's seeded.

### L4: Submission package
- **Do:**
  - `docs/DEVPOST.md`: the full Devpost text (problem, who it's for, what we built, architecture, **real sponsor usage with code paths** for Moss, Cartesia and Anthropic, limitations, what was built during the event).
  - A project image in `assets/`.
  - A 3-minute video shot list in `docs/DEMO.md`.
  - The `docs/CALHACKS.md` checklist kept current.
- **Accept:** Preston can paste `docs/DEVPOST.md` into Devpost unchanged. Every sponsor claim points to a real file.

---

## Integration rules of thumb

- Small PRs, early. A PR with one task is easy to merge at 1 a.m.; a PR with four is not.
- If your task needs something from another stream, put it in your issue as a "needs" comment and stub it behind a feature check.
- Conflicts in shared hot spots: whoever merges second resolves them, and `npm run check` must pass after the merge.
