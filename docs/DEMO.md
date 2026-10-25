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

## What the imp does on its own (all shown in the demo video)

- **"Hey <owner>, who was that?"**: after the owner talks to a voice it doesn't know and the room goes quiet
  (2.5 s), once per voice. Answer naturally ("that was just Preston, he's annoying"): the person is created, bound,
  given a tone, and their voice is learned for next time. A fact said in the same breath is learned too.
- **Focus mode** answers repeats even right after the owner spoke (outside focus mode it stays quiet for 8 s
  after the owner talks), and relays questions only the owner can answer ("Leon, Jason needs to know where your
  keys are") as an alert. The owner's reply is learned and clears the alert.
- **Names**: a confirmed person is addressed by name ("Jason, ..."); other visitors' names are never said.
- **"Give me a report on the day"** (also "recap", "catch me up", "what did I miss"): a short spoken summary of
  today's repeats, alerts and open questions, from the question log.
- For the video's story, set `OWNER_NAME=Leon` in `.env` on the machine where Leon is the owner.

## Pop-up notices

Four pop-ups appear at the top of the screen, each with a draining time bar, then slide out (hover pauses one, click dismisses):

- **New person**: a voice heard for the first time this session, or a person the owner just named.
- **Question**: a guest asked something the imp can't answer yet.
- **Repeat**: the imp answered a repeat question from memory (with the count).
- **Recognized**: "Leon detected" when a known person speaks (at most once a minute each), the owner once per session.

## Director mode (scripted demo video)

Everything on screen can be scripted and played on a timeline, for a recording that lines up with filmed footage. Hand-driven: Settings →
Director, press **N** per cue. Timed, or driven by an agent: see [DIRECTOR.md](DIRECTOR.md)
(`npm run director -- play docs/director/example-timeline.json`). `npm run director -- live` returns to the real app.
