import { z } from "zod";
import { Tone } from "./schemas";

/**
 * Director: drives every part of the screen from a script, so a recorded demo looks live without
 * anything being heard or decided. One JSON command language, used by the timeline player, the
 * browser API (window.ritnag), the HTTP endpoint (POST /api/director) and `npm run director`.
 * See docs/DIRECTOR.md.
 */

const ms = z.number().int().min(0).max(600_000);
const Who = z.string().min(1).describe('"owner", "guest" (unknown voice), "guest S3" (unknown, label S3) or a person\'s name');

export const DirectorCommand = z.discriminatedUnion("do", [
  /** Clear everything the director put on screen. isolate (default true) also hides real data. */
  z.object({ do: z.literal("reset"), isolate: z.boolean().optional() }),
  /** Someone talks: words stream in as a live partial over `ms` (default ~330 ms a word), then the row lands. ms:0 = at once. */
  z.object({ do: z.literal("say"), who: Who, text: z.string().min(1), label: z.string().optional(), ms: ms.optional() }),
  /** Just the in-progress line (null clears it). */
  z.object({ do: z.literal("partial"), who: Who, text: z.string().nullable(), label: z.string().optional() }),
  /** The imp thinks (rotating "thinking" captions) for `ms`, or until turned off with on:false. */
  z.object({ do: z.literal("think"), ms: ms.optional(), on: z.boolean().optional() }),
  /**
   * The imp speaks. voice:true (default) = Archie really says it (Cartesia). voice:false = silent: caption +
   * mouth moving for `ms` (default from word count), for syncing to audio recorded elsewhere.
   */
  z.object({ do: z.literal("imp"), text: z.string().min(1), tone: Tone.optional(), voice: z.boolean().optional(), ms: ms.optional() }),
  z.object({ do: z.literal("caption"), text: z.string().nullable() }),
  /** The small "why" line under the caption ("Recalled from memory (asked 2×): …"). */
  z.object({ do: z.literal("receipt"), text: z.string().nullable() }),
  /** Force the imp's pose: idle | listening | thinking | speaking | alert | error; null = automatic. */
  z.object({ do: z.literal("state"), state: z.enum(["idle", "listening", "thinking", "speaking", "alert", "error"]).nullable() }),
  /** A pop-up at the top: person | question | repeat | name. */
  z.object({ do: z.literal("notice"), kind: z.enum(["person", "question", "repeat", "name"]), title: z.string().min(1), detail: z.string().nullable().optional() }),
  /** The "Alert: needs you" box. question defaults to `who`'s last line. Plays the alert chime unless quiet. */
  z.object({ do: z.literal("alert"), reason: z.string().min(1), who: Who.optional(), question: z.string().optional(), quiet: z.boolean().optional() }),
  /** Acknowledge (remove) all director alerts. */
  z.object({ do: z.literal("ack") }),
  /**
   * A memory card. from:"last" (default) quotes the last transcript line as its source; "ui" = taught in UI.
   * id lets later `repeat` commands refer to it.
   */
  z.object({
    do: z.literal("memory"),
    answer: z.string().min(1),
    question: z.string().optional(),
    context: z.string().optional(),
    timesAsked: z.number().int().min(0).optional(),
    from: z.enum(["last", "ui"]).optional(),
    id: z.string().optional(),
  }),
  /** A repeat question answered from memory: bumps its count and the repeat total, highlights it, sets the receipt. */
  z.object({ do: z.literal("repeat"), memory: z.string().min(1).describe("memory id, or text found in its question/answer"), who: Who.optional() }),
  /** A person card (People tab), so `say` lines by that name show as a known person. */
  z.object({ do: z.literal("person"), name: z.string().min(1), relationship: z.string().nullable().optional(), tone: Tone.optional() }),
  z.object({ do: z.literal("listening"), on: z.boolean() }),
  z.object({ do: z.literal("focus"), on: z.boolean() }),
  z.object({ do: z.literal("tab"), tab: z.enum(["memory", "people", "transcript"]) }),
  /** Projector mode (bigger, simpler layout). */
  z.object({ do: z.literal("demo"), on: z.boolean() }),
  /** The red error banner (null hides it). */
  z.object({ do: z.literal("error"), text: z.string().nullable() }),
  /** Pause (only meaningful in a cue list; timelines use `at`). */
  z.object({ do: z.literal("wait"), ms }),
]);
export type DirectorCommand = z.infer<typeof DirectorCommand>;

export const TimedCommand = z.intersection(z.object({ at: ms.describe("ms from the start of playback") }), DirectorCommand);
export type TimedCommand = z.infer<typeof TimedCommand>;

export const Timeline = z.object({
  /** Hide all real data while playing (default true), so the screen shows only the script. */
  isolate: z.boolean().optional(),
  events: z.array(TimedCommand).max(2000),
});
export type Timeline = z.infer<typeof Timeline>;

/** POST /api/director: exactly one of these, broadcast to every open Ritnag page. */
export const DirectorRequest = z.object({
  /** Run these in order right now (a `say` finishes streaming before the next command starts). */
  commands: z.array(DirectorCommand).max(500).optional(),
  /** Play a timeline. from (ms) starts mid-way: earlier rows/cards appear instantly, earlier pop-ups are skipped. */
  timeline: Timeline.optional(),
  from: ms.optional(),
  /** Stop playback (what's on screen stays). */
  stop: z.boolean().optional(),
});
export type DirectorRequest = z.infer<typeof DirectorRequest>;

/** What a page reports back after each change, for GET /api/director/status. */
export interface DirectorStatus {
  active: boolean;
  isolated: boolean;
  playing: boolean;
  /** ms into the current timeline, when playing */
  position: number | null;
  /** last timeline event index that ran */
  lastEvent: number | null;
  rows: number;
  updatedAt: number;
}
