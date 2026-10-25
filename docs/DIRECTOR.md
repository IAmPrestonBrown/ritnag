# Director: scripted demos that look live

Director mode drives **every part of the Ritnag screen** from a script: transcript rows (streamed word by word),
who is speaking, the imp's pose, caption and voice, the "why" receipt, pop-up notices, the alert box, memory
cards and counts, people, the listening/focus chips, the side tab, the error banner and projector mode.
Nothing is heard or decided while it runs, but it looks like the live app.

Typical use: cut the demo video from real clips, write a **timeline** whose `at` times match the cut, start a
screen recording of the Ritnag page, then play the timeline. Overlay the real audio in the edit.

## Ways to drive it

All of them take the same commands (schema: `shared/director.ts`).

| From | How |
| --- | --- |
| Terminal / any agent with a shell | `npm run director -- play docs/director/example-timeline.json` (relayed by the server to every open page) |
| HTTP | `POST /api/director` with header `x-imp-token: <data/workspace-token>`; body is exactly one of `{"timeline": …, "from"?: ms}`, `{"commands": [...]}`, `{"stop": true}` |
| Inside the page (Puppeteer, Claude in Chrome) | `window.ritnag.play(timeline, fromMs?)`, `await window.ritnag.run(cmd or [cmds])`, `.stop()`, `.reset()`, `.live()`, `.state()`, `.stage()` |
| By hand | Settings → Director: a text script; press **N** for the next cue (one paragraph = one cue) |

Status: `npm run director -- status` (or `GET /api/director/status`) returns what the page last reported:
`{ active, isolated, playing, position (ms into the timeline), lastEvent (index), rows }`. Use it to confirm the
page received the timeline and when it finished (`playing: false`).

The page must be open (the `localhost:3000/#token=…` link); `POST /api/director` returns 409 if none is. Commands go
to **every** open Ritnag tab (the CLI prints how many), and `status` is whichever tab reported last, so keep only the
tab being recorded open.
`RITNAG_URL` points the CLI at another server.

## Timeline

```json
{ "isolate": true, "events": [ { "at": 1000, "do": "say", "who": "owner", "text": "Heads down.", "ms": 1500 }, … ] }
```

- `at`: ms after playback starts. Events can be in any order; ties run in file order. Commands at an `at` run in
  parallel with everything else (a `say` streaming over 1.5 s doesn't delay the next event).
- `isolate` (default true): hide all real data (transcript, people, memories, alerts, counts, Moss error badge,
  calibration and "who just spoke?" bars) so only the script shows. `false` adds the script on top of real data.
- `from` (CLI `--from 12000`): start mid-way for a retake. Earlier rows, cards and settings appear at once;
  earlier pop-ups, sounds and pauses are skipped.
- Playing a timeline clears whatever the director showed before. `npm run director -- live` (or
  `window.ritnag.live()`, or Settings → Director → Back to live) returns the page to the real app.
- While the director owns the screen, live server activity (mic transcripts, decisions, speech) is not shown.

Full example: [`docs/director/example-timeline.json`](director/example-timeline.json) (about 28 s: owner, new
guest, learned answer, Leon's repeat answered from memory, an approval alert).

## Commands

`who` is `"owner"`, `"guest"` (an unknown voice, shown as `unknown · S2`), `"guest S3"` (unknown, label S3), or a
person's name (shown as that person; created on first use; if a real person has that name and the stage isn't
isolated, it maps to them).

| Command | Fields | Effect |
| --- | --- | --- |
| `say` | `who`, `text`, `ms?`, `label?` | Live partial streams word by word over `ms` (default ~330 ms/word), then the transcript row lands. `ms: 0` = at once |
| `partial` | `who`, `text` (null clears) | Only the in-progress line |
| `think` | `ms?`, `on?` | Imp thinking pose + rotating "thinking" captions for `ms`, or until `{"do":"think","on":false}` |
| `imp` | `text`, `tone?`, `voice?`, `ms?` | The imp talks: caption + mouth. `voice: true` (default) = Archie really speaks it via Cartesia. `voice: false` = silent, mouth moves for `ms` (default from word count): use this to sync to recorded audio |
| `caption` | `text` (null = default) | The big line under the imp |
| `receipt` | `text` (null hides) | The small "why" line under the caption |
| `state` | `state`: idle, listening, thinking, speaking, alert, error; null = automatic | Force the imp's pose |
| `notice` | `kind`: person, question, repeat, name; `title`; `detail?` | Pop-up at the top with a time bar |
| `alert` | `reason`, `who?`, `question?`, `quiet?` | "Alert: needs you" box quoting `question` (added to the transcript as said by `who`) or `who`'s last line; receipt "Escalated to the owner: …". Chimes unless `quiet` |
| `ack` | | Removes the director's alerts |
| `memory` | `answer`, `question?`, `context?`, `timesAsked?`, `id?`, `from?` | A memory card. `from: "last"` (default) quotes the last transcript line as its source; `"ui"` = taught in UI. Receipt "Learned a new memory" (unless `"ui"`) |
| `repeat` | `memory` (id or text in it), `who?` | Repeat answered from memory: count +1, total repeats +1, card highlighted, receipt "Recalled from memory (asked N×): …" |
| `person` | `name`, `relationship?`, `tone?` | A People card |
| `owner` | `name` | The owner's display name (e.g. a teammate playing the owner) |
| `listening` | `on` | "Listening" chip and the mic button state |
| `focus` | `on` | "Focus mode" chip and button |
| `tab` | `tab`: memory, people, transcript | Switches the side panel |
| `demo` | `on` | Projector mode |
| `error` | `text` (null hides) | Red error banner |
| `reset` | `isolate?` (default true) | Clears everything the director showed; `isolate: false` returns to live |
| `wait` | `ms` | Pause (command lists and cues; timelines use `at`) |

Invalid commands are rejected with the field path (`events.4.kind: Invalid option…`) by the CLI, the HTTP
endpoint and `window.ritnag`.

## Recording recipe for an agent

1. `npm run dev`; open the printed `localhost:3000/#token=…` link in Chrome; size the window for the recording.
   Press D for projector mode if wanted (or `{"do":"demo","on":true}`).
2. Click the page once (browsers block audio until a click; only matters for `voice: true` lines).
3. Write the timeline from the video's timed transcript: one `say` per line (`at` = when the person starts
   talking, `ms` = how long they talk), `think` from the end of a question to the imp's reply, `imp` with
   `voice: false` and `ms` = the reply's length in the real audio, plus notices, memory and alert beats.
4. Validate without playing: `npm run director -- validate timeline.json` (a bad timeline is also rejected by
   `play` before anything plays).
5. Start the screen recording, then `npm run director -- play timeline.json`. Note the wall-clock time the command
   returned: that's `at = 0`. Poll `status` until `playing` is false.
6. Retake from the middle with `--from <ms>`. Return to the real app with `npm run director -- live`.

## From a finished video to a matching UI recording (fully automated)

1. `npm run director:transcribe -- edit.mov --out out/edit/transcript.json`: Deepgram transcript with speaker labels
   and word timings, plus a draft timeline (one `say` per utterance). Diarization can merge voices (the imp's
   voice and the owner's came out as one speaker in the 10/24 video), so check who is speaking against the
   footage and split lines at word times.
2. Edit the timeline: `{"do":"owner","name":"Leon"}` if someone else plays the owner, names for each speaker,
   the imp's lines as `imp` with `voice: false` and `ms` = its length in the audio, then notices, memory,
   repeat and alert beats. Fix misheard names. Example: [`director/demo-1024.json`](director/demo-1024.json).
3. `npm run director:record -- timeline.json --out out/edit/ui.mp4`: records the page in its own headless
   Chrome (other tabs unaffected) at 1280×720 CSS px, 1.5× density = 1920×1080, 30 fps. Frame 0 = `at: 0`, so
   it lines up with the start of the edit. `--size`, `--dpr`, `--projector`, `--tail ms` adjust it. About 2 min
   for a 105 s timeline. The dev server must be running.

## Hand-driven text script (Settings → Director)

One paragraph is one cue; press N to run the next. Lines:

```
owner: Okay, heads down.
guest: What's the wifi password?          (guest S3: … picks the label)
Leon: Yo, what's the wifi?                (a named person)
notice question: New question detected | What's the wifi password?
think 1400
imp sarcastic: It's calhacks2026.         (spoken aloud by Archie)
wait 800
{"do":"memory","question":"Wifi?","answer":"calhacks2026"}   (any JSON command)
```

The script runs on top of real data; start it with `{"do":"reset"}` for a clean stage.
