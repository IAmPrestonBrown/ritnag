# Progress

_Last updated 2026-10-24._

## Works now (verified)

- Repo scaffold: Vite + React UI served through the Express dev server on one origin. `npm run typecheck`, `npm test` (61 tests), and `npm run build` all pass.
- Typed-input pipeline (`POST /api/turn`) using the same session pipeline speech will use.
- Session logic covered by tests with a scripted decider and a fake index:
  - Replayed provider events don't answer or count twice.
  - The owner's reply is learned and indexed. Guest assertions and unanswered questions are not learned.
  - "That was Bob" binds the earlier guest, not the owner. Bob's paraphrase is then answered by name.
  - A new STT connection clears label bindings.
  - An answer citing a memory that wasn't retrieved escalates instead of speaking.
  - Moss hits that resolve to superseded or deleted records are dropped. Moss being down is reported as `unavailable`.
  - Speech captured while the imp talks is dropped (half-duplex).
  - Stale responses and decisions after Reset can't play or write.
- Server smoke test without keys: health reports missing providers, `/api` returns 401 without the token, teach persists to local JSON, and the UI is served.
- UI: SVG imp with idle/listening/thinking/speaking/alert/error states, caption, memory panel (cited memory highlighted, sources, times asked), people panel (tone and priority editable, per-person repeat count), transcript, alerts with acknowledge, focus mode, stop speaking, reset (with confirm), typed input, manual speaker correction, teach answer, Moss status pill, and a Rebuild index button.

- **Headphones mode** (tests + build only, not yet tried with real devices): a **voice out** picker in the header sends the imp's voice to a chosen output (`setSinkId`, Chrome/Edge), e.g. the laptop speakers, so a visitor hears it while the owner wears headphones. Alerts (chime + system notification, `src/notify.ts`) stay on the system default output, i.e. the owner's headphones. Falls back to the default if the chosen output disappears. Works with Bluetooth headphones; wired headphones disable the Mac's built-in speakers, so use a USB/Bluetooth desk speaker.

## Verified against real providers (2026-10-24, typed input)

Bob scenario run end to end on real **Claude + Moss**:
- Guest asks → `WAIT`. Owner answers → `LEARN`, then the memory is indexed in Moss and pushed to the cloud.
- "That was Bob… be sarcastic" → Bob created, tone sarcastic, bound to the guest label.
- Bob's paraphrase "Is the frontend code up yet?" → Moss hit → `ANSWER` citing the memory, sarcastic, fact intact. Repeat counts increment per person and per memory.
- "Can you approve the production rollback?" → `ALERT_OWNER`. "What's the wifi password?" (unknown) → `WAIT`, nothing invented.
- Decision latency: **Opus 5.5 ~2.2–3.1 s**, **Haiku 5.5 ~1.4–3.0 s** (same decisions; set `ANTHROPIC_MODEL`).
- **Cartesia** `/tts/bytes` verified: 0.6–0.9 s per line (sample voices rendered: Henry, Archie, Lauren).

Fixed during the run: the boot-time Moss build (first run downloads the embedding model) raced the first memory write, and pushing an empty index is rejected by Moss. Writes and queries now wait for the build, and empty pushes are skipped.

Not yet verified: browser playback with real start/end events, and anything Deepgram (no key yet).

**Needed:** `CARTESIA_VOICE_ID` (pick a voice), `DEEPGRAM_API_KEY`.

## Next milestone: Slice 2 exit

One spoken question triggers exactly one audible answer, with no feedback loop. Mic code is written and unit-tested (assembler and calibration) and waits on the Deepgram key.

## Demo status (2026-10-24, late evening)

- **Projector demo mode** (D / `?demo=1`) with plain-English "why" lines under the caption.
- **The full demo script in `docs/DEMO.md` passes end to end, 3/3 runs, in demo mode** (typed turns; real Claude, Moss and Cartesia; isolated data): learn → "That's Bob… talk to him like he's five" → a meeting fact said to the room is learned → Bob's question about it is answered from memory → repeat called out → priority teammate's rollback escalates.
- Fixed tonight: owner announcements to others ("CC me on all outreach emails") were ignored as "talking to someone else"; **Reset demo could crash the server** (Moss push timer touching a closed index).
- Live-mic speaker ID remains the risk; recover with "that was me" / "who just spoke" and say so.

## Feature gaps closed (2026-10-24, night)

- **"You asked me that last week"**: Claude now gets when this person last asked each memory, already in words ("yesterday", "last week"), and the prompt says to use it rather than guess. Tested with a scripted clock; not yet heard from real Claude.
- **Flirty tone** (PG, nothing about looks) in the People panel, the prompt, and Cartesia delivery (`flirtatious`). Tested in code; not yet heard from real Claude or Cartesia.
- **Most asked** list (asked 2+ times, top 5) at the top of the Memory panel. Checked in a browser with seeded data.
- **Alert chime + system notification** when something escalates, so a focused owner in headphones hears it. Notification permission is asked when focus mode or the mic is turned on. Message text is unit-tested; the chime and notification haven't been triggered by a real alert in a browser yet.
- Still open: priority people only weigh importance through the prompt; the executor doesn't enforce them.

## Demo video tooling (2026-10-25)

- Pop-up notices (new person, new question, answer repeated, "X detected"): unit-tested; seen in the browser
  against the dev server.
- Director mode ([DIRECTOR.md](DIRECTOR.md)): every on-screen element scriptable via a timeline, `window.ritnag`,
  `POST /api/director` or `npm run director`. Unit-tested. The example timeline was played end to end with the CLI
  on a headless page, with screenshots checked and status polled. Real-voice (`voice: true`) lines were checked only in the earlier
  manual-cue run, not in a timeline recording.

## Demo-video behaviors made real (2026-10-25)

Every beat of `docs/director/demo-1024.json` now happens in the real pipeline: "who was that?", naming + learning
in one owner turn, focus-mode answers right after the owner spoke, confirmed speakers addressed by name, visitor
voiceprints recognized in a later session, keys-style questions relayed as alerts and cleared by the owner's
answer, and the spoken day report. Verified: unit tests, plus a spoken two-session rehearsal through the real mic
WebSocket, Speechmatics, Claude Haiku and Cartesia with macOS synthetic voices (not real people). The last two
prompt tweaks ("I hate him" → savage; the report treats handled alerts as done) are unit-tested only.

## Demo-day hardening (2026-10-25, early morning)

Operator guide: [DEMO_DAY.md](DEMO_DAY.md). `npm run demo` runs a separate demo profile (`data/demo/`, its own
Moss index) that opens in Demo Mode.

Verified on the demo MacBook against the real providers (Speechmatics, Moss, Claude Haiku, Cartesia):
- **Push-to-talk + manual attribution**, through the real browser capture code with a synthetic clip injected as the
  mic (Chrome's own fake-mic device produced silence on macOS, so the clip was fed via `getUserMedia`): with the
  gate closed a looping clip produced 0 transcript rows in 7 s; holding Guest with "Guest is: Bob" produced Bob
  rows tagged manual and a spoken answer; holding Owner produced certain, manual owner rows.
- **Start fresh demo**: prepared example (Bob sarcastic + one sample memory) and learn live both reach Ready with
  the demo index matching the records; six rapid restarts stayed consistent; a reset during an in-flight decision
  produced no stale speech or writes; everyday data (14 memories) untouched.
- **Typed fallback** through the same pipeline; learn live taught by typed owner turns and recalled by paraphrase.
- **Failures**: real Claude "Connection error"s during network blips surfaced as a banner with Retry instead of a
  stuck "Thinking"; a real 5-minute Claude hang during an outage is now cut at 25 s; reaction clips that failed at
  boot are re-synthesized in the background; the provider check makes a real request to each provider.
- **All day**: four rapid "Restart listening" ended with one live Speechmatics session and memories kept.
- Fixed along the way: a Speechmatics message-type fall-through that turned any unrecognized message into a
  reconnect; a trailing fragment ("Did") cancelling the finished question before it.

- **Networking** (found on the demo laptop's hotspot): IPv6 is unreachable there, and Node's happy-eyeballs gave
  IPv4 only 250 ms before switching to it, so 12 of 30 fresh connections to Anthropic failed (ETIMEDOUT); with IPv4
  first and no fallback, 29 of 30 (one real 8 s stall). Pooled connections are also dropped after 4 s idle. Real
  decisions after 40 s idle gaps: 6/6 (before: 2 of 5 failed).
- Demo Mode redesigned to look like normal mode: hold-to-talk buttons under the imp, a small level bar by
  "Listening", and the operator controls in Settings → Demo.

**Not verified:** the real microphone in a noisy venue, a real speaker-to-mic feedback loop at venue volume, and
a multi-hour soak. Test those at the venue before the first judge.

## Then

- [~] Slice 2: mic capture (AudioWorklet → mono PCM16; Deepgram `linear16` at the real sample rate) → `/api/audio` → Deepgram (`nova-3`, `diarize_model=latest`, interim, utterance end) → turn assembler; owner calibration as the no-profile fallback; live speaker map. **Code done, needs live test.**
- [~] **Owner voice verification** (`docs/SPEAKER_ID.md`): opt-in onboarding (consent, mic check, 6 prompts + 2 at demo distance, self check, impostor check), local embedding-only profile in `data/owner-voice.json`, per-turn scoring from a 60 s PCM ring buffer, and the §3 resolver feeding the existing veto/re-attribution. **Built and tested with the real engine on TTS voices; needs real-people fixtures for final thresholds and a live mic run.**
- [x] "Who just spoke?" person chips under the imp (manual, visible binding for the last visitor voice).
- [x] Wording veto + self-ID suggestions + one-click "not me / that was me" re-attribution (`docs/SPEAKER_ID.md` §6).
- [x] Test voice button; blocked browser playback now shows an error instead of failing silently.
- [x] Turn-splitting fix: speaker by majority speech time, flicker absorbed, splits only on real handoffs (`docs/SPEAKER_ID.md` §7).
- [x] Latency trace: one `[latency]` server log line per spoken reply, splitting end of question → first audio into stt / decide / tts / play against the 4 s target (`server/latency.ts`). Speech turns now carry real wall-clock `startedAt`/`endedAt` from the PCM stream clock. **Tested with a scripted Session only; not yet run live.** Live run procedure and score sheets: `docs/REHEARSAL.md`.
- [ ] Slice 3: live Bob scene end to end by voice.
  - Synthetic voice path verified with `npm run smoke:voice` (2026-10-24): Cartesia-spoken questions streamed into `/api/audio` → Deepgram → assembler → Claude → Cartesia. Paraphrase → `ANSWER` (4.0 s end to end), rollback request → `ALERT_OWNER` (3.3 s). Moss off. **Not a live test:** no real mic, room echo, owner voice ID or real diarization.
- [x] Slice 4 logic, verified on real Haiku + Moss (typed): the owner states meeting facts in passing ("demoing at 10:30, table 42, Maya presents architecture"), and later paraphrases are answered from them. The executor now enforces the plan's routing:
  - approval/commit requests always alert;
  - other unknown questions alert only in focus mode;
  - "ask Preston" deflections only happen in focus mode;
  - speaker labels are never spoken aloud.
- [ ] Slice 4 by voice: rehearse escalation with a priority person live.
- [x] Script gaps: per-memory `timesAsked` and per-speaker `askedByThisPerson` in the prompt; owner-set `toneNote` per person (prompt + editable line in the people panel, under the no-slurs/no-appearance rule); memory `context` ("in the 4 pm call") the imp may cite. **Tested only; not yet run live.**
- [~] Slice 5 stage polish (on top of Projector demo mode and the busy thinking state): the technical decision line `ANSWER · cited m_42 · Moss 3 hits · 1.8 s` shows at full contrast in both views (under the plain-English receipt in demo mode, hidden while thinking). Thinking also wags the tail, furrows a brow and shows pulsing dots over the imp. **Checked in a headless browser at 1440×900; not yet seen live or on the venue screen.** Not done: `setSinkId` headphone routing, the 10-second teammate test.
- [ ] Slice 5: venue rehearsal, video, submission.

## Honest limitations

- With a voice profile, owner authority comes from voice verification (probabilistic, tuned for one room and mic); uncertain turns are deliberately not learned from. **Without** a profile it falls back to per-connection diarization plus calibration, which fails in practice (teammates got the owner's label in a live test), so enroll before demoing voice teaching.
- Without Moss credentials, retrieval runs in "unavailable" mode (recent memories passed directly to Claude), and the UI says so.
- Half-duplex: visitors must wait for the imp to finish speaking.
- Transient facts expire after 8 hours (fixed TTL).
