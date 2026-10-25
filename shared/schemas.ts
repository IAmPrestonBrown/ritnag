import { z } from "zod";

export const Tone = z.enum(["neutral", "friendly", "playful", "sarcastic", "annoyed", "savage"]);
export type Tone = z.infer<typeof Tone>;

export interface Person {
  id: string;
  name: string;
  relationship: string | null;
  tone: Tone;
  priority: boolean;
  ownerConfiguredAt: number;
}

export interface Utterance {
  id: string;
  sessionId: string;
  connectionId: string;
  providerEventId: string;
  speakerLabel: string;
  personId: string | null;
  text: string;
  startedAt: number;
  endedAt: number;
  isOwner: boolean;
  source: "typed" | "speech";
  /** Labeled as the owner, but the wording suggests someone else (e.g. it addresses the owner by name). */
  ownerSuspect?: boolean;
}

export interface Memory {
  id: string;
  kind: "faq" | "fact";
  canonicalQuestion: string | null;
  factualAnswer: string;
  sourceUtteranceIds: string[];
  sourcePersonId: string | null;
  observedAt: number;
  validUntil: number | null;
  supersededBy: string | null;
  timesAsked: number;
}

export type QuestionClassification = "repeat" | "new" | "alert" | "deflected";

export interface QuestionEvent {
  id: string;
  sessionId: string;
  utteranceId: string;
  personId: string | null;
  memoryId: string | null;
  classification: QuestionClassification;
  createdAt: number;
}

export interface Alert {
  id: string;
  sessionId: string;
  personId: string | null;
  questionUtteranceId: string;
  reason: string;
  createdAt: number;
  acknowledgedAt: number | null;
}

// ---- Decision engine output ----
// Flat shape for the model (structured output); narrowed and permission-checked by the executor.

export const DecisionAction = z.enum([
  "WAIT",
  "LEARN",
  "ANSWER",
  "ASK_IDENTITY",
  "UPDATE_PERSON",
  "ALERT_OWNER",
]);
export type DecisionAction = z.infer<typeof DecisionAction>;

export const MemoryProposal = z.object({
  kind: z.enum(["faq", "fact"]),
  canonicalQuestion: z.string().nullable(),
  factualAnswer: z.string(),
  // utterance ids from the provided transcript that support this fact
  sourceUtteranceIds: z.array(z.string()),
  // true for transient states ("PR is awaiting review"), false for stable facts/preferences
  isTransient: z.boolean(),
  // id of an existing memory this corrects, if any
  supersedesMemoryId: z.string().nullable(),
});

export const IdentityProposal = z.object({
  name: z.string(),
  relationship: z.string().nullable(),
  tone: Tone.nullable(),
  priority: z.boolean().nullable(),
  // which speaker the owner is talking about
  refersTo: z.enum(["pending_unknown", "named_existing"]),
});

export const SpeakerCheck = z.object({
  // the turn speaks TO the owner ("How old are you, Preston?"), so the owner probably didn't say it
  addressesOwner: z.boolean(),
  // the speaker names themself ("it's Bob again"); a hint, never proof
  selfIdentifiedAs: z.string().nullable(),
});

export const Decision = z.object({
  action: DecisionAction,
  speakerCheck: SpeakerCheck,
  isQuestion: z.boolean(),
  isImportant: z.boolean(),
  // asks the imp/owner to approve, authorize, deploy, roll back, pay, promise, or commit to something
  isActionRequest: z.boolean(),
  memoryIds: z.array(z.string()),
  factualAnswer: z.string().nullable(),
  spokenText: z.string().nullable(),
  memoryProposal: MemoryProposal.nullable(),
  identityProposal: IdentityProposal.nullable(),
  alertReason: z.string().nullable(),
});
export type Decision = z.infer<typeof Decision>;
export type MemoryProposal = z.infer<typeof MemoryProposal>;
export type IdentityProposal = z.infer<typeof IdentityProposal>;

// ---- HTTP request bodies ----

export const TurnRequest = z.object({
  text: z.string().min(1).max(2000),
  speakerLabel: z.string().min(1).max(64),
  // explicit "this was the owner" flag for typed input; speech uses calibration instead
  asOwner: z.boolean().default(false),
});

export const IdentityConfirmRequest = z.object({
  connectionId: z.string().default("typed"),
  speakerLabel: z.string(),
  personId: z.string().nullable(),
  newPerson: z
    .object({
      name: z.string().min(1),
      relationship: z.string().nullable().default(null),
      tone: Tone.default("neutral"),
      priority: z.boolean().default(false),
    })
    .optional(),
});

export const PersonUpdateRequest = z.object({
  personId: z.string(),
  tone: Tone.optional(),
  priority: z.boolean().optional(),
  relationship: z.string().nullable().optional(),
});

export const TeachRequest = z.object({
  canonicalQuestion: z.string().min(1),
  factualAnswer: z.string().min(1),
});

export const OwnerSpeakerRequest = z.object({ speakerLabel: z.string().nullable() });
export const ReattributeRequest = z.object({ utteranceId: z.string(), asOwner: z.boolean() });
export const SuggestionRequest = z.object({ connectionId: z.string(), speakerLabel: z.string(), accept: z.boolean() });
export const FocusRequest = z.object({ focusMode: z.boolean() });
export const AckRequest = z.object({ alertId: z.string() });
export const SpeechRequest = z.object({ responseId: z.string() });
export const PlaybackRequest = z.object({
  responseId: z.string(),
  phase: z.enum(["started", "ended"]),
});
