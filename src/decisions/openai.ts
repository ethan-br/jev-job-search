/**
 * The decision backend: OpenAI's Decisions API (POST /v1/decisions).
 *
 * One call is one input and many typed questions. This file maps the application's neutral
 * questions to the API's request, checks the reply against what was asked before any of it is
 * used, tries again only what is worth trying again, records every attempt, and stops before a
 * spend limit is passed. There is no other backend and no fallback to one.
 *
 * Read from the official guide and API reference on the date in `DECISIONS.pricing.verifiedOn`.
 */
import { DECISIONS, PATHS } from "../config.js";
import { decisionSettings } from "../settings.js";
import { registerSecret, scrub } from "../util/redact.js";
import { THIS_RUN } from "../util/run.js";
import { z } from "zod";
import { DecisionError, type Answer, type Answers, type DecisionCall, type Decider, type DecisionInput, type DecisionUsage, type DeciderIdentity, type Question, type Questions } from "./types.js";
import { appendUsage, boundCostUsd, chargeOf, estimateCostUsd, spentSince, type Outcome, type TokenUsage, type UsageLine } from "./usage.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAIDecisionsOptions = {
  apiKey?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
  model?: string;
  /** The most this process may spend. */
  runCapUsd?: number;
  /** The most the whole usage record may reach, or null for no budget. */
  budgetUsd?: number | null;
  /** Where every attempt is recorded. Null records nothing, and then the budget counts this process alone. */
  usageLog?: string | null;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

/** One question as the API takes it. A predicate has only instructions, so what makes it true or false goes into them. */
export function toApiQuestion(name: string, q: Question): Record<string, unknown> {
  if (q.type === "predicate") {
    const instructions = q.when ? `${q.instructions}\nTrue when: ${q.when.true}\nFalse when: ${q.when.false}` : q.instructions;
    return { type: "predicate", name, instructions };
  }
  if (q.type === "choice") {
    return { type: "choice", name, instructions: q.instructions, choices: Object.entries(q.choices).map(([value, description]) => (description ? { value, description } : { value })) };
  }
  return { type: "score", name, instructions: q.instructions, levels: q.levels.map((l) => (l.description ? { label: l.label, description: l.description } : { label: l.label })) };
}

/** Refuses a request the API would refuse, before it is sent and paid for. */
export function checkQuestions(questions: Questions): void {
  const L = DECISIONS.limits;
  const names = Object.keys(questions);
  if (names.length > L.questions) throw new DecisionError("request", `${names.length} questions in one call, and the limit is ${L.questions}`);
  for (const [name, q] of Object.entries(questions)) {
    if (!name) throw new DecisionError("request", "a question has no name");
    if (!q.instructions.trim()) throw new DecisionError("request", `${name} has no instructions`);
    if (q.type === "choice") {
      const n = Object.keys(q.choices).length;
      if (n < L.minChoices || n > L.maxChoices) throw new DecisionError("request", `${name} offers ${n} choices, and a choice takes ${L.minChoices} to ${L.maxChoices}`);
    }
    if (q.type === "score") {
      const n = q.levels.length;
      if (n < L.minLevels || n > L.maxLevels) throw new DecisionError("request", `${name} has ${n} levels, and a score takes ${L.minLevels} to ${L.maxLevels}`);
      if (new Set(q.levels.map((l) => l.label)).size !== n) throw new DecisionError("request", `${name} has two levels with the same label`);
    }
  }
}

/**
 * The request body. What every call shares goes first, as text with a cache boundary after it, so
 * a repeat of it is read from the backend's cache at a tenth of the price. Caching is set to
 * explicit: only that boundary is used. Left implicit, every one-off posting and page would be
 * written to the cache at a surcharge and never read again.
 */
export function buildRequest(model: string, input: DecisionInput, questions: Questions): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (input.shared) content.push({ type: "input_text", text: `What is the same for every request:\n${JSON.stringify(input.shared)}`, prompt_cache_breakpoint: { mode: "explicit" } });
  if (typeof input.evidence === "string") content.push({ type: "input_text", text: input.evidence });
  else content.push({ type: "input_json", data: input.evidence });
  return {
    model,
    input: [{ role: "user", content }],
    questions: Object.entries(questions).map(([name, q]) => toApiQuestion(name, q)),
    prompt_cache_options: { mode: "explicit" },
  };
}

const prob = z.number().min(0).max(1);
const ApiAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name: z.string(), probability: prob }),
  z.object({
    type: z.literal("choice"),
    name: z.string(),
    choice: z.union([z.string(), z.boolean()]),
    probabilities: z.array(z.object({ value: z.union([z.string(), z.boolean()]), probability: prob })).nullish(),
    confidence: prob.nullish(),
  }),
  z.object({
    type: z.literal("score"),
    name: z.string(),
    score: z.number(),
    probabilities: z.array(z.object({ value: z.number().int(), label: z.string().nullish(), probability: prob })).nullish(),
    confidence: prob.nullish(),
  }),
  z.object({ type: z.literal("refusal"), name: z.string() }),
]);
type ApiAnswer = z.infer<typeof ApiAnswer>;

const ApiUsage = z.object({
  input_tokens: z.number().int().min(0),
  input_tokens_details: z.object({ cached_tokens: z.number().int().min(0).nullish(), cache_write_tokens: z.number().int().min(0).nullish() }).nullish(),
  output_tokens: z.number().int().min(0).nullish(),
});

const ApiResponse = z.object({ answers: z.array(z.unknown()), model: z.string().nullish(), usage: z.unknown().optional() });

const ApiError = z.object({ error: z.object({ message: z.string().nullish(), type: z.string().nullish(), code: z.string().nullish() }) });

/** The reported tokens, or null when the reply reported none that can be read. Never a guess. */
export function readUsage(raw: unknown): TokenUsage | null {
  const parsed = ApiUsage.safeParse(raw);
  if (!parsed.success) return null;
  const u = parsed.data;
  return { inputTokens: u.input_tokens, cachedTokens: u.input_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: u.input_tokens_details?.cache_write_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
}

/**
 * Checks the reply's answers against the questions and returns them under the questions' keys.
 * Every question is answered exactly once, by its own type or by a refusal. A choice is one that
 * was offered. A score is inside its scale. A probability is from 0 to 1. Anything else throws,
 * and nothing in a reply that fails here is used.
 */
export function readAnswers(questions: Questions, raw: unknown[]): Answers {
  const out: Answers = {};
  for (const item of raw) {
    const parsed = ApiAnswer.safeParse(item);
    if (!parsed.success) throw new DecisionError("malformed", `an answer is not in a known shape: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 2).join("; ")}`);
    const a = parsed.data;
    const q = questions[a.name];
    if (!q || !Object.hasOwn(questions, a.name)) throw new DecisionError("incomplete", `an answer came back for "${a.name}", which was not asked`);
    if (Object.hasOwn(out, a.name)) throw new DecisionError("incomplete", `"${a.name}" was answered twice`);
    out[a.name] = toAnswer(a, q);
  }
  const missing = Object.keys(questions).filter((k) => !Object.hasOwn(out, k));
  if (missing.length) throw new DecisionError("incomplete", `${missing.length} of ${Object.keys(questions).length} questions were left unanswered: ${missing.slice(0, 5).join(", ")}`);
  // In the order the questions were asked, whatever order the reply used.
  return Object.fromEntries(Object.keys(questions).map((k) => [k, out[k] as Answer]));
}

function toAnswer(a: ApiAnswer, q: Question): Answer {
  if (a.type === "refusal") return { type: "refusal" };
  if (a.type !== q.type) throw new DecisionError("malformed", `"${a.name}" is a ${q.type} question and was answered as ${a.type}`);
  if (a.type === "predicate") return { type: "predicate", probability: a.probability };
  if (a.type === "choice" && q.type === "choice") {
    const allowed = (v: string | boolean): v is string => typeof v === "string" && Object.hasOwn(q.choices, v);
    if (!allowed(a.choice)) throw new DecisionError("malformed", `"${a.name}" was answered with ${JSON.stringify(a.choice)}, which is not one of its choices`);
    const probabilities: Record<string, number> = {};
    for (const p of a.probabilities ?? []) {
      if (!allowed(p.value)) throw new DecisionError("malformed", `"${a.name}" has a probability for ${JSON.stringify(p.value)}, which is not one of its choices`);
      if (Object.hasOwn(probabilities, p.value)) throw new DecisionError("malformed", `"${a.name}" has two probabilities for ${JSON.stringify(p.value)}`);
      probabilities[p.value] = p.probability;
    }
    return { type: "choice", choice: a.choice, probabilities, confidence: a.confidence ?? null };
  }
  if (a.type === "score" && q.type === "score") {
    const top = q.levels.length - 1;
    if (!(a.score >= 0 && a.score <= top + 1e-6)) throw new DecisionError("malformed", `"${a.name}" scored ${a.score} on a scale of 0 to ${top}`);
    const probabilities: number[] = [];
    if (a.probabilities?.length) {
      const byLevel = new Map<number, number>();
      for (const p of a.probabilities) {
        if (p.value < 0 || p.value > top || byLevel.has(p.value)) throw new DecisionError("malformed", `"${a.name}" has a probability for level ${p.value} on a scale of 0 to ${top}`);
        byLevel.set(p.value, p.probability);
      }
      for (let i = 0; i <= top; i++) probabilities.push(byLevel.get(i) ?? 0);
    }
    return { type: "score", score: Math.min(a.score, top), levels: q.levels.length, probabilities, confidence: a.confidence ?? null };
  }
  throw new DecisionError("malformed", `"${a.name}" could not be read`);
}

const RETRIED: readonly Outcome[] = ["rate_limited", "server_error", "timeout", "network"];

type Attempt = { outcome: Outcome; status: number | null; usage: TokenUsage | null; billed: "yes" | "no" | "unknown"; answers?: Answers; refusals?: number; error?: DecisionError; retryAfterMs?: number; /** Not worth another try, whatever the outcome. */ final?: boolean };

export class OpenAIDecisions implements Decider {
  readonly identity: DeciderIdentity;
  readonly usage: DecisionUsage = { calls: 0, attempts: 0, retries: 0, failed: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, estimatedUsd: 0, unknownAttempts: 0, unknownBoundUsd: 0 };
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly runCapUsd: number;
  private readonly budgetUsd: number | null;
  private readonly usageLog: string | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  /** What the record held when this process began. With what this process adds, it is what the budget is checked against. */
  private readonly spentBefore: number;

  constructor(opts: OpenAIDecisionsOptions = {}) {
    const needsSettings = opts.apiKey === undefined || opts.runCapUsd === undefined || opts.budgetUsd === undefined;
    const settings = needsSettings ? decisionSettingsOrThrow(opts) : null;
    this.apiKey = opts.apiKey ?? (settings?.apiKey as string);
    if (!this.apiKey) throw new DecisionError("config", "there is no API key for decisions");
    registerSecret(this.apiKey);
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = opts.endpoint ?? DECISIONS.endpoint;
    this.identity = { backend: DECISIONS.backend, model: opts.model ?? DECISIONS.model, requestVersion: DECISIONS.requestVersion };
    this.runCapUsd = opts.runCapUsd ?? settings?.runCapUsd ?? DECISIONS.runSpendCapUsd;
    this.budgetUsd = opts.budgetUsd === undefined ? (settings?.budgetUsd ?? null) : opts.budgetUsd;
    this.usageLog = opts.usageLog === undefined ? PATHS.decisionsUsage : opts.usageLog;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? DECISIONS.timeoutMs;
    this.spentBefore = this.usageLog && this.budgetUsd !== null ? spentSince(this.usageLog).totalUsd : 0;
  }

  /** What this process has spent, for a limit: the estimate plus the bound of what is unknown. */
  get spentUsd(): number {
    return this.usage.estimatedUsd + this.usage.unknownBoundUsd;
  }

  async decide(input: DecisionInput, questions: Questions, call: DecisionCall): Promise<Answers> {
    const count = Object.keys(questions).length;
    if (count === 0) return {};
    checkQuestions(questions);
    const body = JSON.stringify(buildRequest(this.identity.model, input, questions));
    const bound = boundCostUsd(body.length);
    const where = `${call.stage}${call.jobId ? ` for ${call.jobId}` : ""}`;

    let last: Attempt | null = null;
    for (let attempt = 1; attempt <= DECISIONS.maxRetries + 1; attempt++) {
      // Looked at before every try: a retry is a new request and is paid for like one.
      this.checkLimits(bound, where);
      if (attempt > 1) {
        this.usage.retries++;
        await this.sleep(Math.min(DECISIONS.retryMaxMs, last?.retryAfterMs ?? DECISIONS.retryBaseMs * 2 ** (attempt - 2)));
      }
      const started = Date.now();
      last = await this.attempt(body, questions);
      this.record(last, { call, attempt, count, bound, ms: Date.now() - started });
      if (last.answers) {
        this.usage.calls++;
        return last.answers;
      }
      if (last.final || !RETRIED.includes(last.outcome)) break;
    }
    this.usage.failed++;
    const e = last?.error ?? new DecisionError("server", "the decision call failed");
    throw new DecisionError(e.kind, `decisions (${where}): ${e.message}`, e.status);
  }

  private checkLimits(nextBound: number, where: string): void {
    const run = this.spentUsd;
    if (run + nextBound > this.runCapUsd) {
      throw new DecisionError("spend_limit", `decisions (${where}): this command has used about $${run.toFixed(4)} of its $${this.runCapUsd} limit, and the next call could pass it. Nothing was sent. The limit is DECISIONS_RUN_CAP_USD.`);
    }
    if (this.budgetUsd !== null && this.spentBefore + run + nextBound > this.budgetUsd) {
      throw new DecisionError("spend_limit", `decisions (${where}): about $${(this.spentBefore + run).toFixed(4)} of the $${this.budgetUsd} budget is used, and the next call could pass it. Nothing was sent. The budget is DECISIONS_BUDGET_USD.`);
    }
  }

  private async attempt(body: string, questions: Questions): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.endpoint, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      text = await res.text();
    } catch (err) {
      const timedOut = controller.signal.aborted || (err as { name?: string }).name === "AbortError" || (err as { name?: string }).name === "TimeoutError";
      // The request may have reached the backend and been worked on, so the cost is unknown, not zero.
      return timedOut
        ? { outcome: "timeout", status: null, usage: null, billed: "unknown", error: new DecisionError("timeout", `no reply in ${this.timeoutMs / 1000}s`) }
        : { outcome: "network", status: null, usage: null, billed: "unknown", error: new DecisionError("network", `could not reach the backend: ${scrub(String((err as Error)?.message ?? err)).slice(0, 200)}`) };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return this.failure(res, text);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { outcome: "invalid_reply", status: res.status, usage: null, billed: "unknown", error: new DecisionError("malformed", "the reply was not JSON") };
    }
    const shaped = ApiResponse.safeParse(json);
    if (!shaped.success) return { outcome: "invalid_reply", status: res.status, usage: readUsage((json as { usage?: unknown } | null)?.usage), billed: "unknown", error: new DecisionError("malformed", "the reply had no list of answers") };
    const usage = readUsage(shaped.data.usage);
    try {
      const answers = readAnswers(questions, shaped.data.answers);
      return { outcome: "ok", status: res.status, usage, billed: "yes", answers, refusals: Object.values(answers).filter((a) => a.type === "refusal").length };
    } catch (err) {
      const error = err instanceof DecisionError ? err : new DecisionError("malformed", String(err));
      // A reply that came back was worked on and is billed, whether or not it can be used.
      return { outcome: "invalid_reply", status: res.status, usage, billed: "yes", error };
    }
  }

  private failure(res: Response, text: string): Attempt {
    const parsed = ApiError.safeParse(safeJson(text));
    const code = parsed.success ? (parsed.data.error.code ?? parsed.data.error.type ?? "") : "";
    const said = scrub(parsed.success ? (parsed.data.error.message ?? "") : text).slice(0, 300);
    const status = res.status;
    const base = { status, usage: null } as const;
    if (status === 401 || status === 403) return { ...base, outcome: "rejected", billed: "no", error: new DecisionError("auth", `the backend did not accept OPENAI_API_KEY (${status}). ${said}`, status) };
    if (status === 429 && /insufficient_quota|billing/i.test(code)) return { ...base, outcome: "quota", billed: "no", error: new DecisionError("quota", `the OpenAI account has no credit left for this key. ${said}`, status) };
    if (status === 429) {
      const after = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : undefined;
      if (retryAfterMs !== undefined && retryAfterMs > DECISIONS.retryMaxMs) return { ...base, outcome: "rate_limited", billed: "no", final: true, error: new DecisionError("rate_limited", `rate limited, and asked to wait ${Math.round(after)}s, longer than this tool waits. ${said}`, status) };
      return { ...base, outcome: "rate_limited", billed: "no", error: new DecisionError("rate_limited", `rate limited after every retry. ${said}`, status), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    // A server error can come after the model ran, so its cost is unknown.
    if (status >= 500) return { ...base, outcome: "server_error", billed: "unknown", error: new DecisionError("server", `the backend failed (${status}). ${said}`, status) };
    const tooLong = /context[_ ]length|context[_ ]window|too long|too large|maximum context|max(imum)? (input|tokens)/i.test(`${code} ${said}`) || status === 413;
    return { ...base, outcome: "rejected", billed: "no", error: new DecisionError(tooLong ? "too_long" : "rejected", `the backend refused the request (${status}). ${said}`, status) };
  }

  private record(a: Attempt, m: { call: DecisionCall; attempt: number; count: number; bound: number; ms: number }): void {
    const costUsd = a.usage ? estimateCostUsd(a.usage) : a.billed === "no" ? 0 : null;
    const line: UsageLine = {
      v: 1,
      at: new Date().toISOString(),
      run: THIS_RUN.id,
      command: THIS_RUN.command,
      backend: this.identity.backend,
      model: this.identity.model,
      stage: m.call.stage,
      jobId: m.call.jobId ?? null,
      attempt: m.attempt,
      outcome: a.outcome,
      status: a.status,
      questions: m.count,
      refusals: a.refusals ?? 0,
      usage: a.usage,
      costUsd,
      boundUsd: costUsd === null ? m.bound : null,
      ms: m.ms,
    };
    this.usage.attempts++;
    if (a.usage) {
      this.usage.inputTokens += a.usage.inputTokens;
      this.usage.cachedTokens += a.usage.cachedTokens;
      this.usage.cacheWriteTokens += a.usage.cacheWriteTokens;
      this.usage.outputTokens += a.usage.outputTokens;
    }
    if (costUsd === null) {
      this.usage.unknownAttempts++;
      this.usage.unknownBoundUsd += chargeOf(line);
    } else this.usage.estimatedUsd += costUsd;
    if (!this.usageLog) return;
    try {
      appendUsage(this.usageLog, line);
    } catch {
      /* The limits of this process still hold from its own count. */
    }
  }
}

function decisionSettingsOrThrow(opts: OpenAIDecisionsOptions) {
  try {
    // A key given in code still takes its limits from the settings.
    return decisionSettings(opts.apiKey !== undefined ? { ...process.env, OPENAI_API_KEY: opts.apiKey } : process.env);
  } catch (e) {
    throw new DecisionError("config", e instanceof Error ? e.message : String(e));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The decision backend for a command, from the settings. */
export const createDecider = (): Decider => new OpenAIDecisions();

/** One line on what a process's decisions cost, with what is unknown kept apart from the estimate. */
export function usageLine(u: DecisionUsage): string {
  const parts = [`${u.calls} call${u.calls === 1 ? "" : "s"}`, `about $${u.estimatedUsd.toFixed(4)} (estimated from reported tokens)`];
  if (u.unknownAttempts) parts.push(`${u.unknownAttempts} attempt${u.unknownAttempts === 1 ? "" : "s"} of unknown cost, at most $${u.unknownBoundUsd.toFixed(4)} more`);
  if (u.retries) parts.push(`${u.retries} retr${u.retries === 1 ? "y" : "ies"}`);
  if (u.failed) parts.push(`${u.failed} failed`);
  return parts.join(", ");
}
