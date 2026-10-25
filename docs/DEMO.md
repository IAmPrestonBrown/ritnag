# Demo script (3 min)

**Roles:** Preston (owner; headphones playing music from a phone, nothing connected to the demo laptop), Bob (the interrupter), Maya (priority teammate). `OWNER_NAME` in `.env` must match the owner. Memory starts empty: click **Reset demo → Wipe memory + people** and say so.

## Setup (2 min before going on)

1. `npm run dev`, open the printed link in **Chrome** (not Safari).
2. Open **⚙ Settings** (top right; Esc closes it):
   - **Mic** shows **MacBook … Microphone**, not an iPhone.
   - **Voice out**: if you're wearing headphones, send the imp's voice to the room speaker so visitors hear it. Use a Bluetooth or USB speaker; wired headphones turn off the Mac's built-in speakers. Alerts stay in your headphones.
   - **Reset demo → Wipe memory + people** for a clean start. Your voice profile is kept.
   - **Test voice** once, so the browser allows audio, and check the volume on the room speaker.
3. Press **D** for projector mode if you're on a projector.
4. **Start listening**, then toggle **Focus** on and off once. The first click asks Chrome for notification permission; answer it now, not on stage. Allow or Block; the alert chime works either way.
5. Stop and start listening once more so the session starts clean, and you're ready.

**Timing:** the imp stays quiet for 8 s after the owner speaks (it assumes you're in the conversation; `OWNER_ENGAGED_MS`). It only speaks up for questions; banter gets no reply (`BANTER=on` to change). So after the owner says something, Bob waits a beat (about 8 s) before asking. Each spoken answer is preceded by a short in-tone reaction ("Ugh.", "Again?").

Recovery during the demo: if a voice is mislabeled, use the **Who just spoke?** buttons under the imp, or **that was me / not me** on the line in the **Transcript** tab. Say out loud that it's a manual correction. Typed input is in ⚙ Settings.

Verified end to end in demo mode (typed input, real Claude, Moss and Cartesia): question → learn → "That was Bob" → sarcastic recall with the memory cited → a second person gets a friendly answer → a priority person's rollback request escalates in focus mode.

| Time | Beat | What the room sees and hears |
| --- | --- | --- |
| 0:00–0:15 | Preston, headphones on, typing: "I answer once. Ritnag handles the next interruption." | Idle imp, empty memory |
| 0:15–0:55 | Bob: "Did you push the frontend PR?" Preston slides one ear off: "Yes, it's pushed, waiting on review." Then, unprompted: "That's Bob. He asks everything twice. Talk to him like he's five." | Memory card appears. Bob appears with his tone and tone note |
| 0:55–1:20 | Preston on a call, out loud: "OK everyone, CC me on all the outreach emails. Good talk." | Second memory appears, tagged with where it was said |
| 1:20–1:50 | Bob: "Hey, who do I CC on those emails?" Preston never looks up. Ritnag answers, citing the call | Decision line: `ANSWER · cited m_… · Moss N hits`; Bob's count goes up |
| 1:50–2:05 | Bob: "Is the frontend code up yet?" Ritnag calls out the repeat | Count climbs |
| 2:05–2:25 | Maya: "Can you approve the production rollback?" | Ritnag refuses to authorize; alert lights up. Preston takes the headphones off for the first time |
| 2:25–2:50 | Point at the screen: owner-only learning by voice verification, Moss retrieval, Claude judgment, every answer citing a real memory, Cartesia voice | |
| 2:50–3:00 | Close: "You answer once. It handles the rest." | |

Drop the 1:50 beat first if time runs short. Never drop the meeting recall or the escalation.

Roast the repeat questions, not people. No jokes about appearance; the decision prompt refuses them anyway.

**Fallbacks:** typed input in ⚙ Settings (say so out loud if you use it), the recorded video on the desktop, phone hotspot if Wi-Fi drops.

## Pop-up notices

Four pop-ups appear at the top of the screen, each with a draining time bar, then slide out (hover pauses one, click dismisses):

- **New person**: a voice heard for the first time this session, or a person the owner just named.
- **Question**: a guest asked something the imp can't answer yet.
- **Repeat**: the imp answered a repeat question from memory (with the count).
- **Recognized**: "Leon detected" when a known person speaks (at most once a minute each), the owner once per session.

## Director mode (scripted intro for the video)

For the intro shot, drive the screen by hand: press **N** for the next cue. Rows stream into the transcript word by
word, the imp "thinks", pop-ups fire, and Archie really says the imp's lines, but nothing is heard or decided.
The status shows "Listening" while a script runs. Edit the script in **Settings → Director** (saved in this browser);
"Restart script" clears the scripted rows. One paragraph is one cue:

```
owner: Okay, heads down.
guest: What's the wifi password?          (guest S3: … picks the label)
Leon: Yo, what's the wifi?                (a named person)
notice question: New question detected | What's the wifi password?
think 1400                                (imp thinking, ms)
imp sarcastic: It's calhacks2026.         (spoken aloud; tone optional)
wait 800
```

Reload the page (or Restart script) before switching to the live part of the demo.
