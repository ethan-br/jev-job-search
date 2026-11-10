/**
 * The record of what decisions have cost: one line per HTTP attempt in data/runs/decisions-usage.jsonl.
 *
 * The backend reports tokens and no price, so a cost here is always an estimate: reported tokens
 * at the published prices in `DECISIONS.pricing`. An attempt that may have been billed and reported
 * no tokens (a timeout, a server error, a reply without usage) has no estimate. Its cost is unknown,
 * it is written as null, and it carries an upper bound that every spend limit counts. Unknown is
 * never written as zero.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DECISIONS } from "../config.js";
import { STAGES } from "./types.js";

export const TokenUsage = z.object({
  inputTokens: z.number().int().min(0),
  /** Input tokens read from the backend's prompt cache. Part of inputTokens. */
  cachedTokens: z.number().int().min(0),
  /** Input tokens written to the backend's prompt cache. Part of inputTokens. */
  cacheWriteTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** How one attempt ended. */
export const OUTCOMES = ["ok", "invalid_reply", "rate_limited", "quota", "rejected", "server_error", "timeout", "network"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const UsageLine = z.object({
  v: z.literal(1),
  at: z.string(),
  /** The process that made the call, and the command it was running. */
  run: z.string(),
  command: z.string(),
  backend: z.string(),
  model: z.string(),
  stage: z.enum(STAGES),
  jobId: z.string().nullable(),
  /** 1 for the first try of a call, 2 for its first retry, and so on. */
  attempt: z.number().int().min(1),
  outcome: z.enum(OUTCOMES),
  status: z.number().int().nullable(),
  questions: z.number().int().min(0),
  /** How many of the questions the backend declined. */
  refusals: z.number().int().min(0),
  /** Tokens as the backend reported them. Null when it reported none. */
  usage: TokenUsage.nullable(),
  /** Estimated from `usage`. Zero only when the attempt is known not to be billed. Null when unknown. */
  costUsd: z.number().min(0).nullable(),
  /** When the cost is unknown: the most it can have been. */
  boundUsd: z.number().min(0).nullable(),
  ms: z.number().min(0),
});
export type UsageLine = z.infer<typeof UsageLine>;

/** What a request with these token counts costs at the published prices. An estimate. */
export function estimateCostUsd(u: TokenUsage, pricing: typeof DECISIONS.pricing = DECISIONS.pricing): number {
  const plain = Math.max(0, u.inputTokens - u.cachedTokens - u.cacheWriteTokens);
  const usd = (plain * pricing.inputPerMillion + u.cachedTokens * pricing.cachedInputPerMillion + u.cacheWriteTokens * pricing.cacheWritePerMillion) / 1_000_000;
  return usd * (u.inputTokens > pricing.longContextTokens ? pricing.longContextMultiplier : 1);
}

/** The most a request body of this many characters can cost: every character counted generously, at the dearest input price. */
export function boundCostUsd(bodyChars: number, pricing: typeof DECISIONS.pricing = DECISIONS.pricing): number {
  const tokens = Math.ceil(bodyChars / DECISIONS.boundCharsPerToken);
  const dearest = Math.max(pricing.inputPerMillion, pricing.cacheWritePerMillion);
  return ((tokens * dearest) / 1_000_000) * (tokens > pricing.longContextTokens ? pricing.longContextMultiplier : 1);
}

/** What a line counts for against a spend limit: its estimate, or its bound when the cost is unknown. */
export const chargeOf = (l: Pick<UsageLine, "costUsd" | "boundUsd">): number => l.costUsd ?? l.boundUsd ?? 0;

export function appendUsage(file: string, line: UsageLine): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n");
}

/** Every readable line of the record, and how many lines were not in this format (left by another version, or cut short). */
export function readUsage(file: string): { lines: UsageLine[]; unreadable: number } {
  const lines: UsageLine[] = [];
  let unreadable = 0;
  if (!existsSync(file)) return { lines, unreadable };
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = UsageLine.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { lines, unreadable };
}

/** What the record says has been spent since a time: the estimate, and the bound of what is unknown. */
export function spentSince(file: string, sinceIso = ""): { estimatedUsd: number; unknownBoundUsd: number; unknownAttempts: number; totalUsd: number } {
  let estimatedUsd = 0;
  let unknownBoundUsd = 0;
  let unknownAttempts = 0;
  for (const l of readUsage(file).lines) {
    if (sinceIso && l.at < sinceIso) continue;
    if (l.costUsd !== null) estimatedUsd += l.costUsd;
    else {
      unknownAttempts++;
      unknownBoundUsd += l.boundUsd ?? 0;
    }
  }
  return { estimatedUsd, unknownBoundUsd, unknownAttempts, totalUsd: estimatedUsd + unknownBoundUsd };
}
