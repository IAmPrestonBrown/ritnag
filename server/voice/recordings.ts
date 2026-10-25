import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { z } from "zod";
import { toInt16 } from "./pcm";

/**
 * Test recordings for the speaker-ID bake-off (docs/WORKSTREAMS.md P1): raw clips from the exact
 * live mic path, saved as WAV under data/recordings/<set>/ with a manifest. Dev tooling, local only.
 */

export type ClipKind = "solo" | "conversation";

export interface ClipEntry {
  file: string;
  kind: ClipKind;
  /** Who is speaking in a solo clip; null for a conversation (labeled later). */
  speaker: string | null;
  sampleRate: number;
  durationSec: number;
  deviceLabel: string;
  createdAt: number;
}

/** Set and speaker names become path segments: keep them boring. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export const ClipQuery = z
  .object({
    set: z.string().regex(NAME),
    kind: z.enum(["solo", "conversation"]),
    speaker: z.string().regex(NAME).optional(),
    sampleRate: z.coerce.number().int().min(8000).max(96000),
    device: z.string().max(200).default(""),
  })
  .refine((q) => q.kind === "conversation" || q.speaker !== undefined, { message: "solo clips need a speaker" });

/** Mono 16-bit PCM WAV. */
export function wavFromPcm16(pcm: Int16Array, sampleRate: number): Buffer {
  const data = pcm.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, 44 + i * 2);
  return b;
}

export class RecordingStore {
  constructor(private readonly root: string) {}

  private manifestPath(set: string) {
    return join(this.root, set, "manifest.json");
  }

  manifest(set: string): ClipEntry[] {
    const p = this.manifestPath(set);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ClipEntry[]) : [];
  }

  save(q: { set: string; kind: ClipKind; speaker?: string; sampleRate: number; device: string }, pcm: Int16Array): ClipEntry {
    const dir = join(this.root, q.set);
    mkdirSync(dir, { recursive: true });
    const createdAt = Date.now();
    const file = `${q.kind}-${q.kind === "solo" ? q.speaker : "conversation"}-${createdAt}.wav`;
    writeFileSync(join(dir, file), wavFromPcm16(pcm, q.sampleRate));
    const entry: ClipEntry = {
      file,
      kind: q.kind,
      speaker: q.kind === "solo" ? q.speaker! : null,
      sampleRate: q.sampleRate,
      durationSec: Math.round((pcm.length / q.sampleRate) * 10) / 10,
      deviceLabel: q.device,
      createdAt,
    };
    const all = [...this.manifest(q.set), entry];
    const tmp = `${this.manifestPath(q.set)}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.manifestPath(q.set));
    return entry;
  }

  sets(): { set: string; clips: ClipEntry[] }[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME.test(d.name))
      .map((d) => ({ set: d.name, clips: this.manifest(d.name) }));
  }
}

// up to ~3 min of 48 kHz mono PCM16
const rawAudio = express.raw({ type: "application/octet-stream", limit: "20mb" });

/** /api/recordings: mounted behind the workspace token. */
export function recordingRoutes(store: RecordingStore) {
  const r = express.Router();
  r.get("/", (_req, res) => {
    res.json(store.sets());
  });
  r.post("/", rawAudio, (req, res) => {
    const q = ClipQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: q.error.issues.map((i) => i.message).join("; ") });
    if (!Buffer.isBuffer(req.body) || req.body.length < 2) {
      return void res.status(400).json({ error: "expected mono PCM16 audio (application/octet-stream)" });
    }
    const entry = store.save(q.data, toInt16(req.body));
    console.log(`[imp] recording saved: ${q.data.set}/${entry.file} (${entry.durationSec}s, ${entry.deviceLabel || "unknown mic"})`);
    res.json(entry);
  });
  return r;
}
