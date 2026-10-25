import express, { type Request, type Response } from "express";
import type { ZodType } from "zod";
import { EnrollFinishRequest, EnrollSampleQuery, VerifyTestQuery } from "../../shared/schemas";
import { int16ToFloat, toInt16 } from "./pcm";
import { VoiceError, type OwnerVoice } from "./ownerVoice";

// ~20 s of 48 kHz PCM16; enrollment takes are ~5 s.
const rawAudio = express.raw({ type: "application/octet-stream", limit: "2mb" });

const parse = <T,>(schema: ZodType<T>, value: unknown, res: Response): T | null => {
  const r = schema.safeParse(value);
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return null;
  }
  return r.data;
};

const audioBody = (req: Request, res: Response, sampleRate: number) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 2) {
    res.status(400).json({ error: "expected mono PCM16 audio (application/octet-stream)" });
    return null;
  }
  return { pcm: int16ToFloat(toInt16(req.body)), sampleRate };
};

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err instanceof VoiceError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

/** /api/voice/*: owner voice onboarding (docs/SPEAKER_ID.md §4). Mounted behind the workspace token. */
export function voiceRoutes(voice: OwnerVoice) {
  const r = express.Router();

  r.get("/profile", (_req, res) => {
    res.json(voice.status());
  });

  r.delete(
    "/profile",
    handle((_req, res) => {
      voice.deleteProfile();
      res.json(voice.status());
    }),
  );

  r.post(
    "/enroll/start",
    handle(async (_req, res) => {
      res.json(await voice.startEnrollment());
    }),
  );

  r.post(
    "/enroll/sample",
    rawAudio,
    handle((req, res) => {
      const q = parse(EnrollSampleQuery, req.query, res);
      if (!q) return;
      const take = audioBody(req, res, q.sampleRate);
      if (!take) return;
      res.json(voice.addSample(q.enrollmentId, q.prompt, take));
    }),
  );

  r.post(
    "/enroll/finish",
    handle(async (req, res) => {
      const b = parse(EnrollFinishRequest, req.body, res);
      if (!b) return;
      res.json(await voice.finishEnrollment(b.enrollmentId));
    }),
  );

  r.post(
    "/verify-test",
    rawAudio,
    handle(async (req, res) => {
      const q = parse(VerifyTestQuery, req.query, res);
      if (!q) return;
      const take = audioBody(req, res, q.sampleRate);
      if (!take) return;
      const t0 = Date.now();
      const result = await voice.verifyTest(take, q.purpose);
      console.log(`[imp] voice verify-test (${q.purpose}) score ${result.score.toFixed(3)} → ${result.decision} in ${Date.now() - t0}ms`);
      res.json(result);
    }),
  );

  return r;
}
