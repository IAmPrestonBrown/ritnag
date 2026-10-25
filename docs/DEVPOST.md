# Devpost submission: Ritnag

Paste each section into the matching Devpost field.

---

## Tagline

You answer once. Ritnag handles the next interruption, with your memory and its own attitude.

## Inspiration

Anyone who works next to other people gets asked the same things all day. "Did you push it?" "Who do I CC?" "Is the build green?" Each answer takes ten seconds. Losing the thread you were on takes twenty minutes. The answer already exists, because you said it out loud an hour ago, but nobody wrote it down and the person asking wasn't listening.

We wanted something that sits on the laptop, hears you answer once, and handles the repeats. And since a polite FAQ bot is boring, it has opinions about people who ask twice.

## What it does

Ritnag is a desktop companion with a face. During a session you start, it:

- **Learns from the owner, and only the owner.** When you answer a question or say a decision out loud ("make sure to CC me on the emails"), it saves that as a memory, with where you said it.
- **Recognizes paraphrased repeats.** "Is the frontend code up yet?" matches the memory about the frontend PR being pushed. It answers aloud, cites the memory on screen, and counts how many times that person has asked.
- **Knows who's talking.** The owner's voice is enrolled once. When the owner deals with a voice Ritnag doesn't know, it asks "who was that?"; the answer ("that was just Preston, he's annoying") creates the person, sets their tone, and learns their voice, so next session it shows "Preston detected" by itself.
- **Talks to each person the way you told it to.** "That was Bob. Talk to him like he's five." Bob now gets patient, simple, slightly insulting answers. Tones run from friendly to savage, and the owner can add a free-text note on how to treat someone.
- **Knows what it can't do.** It never invents an answer it has no memory for. Requests to approve, deploy, roll back, pay or promise anything always go to the owner, with an alert, a chime and a system notification. In focus mode it also relays questions only the owner can answer ("Leon, Jason needs to know where your keys are"), and the owner's reply is learned and clears the alert.
- **Reports back.** "Give me a report on the day" gets a short spoken recap of who asked what, built from the question log.
- **Shows its work.** Every answer has a receipt: which memory it used, how many times that person has asked, and how long the decision took. It addresses someone by name only after the owner has confirmed who they are, and never says anyone else's name.

## How we built it

One turn, end to end:

1. **Mic → Speechmatics.** The browser streams mono PCM16 over a WebSocket. The server relays it to Speechmatics real-time transcription with diarization (Deepgram as a fallback) and assembles words into turns (`server/audioRelay.ts`, `server/providers/stt.ts`, `server/turnAssembler.ts`).
2. **Who said it.** The owner enrolls their voice once; Speechmatics gets that voiceprint and labels the owner's words itself, and a local sherpa-onnx speaker model can veto it (`server/voice/`). Visitors the owner names get voiceprints too, so they're recognized in later sessions. Only verified owner turns can teach facts or change people. Uncertain turns can be answered but never learned from.
3. **Moss retrieval.** The question is searched against saved memories (`server/providers/moss.ts`, `Session.retrieve()` in `server/session.ts`).
4. **Claude decides.** Claude gets the turn, the retrieved memories with scores, the recent transcript, and the speaker's tone, note and repeat counts. It returns one structured decision: answer, learn, update a person, alert, or wait (`server/decision.ts`, `server/providers/claude.ts`).
5. **The executor checks it.** Claude proposes; `server/executor.ts` decides what is allowed. Guests can't teach or rename anyone. An answer must cite memory ids that were actually retrieved and are still active. Approval requests always escalate.
6. **Cartesia speaks.** The reply is synthesized with a delivery matched to the person's tone and streamed to the browser as it's generated (`server/providers/cartesia.ts`); the provider gets silence while it plays, so the imp doesn't answer itself.

Local JSON is the source of truth (`server/memory.ts`). Moss is a search index over it, never the authority. React + Vite on the front, Node + Express + `ws` on the back, TypeScript throughout, 171 unit and pipeline tests (`npm run check`).

## Sponsor technology

**Moss: semantic retrieval over everything the owner has said.** Each memory is a Moss doc whose id is the local memory id, with text built from the question and the fact. A `SessionIndex` embeds and searches in-process, so a fact taught a second ago can be retrieved immediately. The cloud index is a mirror, pushed in the background 3 s after any change and rebuilt from local data on demand. Hits are resolved back to active local records, so a stale index can never bring back a superseded fact. The decision line on screen shows "Moss N hits" and the cited id. Code: `server/providers/moss.ts`, `Session.retrieve()` in `server/session.ts`.

**Cartesia: every word the imp says.** All replies go through Cartesia `/tts/bytes` (`sonic-3.6`), streamed to the browser so playback starts on the first chunk. Short in-character reactions ("Ugh.", "Oh, here we go.") are pre-synthesized per tone and play the moment a question ends, while the real answer is decided. The delivery changes with the person: emotion, speed and volume are set per tone, so the same fact sounds warm for a friend and outraged for the fourth repeat. Code: `server/providers/cartesia.ts` (the `DELIVERY` table), `src/audio/playback.ts`.

**Anthropic: the judgment.** Claude decides whether a retrieved memory actually answers the question (same subject, still fresh, fact actually stated), extracts what to learn from the owner's words, maps "be short with him" to a tone, and writes the line. Structured output via the Anthropic SDK's zod helper. Code: `server/decision.ts`, `server/providers/claude.ts`.

## Challenges we ran into

- **Who is talking.** Diarization labels from one laptop mic don't separate the owner from teammates reliably. In our bake-off, owner scores ran 0.45–0.81 and a teammate's 0.57–0.70. So the owner enrolls a voice profile. Turns that are uncertain are never learned from, and the transcript has one-click "that was me / not me" corrections. We don't present voice ID as perfect.
- **The imp hearing itself.** Deepgram sometimes glued the end of the imp's reply onto the start of the next visitor's question. We filter by capture time, per word, against when the speaker was playing.
- **Latency.** End of question to first audio has to stay under a few seconds or it reads as broken. We cached the prompt, stream the TTS, run visitor questions in parallel with the owner's turns, and play an instant reaction clip, which puts first sound at about 2 s and the full answer at 3–6 s in our rehearsals. Claude's decision is still the largest share.
- **Not making things up.** A search match isn't an answer. The prompt makes Claude check that the memory really answers the question, and the executor rejects any answer citing a memory that wasn't retrieved.

## Accomplishments that we're proud of

- Every answer has to cite a memory the owner actually taught and Moss actually retrieved. That's enforced in code (`server/executor.ts`), not just requested in the prompt.
- The tone system is fun to watch, and it still never roasts anyone it isn't sure it has identified.
- It runs locally: provider keys stay on the server, the UI needs a workspace token, and memory is a JSON file you can read.

## What we learned

- Retrieval is the easy half. Deciding whether a hit actually answers the question, and refusing when it doesn't, is the part that makes it trustworthy.
- Speaker identity on one consumer mic is a real constraint, so the design has to work with uncertainty instead of assuming it away.

## What's next for Ritnag

- Speaker ID that holds up in a loud room with many people; visitor recognition so far is verified with synthetic voices.
- Full duplex, so people can interrupt the imp.
- Private alerts in the owner's headphones by voice, not just a chime.
- Calendar and repo hooks so transient facts ("in a meeting until 3", "PR is merged") update themselves.

## Honest status

- **Live and verified:** the team used it live with real voices throughout development. Every behavior in the demo story (who-was-that, naming plus learning in one sentence, focus-mode answers, voice recognition across sessions, relayed alerts, the day report) was verified end to end through the real mic path, Speechmatics, Claude and Cartesia using synthetic voices; see `docs/PROGRESS.md`.
- **The demo video:** the on-screen UI in the video is a scripted re-enactment synced to the filmed scene, made with our director mode (`docs/DIRECTOR.md`, script in `docs/director/demo-1024.json`), so the UI and the footage line up frame for frame. Every behavior it shows runs live, and we're happy to demo it.
- **Seeded or manual in a live demo:** memory starts empty and we say so. Any speaker correction is done by hand, and we say that too.

## Built during the event

All code was written at Cal Hacks 13.0. The first commit is Oct 24, 2026, 6:00 p.m. PDT. See the repo history.
