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

## Then

- [~] Slice 2: mic capture (AudioWorklet → mono PCM16; Deepgram `linear16` at the real sample rate) → `/api/audio` → Deepgram (`nova-3`, `diarize_model=latest`, interim, utterance end) → turn assembler; owner calibration as the no-profile fallback; live speaker map. **Code done, needs live test.**
- [~] **Owner voice verification** (`docs/SPEAKER_ID.md`): opt-in onboarding (consent, mic check, 6 prompts + 2 at demo distance, self check, impostor check), local embedding-only profile in `data/owner-voice.json`, per-turn scoring from a 60 s PCM ring buffer, and the §3 resolver feeding the existing veto/re-attribution. **Built and tested with the real engine on TTS voices; needs real-people fixtures for final thresholds and a live mic run.**
- [x] "Who just spoke?" person chips under the imp (manual, visible binding for the last visitor voice).
- [x] Wording veto + self-ID suggestions + one-click "not me / that was me" re-attribution (`docs/SPEAKER_ID.md` §6).
- [x] Test voice button; blocked browser playback now shows an error instead of failing silently.
- [x] Turn-splitting fix: speaker by majority speech time, flicker absorbed, splits only on real handoffs (`docs/SPEAKER_ID.md` §7).
- [x] Latency trace: one `[latency]` server log line per spoken reply, splitting end of question → first audio into stt / decide / tts / play against the 4 s target (`server/latency.ts`). Speech turns now carry real wall-clock `startedAt`/`endedAt` from the PCM stream clock. **Tested with a scripted Session only; not yet run live.** Live run procedure and score sheets: `docs/REHEARSAL.md`.
- [ ] Slice 3: live Bob scene end to end by voice.
- [x] Slice 4 logic, verified on real Haiku + Moss (typed): the owner states meeting facts in passing ("demoing at 10:30, table 42, Maya presents architecture"), and later paraphrases are answered from them. The executor now enforces the plan's routing:
  - approval/commit requests always alert;
  - other unknown questions alert only in focus mode;
  - "ask Preston" deflections only happen in focus mode;
  - speaker labels are never spoken aloud.
- [ ] Slice 4 by voice: rehearse escalation with a priority person live.
- [x] Script gaps: per-memory `timesAsked` and per-speaker `askedByThisPerson` in the prompt; owner-set `toneNote` per person (prompt + editable line in the people panel, under the no-slurs/no-appearance rule); memory `context` ("in the 4 pm call") the imp may cite. **Tested only; not yet run live.**
- [~] Slice 5 stage polish (on top of Projector demo mode): the technical decision line `ANSWER · cited m_42 · Moss 3 hits · 1.8 s` now shows at full contrast in both views (under the plain-English receipt in demo mode), latency in seconds. While thinking, the caption rotates through in-character lines, the imp glows and fidgets, and dots appear over its head, so the decision wait reads as the character. **Checked in a headless browser at 1280×720, in both views, with real typed questions through the real Claude decider (no Moss/Cartesia): the lines cycle once a second and give way to the answer when the decision lands. Not yet seen with the live mic, with voice playing, or on the venue screen.** Not done: `setSinkId` headphone routing, the 10-second teammate test.
- [ ] Slice 5: venue rehearsal, video, submission.

## Honest limitations

- With a voice profile, owner authority comes from voice verification (probabilistic, tuned for one room and mic); uncertain turns are deliberately not learned from. **Without** a profile it falls back to per-connection diarization plus calibration, which fails in practice (teammates got the owner's label in a live test), so enroll before demoing voice teaching.
- Without Moss credentials, retrieval runs in "unavailable" mode (recent memories passed directly to Claude), and the UI says so.
- Half-duplex: visitors must wait for the imp to finish speaking.
- Transient facts expire after 8 hours (fixed TTL).
