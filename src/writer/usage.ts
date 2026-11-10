/**
 * The record of what the writer has done: one line per call in data/runs/writer-usage.jsonl.
 * Tokens and cost are whatever the writer reported, and null wherever it reported nothing. This
 * tool has no price list for any writer and never works a cost out for one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BILLING_MODES } from "../settings.js";
import { TASK_KINDS } from "./contract.js";

export const WRITER_OUTCOMES = ["ok", "invalid_output", "malformed", "billing_refused", "exit", "spawn", "timeout", "cancelled", "output_limit"] as const;
export type WriterOutcome = (typeof WRITER_OUTCOMES)[number];

const count = z.number().int().min(0).nullable();

export const WriterUsageLine = z.object({
  v: z.literal(1),
  at: z.string(),
  /** The process that made the call, and the command it was running. */
  run: z.string(),
  command: z.string(),
  task: z.enum(TASK_KINDS),
  jobId: z.string().nullable(),
  /** The identity of the configured writer command (`WriterSettings.identity`). */
  identity: z.string(),
  /** Who the response said wrote. Null when no response in the contract came back. */
  writer: z.string().nullable(),
  model: z.string().nullable(),
  outcome: z.enum(WRITER_OUTCOMES),
  /** How the call was paid for, as reported. Null when no response came back. */
  billing: z.enum(BILLING_MODES).nullable(),
  usage: z.object({ inputTokens: count, cachedInputTokens: count, outputTokens: count }).nullable(),
  /** As reported. Null is unknown, never free. */
  costUsd: z.number().min(0).nullable(),
  ms: z.number().min(0),
});
export type WriterUsageLine = z.infer<typeof WriterUsageLine>;

export function appendWriterUsage(file: string, line: WriterUsageLine): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n");
}

/** Every readable line of the record, and how many lines were not in this format. */
export function readWriterUsage(file: string): { lines: WriterUsageLine[]; unreadable: number } {
  const lines: WriterUsageLine[] = [];
  let unreadable = 0;
  if (!existsSync(file)) return { lines, unreadable };
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = WriterUsageLine.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { lines, unreadable };
}
