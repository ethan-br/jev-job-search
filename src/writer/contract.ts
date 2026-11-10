/**
 * The writer contract: what this tool sends to whatever writes, and what it takes back.
 *
 * The writer is an external program the person configures (WRITER_COMMAND). It is started with an
 * argument array, never through a shell. It reads one JSON request on standard input and prints
 * one JSON response on standard output. Standard error is for its diagnostics and is never parsed.
 * A failure is a non-zero exit code. Nothing here names a harness, a model or a provider: a small
 * wrapper program translates between this contract and one harness's own headless interface.
 *
 * The contract is versioned by its name. A change that a wrapper must know about changes the name.
 */
import { z } from "zod";
import { BILLING_MODES } from "../settings.js";

export const WRITER_CONTRACT = "job-search.writer/v1";

/** What the writer is asked to write. */
export const TASK_KINDS = ["form_answers", "tracking_notes", "tailored_documents", "probe"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const EFFORTS = ["low", "medium", "high"] as const;

export const WriterRequest = z.object({
  contract: z.literal(WRITER_CONTRACT),
  task: z.object({
    kind: z.enum(TASK_KINDS),
    /** Unique to this call. */
    id: z.string().min(1),
    jobId: z.string().nullable(),
    /** Raised whenever the instructions for this kind of task change. */
    promptVersion: z.number().int().min(1),
    /** Raised whenever the expected output for this kind of task changes. */
    schemaVersion: z.number().int().min(1),
  }),
  /** The standing instructions: the rules, and whatever is the same for every call of this kind. */
  system: z.string(),
  /** What this call is about. */
  input: z.string(),
  /**
   * The output wanted: one JSON value that fits this JSON Schema. Schemas stay inside the subset
   * that strict structured-output modes take: every property required, additionalProperties false,
   * a nullable type where a value may be absent, no length or pattern keywords.
   */
  output: z.object({ format: z.literal("json"), schema: z.record(z.string(), z.unknown()) }),
  /** How long the writer has. The tool stops it after this, whatever it is doing. */
  timeoutMs: z.number().int().min(1),
  /** Hints a wrapper may map to its harness or ignore. */
  settings: z.object({ effort: z.enum(EFFORTS) }),
});
export type WriterRequest = z.infer<typeof WriterRequest>;

const count = z.number().int().min(0).nullable();

export const WriterResponse = z.object({
  contract: z.literal(WRITER_CONTRACT),
  /** The JSON value asked for. It is checked against the application's own schema before any of it is used. */
  output: z.unknown(),
  /** Who wrote: the wrapper's name for itself, its version, and the model, each null when it does not know. */
  writer: z.object({ name: z.string().min(1), version: z.string().nullable(), model: z.string().nullable() }),
  /** How this call is paid for, as the writer knows it. "unknown" when it cannot tell. */
  billing: z.enum(BILLING_MODES),
  /** What the call used. Null, or null inside, wherever the writer does not know. Unknown is never zero. */
  usage: z.object({ inputTokens: count, cachedInputTokens: count, outputTokens: count }).nullable(),
  /** What the call cost in US dollars, when the writer knows. Null when it does not. */
  costUsd: z.number().min(0).nullable(),
});
export type WriterResponse = z.infer<typeof WriterResponse>;

export type WriterErrorKind =
  /** WRITER_COMMAND and the settings around it. */
  | "config"
  /** The program could not be started. */
  | "spawn"
  /** The program exited with a failure. */
  | "exit"
  | "timeout"
  | "cancelled"
  /** The program printed more than it may. */
  | "output_limit"
  /** What it printed is not a response in this contract. */
  | "malformed"
  /** The response is in the contract, and its output does not fit what the task asked for. */
  | "invalid_output"
  /** The writer reported a way of paying the person did not accept in WRITER_BILLING. */
  | "billing";

export class WriterError extends Error {
  constructor(
    public readonly kind: WriterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WriterError";
  }
}

/**
 * True for a failure that is about the writer and not about what it was asked: it is not
 * configured, it cannot be started, it exited with a failure (not signed in, for one), or it
 * bills in a way the person did not accept. The next call would meet the same, so a caller with
 * more to write stops instead of failing each one. A slow answer or a bad one is about one task.
 */
export const writerStopsEveryCall = (err: unknown): err is WriterError => err instanceof WriterError && (err.kind === "config" || err.kind === "spawn" || err.kind === "exit" || err.kind === "billing");
