# Demo script (3 min)

**Roles:** Preston (owner; headphones playing music from a phone, nothing connected to the demo laptop), Bob (the interrupter), Maya (priority teammate). `OWNER_NAME` in `.env` must match the owner. Memory starts empty: click **Reset demo → Wipe memory + people** and say so.

| Time | Beat | What the room sees and hears |
| --- | --- | --- |
| 0:00–0:15 | Preston, headphones on, typing: "I answer once. Ritnag handles the next interruption." | Idle imp, empty memory |
| 0:15–0:55 | Bob: "Did you push the frontend PR?" Preston slides one ear off: "Yes, it's pushed, waiting on review." Ritnag: "Who was that?" Preston: "That's Bob. He asks everything twice. Talk to him like he's five." | Memory card appears. Bob appears with his tone and tone note |
| 0:55–1:20 | Preston on a call, out loud: "OK everyone, CC me on all the outreach emails. Good talk." | Second memory appears, tagged with where it was said |
| 1:20–1:50 | Bob: "Hey, who do I CC on those emails?" Preston never looks up. Ritnag answers, citing the call | Decision line: `ANSWER · cited m_… · Moss N hits`; Bob's count goes up |
| 1:50–2:05 | Bob: "Is the frontend code up yet?" Ritnag calls out the repeat | Count climbs |
| 2:05–2:25 | Maya: "Can you approve the production rollback?" | Ritnag refuses to authorize; alert lights up. Preston takes the headphones off for the first time |
| 2:25–2:50 | Point at the screen: owner-only learning by voice verification, Moss retrieval, Claude judgment, every answer citing a real memory, Cartesia voice | |
| 2:50–3:00 | Close: "You answer once. It handles the rest." | |

Drop the 1:50 beat first if time runs short. Never drop the meeting recall or the escalation.

Roast the repeat questions, not people. No jokes about appearance; the decision prompt refuses them anyway.

**Fallbacks:** typed input open in the debug drawer (say so out loud if you use it), the recorded video on the desktop, phone hotspot if Wi-Fi drops.
