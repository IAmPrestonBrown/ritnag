# Live rehearsal runbook

For the voice runs that tests can't cover. Fill in the tables as you go and commit them, so thresholds and timings are on record. Run this on **the demo laptop** with the **demo mic and speaker**, ideally in the venue.

## 0. Physical setup

- [ ] The owner's headphones play music from a **phone**, not the laptop. The laptop's audio output goes only to the imp's speaker.
- [ ] Laptop output is the external speaker, at a volume the room can hear. Laptop input is the demo mic, picked in the **mic picker** (not an iPhone through Continuity).
- [ ] Put the speaker on the far side of the mic from the owner, pointed away from it.
- [ ] Desktop Chrome, page clicked once (unlocks audio). **Test voice** plays.
- [ ] `.env` has all four providers; the server banner shows `anthropic=ok deepgram=ok cartesia=ok moss=ok`.
- [ ] `npm run voice:model` already ran (don't download the model on venue Wi-Fi).
- [ ] Warn everyone before saving any server file: `tsx watch` restarts the server and drops the mic stream.

## 1. Owner enrollment

The owner sits **at demo distance, headphones on, leaning back**, the posture they'll have on stage. Open voice onboarding and go through consent → mic check → 6 prompts → 2 distance takes → self check.

| Field | Value |
| --- | --- |
| Date / time / room | |
| Mic + noise floor (mic check) | |
| Consistency across takes (`selfScore`) | |
| Accept threshold | |
| Reject threshold | |
| Self check score + decision | |
| Warning shown (`self_below_accept` / `not_separable` / none) | |

If the self check doesn't land on `accept`, re-enroll from the demo position before going further.

## 2. Impostor check

A teammate takes the mic at the same spot and reads the same phrase. Repeat with every teammate who will speak in the demo.

| Teammate | Score | Decision | Expected | Pass? |
| --- | --- | --- | --- | --- |
| | | | reject | |
| | | | reject | |

Then run 5 natural turns each from the owner and one teammate while listening, and copy the `[imp] voice 0.xxx` lines from the server log:

| Speaker | Scores (5 turns) | Correct owner/not-owner calls |
| --- | --- | --- |
| Owner | | /5 |
| | | /5 |

If owner and teammate scores overlap (P1 measured owner 0.45–0.81 vs. Leon 0.57–0.70), say so here. Teaching still works, through "that was me" and the UI. Don't present voice ID as reliable on stage.

## 3. Slice 2: one question, one answer, no feedback loop

Wipe with **Reset demo**, teach one fact (typed is fine), start listening, and have a visitor ask a paraphrase of it out loud.

- [ ] Exactly **one** audible answer.
- [ ] The imp's own voice doesn't show up as a transcript line or a second turn (the server log has no decision on the imp's words).
- [ ] After the answer, the next visitor question is heard normally (the mic gate reopened).

## 4. Slice 3: the Bob scene by voice

Follow `docs/DEMO.md` exactly, all by voice.

| Beat | Expected | Happened? |
| --- | --- | --- |
| Bob asks, owner answers | `LEARN`; memory appears | |
| Imp asks "who was that?" | Asked once, after the owner finishes | |
| "That was Bob… be sarcastic" | Bob created, tone sarcastic, bound to Bob's label | |
| Bob rephrases | `ANSWER` citing the memory, sarcastic, fact audible; Bob's count +1 | |
| Priority person asks to approve a rollback | `ALERT_OWNER`, alert panel, nothing authorized | |

## 5. Latency

Every spoken reply prints one line when its audio starts:

```
[latency] speech "Is the frontend code up yet?" stt 1.3s · decide 1.6s · tts 0.7s · play 0.2s = 3.8s OK (<4s)
```

- **stt**: end of the question → finalized turn. Includes Deepgram endpointing, the assembler's `TURN_SILENCE_MS` wait (default 1200 ms) and owner voice scoring.
- **decide**: Moss retrieval + Claude decision.
- **tts**: Cartesia synthesis after the decision.
- **play**: the browser fetching and starting the clip.

Target: **under 4 s total**. Paste lines from the Bob scene here:

| Turn | stt | decide | tts | play | total |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

If `stt` dominates, lower `TURN_SILENCE_MS` (try 800) and `DEEPGRAM_ENDPOINTING_MS` (try 300). Watch for turns splitting mid-sentence. If `decide` dominates, confirm `ANTHROPIC_MODEL` is Haiku and `ANTHROPIC_EFFORT=low`.
