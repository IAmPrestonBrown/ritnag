// Record the Ritnag page playing a timeline, frame-accurately, as a video to lay over the real footage.
// See docs/DIRECTOR.md.
//
//   npm run director:record -- timeline.json [--out out/ui.mp4] [--size 1280x720] [--dpr 1.5] [--tail 1500] [--projector]
//
// The page is opened in its own headless Chrome and driven in-page (window.ritnag.play), so other open tabs
// aren't affected. Frames come from Chrome's screencast with timestamps; the recording starts exactly at the
// timeline's at=0 and runs at a constant 30 fps, so at=0 lines up with the start of the edit.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { Timeline } from "../../shared/director";

const args = process.argv.slice(2);
const file = args[0];
const flag = (name: string, d?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
if (!file) {
  console.error("usage: npm run director:record -- <timeline.json> [--out ui.mp4] [--video edit.mp4 --final final.mp4]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const parsed = Timeline.safeParse(Array.isArray(raw) ? { events: raw } : raw);
if (!parsed.success) {
  console.error(parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("\n"));
  process.exit(1);
}
const timeline = parsed.data;
// The page's size in CSS pixels, rendered at --dpr (2 = sharp). A smaller page reads better shrunk into a corner.
const [width, height] = flag("--size", "1280x720")!.split("x").map(Number) as [number, number];
const out = resolve(flag("--out", "out/ui.mp4")!);
const tail = Number(flag("--tail", "1500"));
const dpr = Number(flag("--dpr", "1.5"));
const projector = args.includes("--projector");
const FPS = 30;
mkdirSync(dirname(out), { recursive: true });

const base = process.env.RITNAG_URL ?? "http://localhost:3000";
const token = readFileSync(new URL("../../data/workspace-token", import.meta.url), "utf8").trim();
// a scripted line runs past its `at` (a say streams for ms, a silent imp talks for ms)
const end = Math.max(0, ...timeline.events.map((e) => e.at + ("ms" in e && typeof e.ms === "number" && e.do !== "wait" ? e.ms : 0)));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--hide-scrollbars", "--mute-audio", `--window-size=${width},${height}`],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  page.on("pageerror", (e) => console.warn("page error:", (e as Error).message));
  await page.goto(`${base}/#token=${token}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".stage", { timeout: 20_000 });
  await page.waitForFunction(() => "ritnag" in window);
  // clean stage before recording, so frame 0 already looks like the timeline's start
  await page.evaluate(async (projector) => {
    const r = (window as any).ritnag;
    r.reset(true);
    await r.run({ do: "demo", on: projector });
  }, projector);
  await new Promise((r) => setTimeout(r, 600));

  const cdp = await page.createCDPSession();
  const frames: { t: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    frames.push({ t: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, data: f.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: width * dpr, maxHeight: height * dpr, everyNthFrame: 1 });
  await new Promise((r) => setTimeout(r, 500));

  const t0 = await page.evaluate((tl) => {
    (window as any).ritnag.play(tl);
    return Date.now();
  }, timeline);
  console.log(`playing ${timeline.events.length} events (${(end / 1000).toFixed(1)} s + ${tail} ms tail)…`);
  await page.waitForFunction(() => !(window as any).ritnag.state().playing, { timeout: end + 120_000, polling: 200 });
  await new Promise((r) => setTimeout(r, Math.max(0, t0 + end + tail - Date.now())));
  await cdp.send("Page.stopScreencast");
  const stop = Date.now();

  // frames → constant-rate video starting at t0 (the last frame before t0 is the opening frame)
  const tmp = mkdtempSync(join(tmpdir(), "ritnag-rec-"));
  const before = frames.filter((f) => f.t <= t0).at(-1);
  const used = [...(before ? [{ ...before, t: t0 }] : []), ...frames.filter((f) => f.t > t0)];
  if (used.length < 2) throw new Error(`only ${used.length} frames captured`);
  let list = "";
  used.forEach((f, i) => {
    const name = `f${String(i).padStart(6, "0")}.jpg`;
    writeFileSync(join(tmp, name), Buffer.from(f.data, "base64"));
    const next = i + 1 < used.length ? used[i + 1]!.t : stop;
    list += `file '${name}'\nduration ${((next - f.t) / 1000).toFixed(4)}\n`;
  });
  list += `file 'f${String(used.length - 1).padStart(6, "0")}.jpg'\n`; // concat demuxer needs the last file twice
  writeFileSync(join(tmp, "frames.txt"), list);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(tmp, "frames.txt"),
    "-vf", `fps=${FPS},scale=${width * dpr}:${height * dpr}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "18", out,
  ]);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`recorded ${used.length} frames, ${((stop - t0) / 1000).toFixed(1)} s → ${out}`);
  await page.evaluate(() => (window as any).ritnag.live());
} finally {
  await browser.close();
}

