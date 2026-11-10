/**
 * What the application asks of a decision backend, and what it gets back. These are the
 * application's own types: no backend's request or response shape appears here. A backend
 * (`src/decisions/openai.ts`) maps them to its own API and checks every answer before returning it.
 *
 * Three kinds of question:
 *   predicate  is a condition true? The answer is a probability from 0 to 1.
 *   choice     which one of a fixed set of values? The answer is one of them.
 *   score      where on an ordered scale, lowest first? The answer is a number from 0 to levels - 1.
 *
 * A backend may decline a question. That is a `refusal`, and it is never read as "no", as zero,
 * or as a low score: every caller says what a refusal means for it.
 */
import { z } from "zod";

export type PredicateQuestion = {
  type: "predicate";
  instructions: string;
  /** What makes the condition true and what makes it false, when the instructions alone leave room. */
  when?: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  /** Each allowed value with what it means. The answer is always one of these keys. */
  choices: Record<string, string>;
};

export type Level = { label: string; description?: string };

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** Ordered from lowest to highest. The score is the probability-weighted position, starting at 0. */
  levels: Level[];
};

export type Question = PredicateQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export function predicate(instructions: string, when?: { true: string; false: string }): PredicateQuestion {
  return when ? { type: "predicate", instructions, when } : { type: "predicate", instructions };
}

export function choice(instructions: string, choices: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, choices };
}

export function score(instructions: string, levels: (string | Level)[]): ScoreQuestion {
  if (levels.length < 2) throw new Error("score needs at least two levels");
  return { type: "score", instructions, levels: levels.map((l) => (typeof l === "string" ? { label: l } : l)) };
}

const unit = z.number().min(0).max(1);

export const PredicateAnswer = z.object({ type: z.literal("predicate"), probability: unit });
export const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  /** The probability the backend gave each value it reported one for. Empty when it reported none. */
  probabilities: z.record(z.string(), unit),
  /** The backend's own confidence in its pick, exactly as reported. Null when it reported none: a number is never made up. */
  confidence: unit.nullable(),
});
export const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number().min(0),
  /** How many levels the question had, so the score can be read without the question. */
  levels: z.number().int().min(2),
  /** The probability of each level, by position. Empty when the backend reported none. */
  probabilities: z.array(unit),
  confidence: unit.nullable(),
});
export const Refusal = z.object({ type: z.literal("refusal") });
export const Answer = z.discriminatedUnion("type", [PredicateAnswer, ChoiceAnswer, ScoreAnswer, Refusal]);
export type Answer = z.infer<typeof Answer>;
export type PredicateAnswer = z.infer<typeof PredicateAnswer>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;
export type Answers = Record<string, Answer>;

/**
 * What the questions are asked about. `shared` is whatever stays the same from call to call (the
 * candidate, mostly): a backend that can reuse a repeated prefix at a lower price is told where it
 * ends. `evidence` is what this call alone is about: one posting, one form, one page.
 */
export type DecisionInput = { shared?: Record<string, unknown>; evidence: Record<string, unknown> | string };

/** What a call is for. Costs are reported by stage, so every call names one. */
export const STAGES = ["screening", "mapping", "follow_up", "verification", "memory", "inbox", "probe"] as const;
export type Stage = (typeof STAGES)[number];
export type DecisionCall = { stage: Stage; jobId?: string };

/** Who decides, as far as a cached answer needs to know: another backend, model or wording must never be served an old answer. */
export type DeciderIdentity = { backend: string; model: string; requestVersion: number };

/** Tokens and cost of one process's decision calls. Costs are estimates from reported tokens, never an invoice. */
export type DecisionUsage = {
  /** Calls that came back with answers. */
  calls: number;
  /** Every HTTP attempt, including the ones that failed or were tried again. */
  attempts: number;
  retries: number;
  /** Calls that ended in an error after every try. */
  failed: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Worked out from reported tokens at the published prices. */
  estimatedUsd: number;
  /** Attempts that may have been billed and reported no tokens. */
  unknownAttempts: number;
  /** The most those attempts can have cost. Counted towards every spend limit, shown apart from the estimate. */
  unknownBoundUsd: number;
};

/** What a process's decisions count for against a limit, and what is shown as "about $x": the estimate plus the bound of what is unknown. */
export const chargedUsd = (u: Pick<DecisionUsage, "estimatedUsd" | "unknownBoundUsd">): number => u.estimatedUsd + u.unknownBoundUsd;

export interface Decider {
  readonly identity: DeciderIdentity;
  readonly usage: DecisionUsage;
  /**
   * Asks every question about one input. The result has exactly the keys of `questions`, and each
   * answer is of its question's type or a refusal. Anything else is a DecisionError.
   */
  decide(input: DecisionInput, questions: Questions, call: DecisionCall): Promise<Answers>;
}

export type DecisionErrorKind =
  /** A setting is missing or wrong: no key, a bad limit. */
  | "config"
  /** The request itself is outside what the backend takes: too many questions, one choice. Never sent. */
  | "request"
  /** The backend did not accept the key. */
  | "auth"
  /** The account has no credit left. Not tried again. */
  | "quota"
  | "rate_limited"
  | "timeout"
  | "network"
  | "server"
  /** The backend refused the request as sent (a 4xx that is none of the above). */
  | "rejected"
  /** The input was too long for the model. */
  | "too_long"
  /** The reply was not what the backend documents: bad JSON, a value out of range, a choice that was not offered. */
  | "malformed"
  /** The reply left a question out, answered one twice, or answered one that was not asked. */
  | "incomplete"
  /** A spend limit of this tool stopped the call before it was sent. */
  | "spend_limit"
  /** The backend declined a question whose answer the caller cannot do without. */
  | "refused";

export class DecisionError extends Error {
  constructor(
    public readonly kind: DecisionErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

/**
 * True for a failure the next call would meet as well: no key, a key that is refused, no credit
 * left, a spend limit reached. A caller with more to ask stops asking instead of failing each one.
 */
export const stopsEveryCall = (err: unknown): err is DecisionError => err instanceof DecisionError && (err.kind === "config" || err.kind === "auth" || err.kind === "quota" || err.kind === "spend_limit");

const get = (answers: Answers, key: string): Answer => {
  const a = answers[key];
  if (!a) throw new DecisionError("incomplete", `no answer for ${key}`);
  return a;
};

/** The probability a predicate is true, or null when the backend declined it. */
export function probabilityOf(answers: Answers, key: string): number | null {
  const a = get(answers, key);
  if (a.type === "refusal") return null;
  if (a.type !== "predicate") throw new DecisionError("malformed", `${key} was answered as ${a.type}, not predicate`);
  return a.probability;
}

/** A choice answer, or null when the backend declined it. */
export function choiceOf(answers: Answers, key: string): ChoiceAnswer | null {
  const a = get(answers, key);
  if (a.type === "refusal") return null;
  if (a.type !== "choice") throw new DecisionError("malformed", `${key} was answered as ${a.type}, not choice`);
  return a;
}

/** A score answer, or null when the backend declined it. */
export function scoreOf(answers: Answers, key: string): ScoreAnswer | null {
  const a = get(answers, key);
  if (a.type === "refusal") return null;
  if (a.type !== "score") throw new DecisionError("malformed", `${key} was answered as ${a.type}, not score`);
  return a;
}

/** The keys the backend declined. */
export const refusedKeys = (answers: Answers): string[] => Object.keys(answers).filter((k) => answers[k]?.type === "refusal");

/**
 * How far a choice can be relied on, for a threshold: the weaker of the backend's own confidence
 * and the probability it gave the value it picked. Backends define "confidence" differently, and
 * some define it loosely, so neither number is trusted alone. Null when the backend reported
 * neither, which every gate treats as "not sure".
 */
export function supportOf(a: { choice: string; confidence: number | null; probabilities: Record<string, number> }): number | null {
  const picked = a.probabilities[a.choice];
  if (a.confidence === null && picked === undefined) return null;
  return Math.min(a.confidence ?? 1, picked ?? 1);
}

/** True when the support is known and reaches the threshold. An unknown support never passes. */
export const supports = (a: { choice: string; confidence: number | null; probabilities: Record<string, number> }, threshold: number): boolean => {
  const s = supportOf(a);
  return s !== null && s >= threshold;
};

/** A score as a number from 0 to 1 across its levels. */
export function scoreToUnit(scoreValue: number, levels: number): number {
  if (levels <= 1) return 0;
  return Math.min(1, Math.max(0, scoreValue / (levels - 1)));
}
