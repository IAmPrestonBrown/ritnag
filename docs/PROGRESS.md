# Progress

_Last updated 2026-10-24._

## Works now (verified)

- Repo scaffold: Vite + React UI served through the Express dev server on one origin. `npm run typecheck`, `npm test` (11 tests), and `npm run build` all pass.
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

## Written but not yet run against real providers

- Claude decision call (`claude-opus-5-5`, effort `low`, structured output via `betaZodOutputFormat`, server-side refusal fallback).
- Moss `SessionIndex` rebuild/upsert/remove/query/push (`@moss-js/moss` 1.21.0).
- Cartesia `/tts/bytes` MP3 and browser playback with real start/end events.

**Blocked on credentials:** `ANTHROPIC_API_KEY`, `MOSS_PROJECT_ID`/`MOSS_PROJECT_KEY`, `CARTESIA_API_KEY`/`CARTESIA_VOICE_ID`, and later `DEEPGRAM_API_KEY`.

## Next milestone: Slice 1 exit

With keys in `.env`: type "Did you push the frontend PR?" as guest-A, answer as owner, then type "Is the frontend code up yet?". The test passes if Moss retrieves the memory, Claude answers from it, and Cartesia speaks it.

## Then

- [ ] Slice 2: mic capture (MediaRecorder WebM/Opus) → `/api/audio` → Deepgram (`nova-3`, diarization, interim results, utterance end) → turn assembler; owner calibration; partial transcripts.
- [ ] Slice 3: live Bob scene end to end by voice.
- [ ] Slice 4: priority + focus escalation by voice; one meeting fact recalled later.
- [ ] Slice 5: polish, venue rehearsal, video, submission.

## Honest limitations

- Speaker identity is per-connection diarization plus owner confirmation. It is not voice recognition.
- Without Moss credentials, retrieval runs in "unavailable" mode (recent memories passed directly to Claude), and the UI says so.
- Half-duplex: visitors must wait for the imp to finish speaking.
- Transient facts expire after 8 hours (fixed TTL).
