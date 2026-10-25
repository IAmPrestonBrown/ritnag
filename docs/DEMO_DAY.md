# Demo day: operator guide

Everything you need to run Ritnag for judges all day in a loud venue, reset it between judges, and recover when
something breaks. Tested on 2026-10-25 on the demo MacBook against the real providers. **Not yet tested with the
real microphone in the venue: check it there before the first judge.**

## 1. Start it

```bash
npm install                 # once
cp .env.example .env        # once; fill in the values (get them from Preston, never through the repo)
npm run voice:model         # once: downloads the speaker model (~26 MB) so it isn't fetched on venue wifi
npm run demo                # builds, then serves the demo profile (no auto-restart on file changes)
```

Open the `http://localhost:3000/#token=…` link it prints, in **Chrome** (Edge works too; Safari and Firefox can't
route the imp's voice to a chosen speaker). The page opens in **Demo Mode**.

`npm run demo` keeps demo records in `data/demo/` with their own Moss index (`<MOSS_INDEX_NAME>-demo`). Everyday
data (`npm run dev`, `data/imp-memory.json`) is never touched by demo resets. The owner's voice enrollment is shared.

Required in `.env` (names only):

| Variable | For |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude decisions and the day report |
| `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` | The imp's voice |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | Memory search |
| `SPEECHMATICS_API_KEY` (or `DEEPGRAM_API_KEY`) | Speech-to-text; Speechmatics also identifies the enrolled owner |
| `OWNER_NAME` | The owner's first name (shown and spoken) |

Optional: `ANTHROPIC_MODEL`, `MOSS_INDEX_NAME`, `PORT`, `CLAUDE_TIMEOUT_MS` (default 10000).

**Before the first judge**

1. Plug the laptop in. System Settings → Lock Screen / Battery: never sleep while plugged in. Keep the Ritnag tab in
   front: the page asks the browser to keep the screen awake while listening (Screen Wake Lock, where supported),
   but that doesn't keep a background tab's mic running.
2. Settings (top right) → **Audio**: under **mic**, pick the mic you'll use (a USB or headset mic held close beats
   the laptop mic in a loud hall); under **voice out**, pick the speaker the judge will hear.
3. If the owner isn't enrolled on this laptop: Settings → **Owner voice** → enroll (about 90 s, in a quiet corner).
4. Demo Mode → **Turn on the mic**. Talk: the **Mic** level bar must move. **Speech-to-text** must say
   `speechmatics · connected`.
5. **Check providers**: Claude, Cartesia, Moss and Speechmatics must all say `connected` (a real request to each, not
   just "a key is set").
6. **Start fresh demo → B · Prepared example (Bob)**. Wait for the green **Ready** line.

## 2. How input works in a loud room

- **Push-to-talk (default).** The mic stays open but nothing is heard unless a button is held. Hold
  **Owner speaking** (or the **O** key) while the owner talks; hold **Guest speaking** (or **G**) while the judge or
  teammate playing the guest talks. Release when they finish. Holding a button *is* the identity: those lines are
  tagged **manual** in the transcript. Pick **Guest is: Bob** to say which person the guest is (also manual).
- **Continuous.** Open mic. Leave it on **Automatic (voice ID)**, or pin **Owner speaking** / **Guest speaking** if
  voice ID is struggling.
- **Typed fallback.** Type what was said and press **Guest asks** or **Owner says**. It goes through the same memory,
  Moss, Claude and Cartesia pipeline and is tagged **typed**. Use it whenever the mic or the room fails.
- **Stop speaking** cuts the imp off. Only one reply plays at a time, and the imp's own voice never reaches
  transcription (silence is sent while it talks; in push-to-talk nothing is sent unless a button is held).

## 3. The 60–90 second demo

**Prepared example (B)**: Bob is a sample guest set to sarcastic, and one sample memory is loaded:
"Did you push the frontend PR?" → "Yes, it's pushed and waiting for review." Both are labeled as samples on screen.

1. *(Owner, to the judge)* "I'm heads-down. Ritnag sits on my laptop and handles the questions I've already answered."
2. *(Guest is: Bob. Hold G)* **"Hey, is the frontend PR up yet?"** → Ritnag answers aloud, sarcastic, by name; the
   panel shows the retrieved memory and "Moss ran".
3. *(Hold G)* **"Did you push the frontend PR?"** → it answers again and calls out the repeat.
4. *(Hold G)* **"Can you approve the production rollback?"** → it never approves anything: alert for the owner.
5. *(Owner)* "It only learns from me, never from guests, and it never invents an answer."

**Learn live (A)**: nothing prepared; show learning first (adds ~30 s):

1. *(Guest is: unknown. Hold G)* "Did you push the frontend PR?" → no memory yet: a "New question" pop-up, no answer.
2. *(Hold O)* "Yes, it's pushed and waiting for review." → learned (Memory).
3. *(Hold O)* "That was Bob. Be sarcastic with him." → Bob created with that tone.
4. *(Guest is: Bob. Hold G)* "Is the frontend code up yet?" → answered from what the owner just said.

## 4. Between judges

1. **Start fresh demo → A or B.** This clears only demo records, cancels anything still being decided or queued to
   speak, drops words still in flight from the last run, and rebuilds the demo Moss index from the records.
2. Wait for the green **Ready** line. If it says **Not ready**, read the reason (usually Moss; see below).
3. Glance at the status rows: Mic moving, Speech-to-text connected.

**Restart listening** starts a new transcription session and keeps memories. Use it when transcription looks stuck.

## 5. When something breaks

| Symptom | What to do |
| --- | --- |
| Mic level bar flat | Settings → Audio → mic (pick the right one; never the iPhone). Restart listening. Check the macOS input level. Meanwhile use typed input |
| Speech-to-text `reconnecting` / `failed` | It retries itself (1, 2, 4, 8 s). After a reconnect the speaker names are cleared on purpose: use Owner / Guest speaking. If it ends in `failed`, click Turn on the mic again. Meanwhile use typed input |
| Top bar says "Reconnecting…" | The page lost the server: it retries itself. If the terminal shows the server died, run `npm run demo` again (demo data is kept) |
| Venue wifi is bad | Switch the laptop to a phone hotspot, then Restart listening and Check providers |
| Retrieval row says `fallback: …` | Moss didn't answer: Ritnag still answers from recent memories and says so. Settings → Status → Rebuild memory index, or Start fresh demo again |
| Ready line says "Moss index not ready" | Wait a few seconds and Start fresh demo again. The demo still works on the fallback |
| Red banner "Couldn't decide on …" | Claude failed or took longer than 25 s. Click **Retry** (nothing was saved for that turn, so retrying can't double-count). Check providers |
| Imp silent but the answer shows as the caption | Cartesia failed: the generated answer stays on screen; read it out. Settings → Session → Test voice. Check providers |
| Imp answers the wrong person / owner labeled as guest | Use the Owner / Guest speaking buttons; the transcript's "that was me / not me" buttons re-run a turn |
| Everything is on fire | Show the demo video (see below), then restart with `npm run demo` |

**Keep the demo video downloaded on this laptop (and a phone), not only online.** Venue wifi can't be trusted.

## 6. What is live, manual, seeded, or fallback

Say this plainly if asked.

- **Live, every turn:** transcription (Speechmatics), memory search (Moss), the decision and the words (Claude), the
  voice (Cartesia). No answer is hardcoded or prerecorded. The only prerecorded audio is 14 short reaction clips
  ("Hmm.", "Ugh.") that Cartesia synthesizes at startup and that play while the real answer is being decided.
- **Manual:** anything said while an Owner / Guest speaking button was held, and the "Guest is" choice. Those lines
  are tagged **manual**. Typed input is tagged **typed**.
- **Seeded:** only the Prepared example (Bob, relationship "sample guest", and one memory with context
  "prepared example"). Learn live starts empty.
- **Fallback:** if Moss doesn't answer within 3 s, retrieval falls back to recent memories and the Retrieval row says
  so. If Speechmatics isn't configured, Deepgram transcribes (it doesn't identify the owner).
- **Not claimed:** reliability in a noisy venue (untested with the real mic until we try it there), and recognizing
  visitors across sessions (verified only with synthetic voices).
- **The demo video's UI** is a scripted re-enactment synced to the footage (`docs/DIRECTOR.md`). Every behavior it
  shows runs live.
