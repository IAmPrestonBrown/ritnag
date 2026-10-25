import type { Alert, Memory, Person, Utterance } from "./schemas";

export type ImpState = "idle" | "listening" | "thinking" | "speaking" | "alert" | "error";

export interface IndexStatus {
  configured: boolean;
  ready: boolean;
  docCount: number;
  lastError: string | null;
  lastPushAt: number | null;
  pushPending: boolean;
}

export interface Snapshot {
  storage: "local-json";
  index: IndexStatus;
  ownerName: string;
  session: {
    id: string;
    generation: number;
    connectionId: string | null;
    focusMode: boolean;
    listening: boolean;
    ownerSpeakerLabel: string | null;
    bindings: Record<string, string>; // speakerLabel -> personId (this connection only)
    pendingUnknownSpeaker: string | null;
    calibration: { active: boolean; candidate: string | null };
    /** "Is spk2 Bob?": a visitor named themself; needs one click to apply. */
    suggestions: { connectionId: string; speakerLabel: string; personId: string; name: string }[];
    speechLabels: string[]; // labels heard on the current speech connection
  };
  people: Person[];
  memories: Memory[];
  // derived from questionEvents
  counts: { total: number; byPerson: Record<string, number>; byMemory: Record<string, number> };
  alerts: Alert[];
  transcript: Utterance[];
}

export interface DecisionSummary {
  turnId: string;
  action: string;
  personId: string | null;
  memoryIds: string[];
  spokenText: string | null;
  responseId: string | null;
  latencyMs: number;
  note: string | null;
  retrieval: { mode: "moss" | "unavailable"; hits: { id: string; score: number }[] };
}

export type ServerEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "transcript.partial"; speakerLabel: string; text: string; generation: number }
  | { type: "transcript.final"; utterance: Utterance; generation: number }
  | { type: "speaker.bound"; speakerLabel: string; personId: string | null; generation: number }
  | { type: "state.changed"; state: ImpState; caption: string | null; generation: number }
  | { type: "decision.completed"; decision: DecisionSummary; generation: number }
  | { type: "speech.ready"; responseId: string; text: string; generation: number }
  | { type: "alert.created"; alert: Alert; generation: number }
  | { type: "error"; message: string; recoverable: boolean };

export interface Health {
  ok: boolean;
  storage: "local-json";
  providers: { anthropic: boolean; deepgram: boolean; cartesia: boolean; moss: boolean };
  model: string;
}
