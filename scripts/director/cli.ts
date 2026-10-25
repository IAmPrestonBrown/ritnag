// Drive the open Ritnag page from the terminal (or from an agent). See docs/DIRECTOR.md.
//
//   npm run director -- play demo.json [--from 12000]   play a timeline file
//   npm run director -- run '{"do":"notice","kind":"name","title":"Leon detected"}'   one command or a JSON array
//   npm run director -- run-file cues.json              a JSON array of commands, in order
//   npm run director -- validate demo.json              check a timeline without playing it
//   npm run director -- stop | reset | live | status
//
// RITNAG_URL (default http://localhost:3000) picks the server; the token is read from data/workspace-token.
import { readFileSync } from "node:fs";
import { DirectorCommand, Timeline } from "../../shared/director";

const BASE = process.env.RITNAG_URL ?? "http://localhost:3000";
const token = readFileSync(new URL("../../data/workspace-token", import.meta.url), "utf8").trim();
const headers = { "Content-Type": "application/json", "x-imp-token": token };
const [cmd, arg, ...rest] = process.argv.slice(2);

async function send(body: unknown) {
  const res = await fetch(`${BASE}/api/director`, { method: "POST", headers, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`director: ${res.status} ${out.error ?? ""}`);
    process.exit(1);
  }
  console.log(`sent to ${out.pages} page(s)`);
}

const commands = (json: string) => {
  const v = JSON.parse(json);
  const list = Array.isArray(v) ? v : [v];
  list.forEach((c, i) => {
    const r = DirectorCommand.safeParse(c);
    if (!r.success) {
      console.error(`command ${i}: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      process.exit(1);
    }
  });
  return list;
};

function loadTimeline(file: string | undefined) {
  if (!file) throw new Error("usage: play|validate <timeline.json>");
  const tl = JSON.parse(readFileSync(file, "utf8"));
  const timeline = Array.isArray(tl) ? { events: tl } : tl; // a bare array of events is fine too
  const r = Timeline.safeParse(timeline);
  if (!r.success) {
    console.error(r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("\n"));
    process.exit(1);
  }
  return { timeline, data: r.data };
}

switch (cmd) {
  case "validate": {
    const { data } = loadTimeline(arg);
    console.log(`ok: ${data.events.length} events, last at ${(Math.max(0, ...data.events.map((e) => e.at)) / 1000).toFixed(1)} s`);
    break;
  }
  case "play": {
    const { timeline, data } = loadTimeline(arg);
    const r = { data };
    const i = rest.indexOf("--from");
    const from = i >= 0 ? Number(rest[i + 1]) : undefined;
    const end = Math.max(0, ...r.data.events.map((e) => e.at));
    await send({ timeline, ...(from !== undefined ? { from } : {}) });
    console.log(`${r.data.events.length} events, last at ${(end / 1000).toFixed(1)} s`);
    break;
  }
  case "run":
    if (!arg) throw new Error("usage: run '<json command or array>'");
    await send({ commands: commands(arg) });
    break;
  case "run-file":
    if (!arg) throw new Error("usage: run-file <commands.json>");
    await send({ commands: commands(readFileSync(arg, "utf8")) });
    break;
  case "stop":
    await send({ stop: true });
    break;
  case "reset":
    await send({ commands: [{ do: "reset", isolate: true }] });
    break;
  case "live":
    await send({ commands: [{ do: "reset", isolate: false }] });
    break;
  case "status": {
    const res = await fetch(`${BASE}/api/director/status`, { headers });
    console.log(JSON.stringify(await res.json(), null, 2));
    break;
  }
  default:
    console.error("usage: npm run director -- play <file> [--from ms] | validate <file> | run '<json>' | run-file <file> | stop | reset | live | status");
    process.exit(1);
}
