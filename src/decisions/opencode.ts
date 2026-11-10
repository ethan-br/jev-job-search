/**
 * The optional decision backend: TypeSafe Jev 1.13 through OpenCode
 * (POST /inference/systemone/v1/systemone).
 *
 * One call is one state and many typed questions. This file maps the application's neutral
 * questions onto Jev's `noul`, `choice` and `score`, checks the reply before any of it is used,
 * and tries again only what is worth trying again. The model is `jev-1.13-free`. The paid model
 * id `jev-1.13` is not called, and a failure here is not sent to OpenAI.
 *
 * The endpoint, the model id and the free price were read from
 * https://opencode.ai/docs/console/models/ on the date in `OPENCODE_DECISIONS.pricing.verifiedOn`.
 * Answer fields that page points at TypeSafe for were read from
 * https://docs.typesafe.ai/api/system-one and the noul, choice and score pages.
 */
import { DECISIONS, OPENCODE_DECISIONS, PATHS } from "../config.js";
import { decisionLimits, type DecisionLimits } from "../settings.js";
import { registerSecret, scrub } from "../util/redact.js";
import { THIS_RUN } from "../util/run.js";
import { z } from "zod";
import { checkQuestions } from "./limits.js";
import { DecisionError, type Answer, type Answers, type DecisionCall, type Decider, type DecisionInput, type DecisionUsage, type DeciderIdentity, type Question, type Questions } from "./types.js";
import { appendUsage, chargeOf, spentSince, type Outcome, type TokenUsage, type UsageLine } from "./usage.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OpenCodeDecisionsOptions = {
  apiKey?: string;
  /** Where the key and the spend limits are read from when they are not passed in. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  endpoint?: string;
  runCapUsd?: number;
  budgetUsd?: number | null;
  usageLog?: string | null;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const unit = z.number().min(0).max(1);

/** A Jev answer. A noul is a probability and has no confidence field. A refusal is accepted when the reply says so. */
const JevAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: unit }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), unit).nullish(),
    confidence: unit.nullish(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), unit).nullish(),
    confidence: unit.nullish(),
    legend: z.record(z.string(), z.unknown()).nullish(),
  }),
  z.object({ type: z.literal("refusal") }),
]);
type JevAnswer = z.infer<typeof JevAnswer>;

const Envelope = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.unknown().optional(),
  model: z.string().optional(),
});

export type PricedCost = { costUsd: number; costKind: "free" | "reported" } | { costUsd: null; costKind: null };

/**
 * The price of one reply. Zero only when the reply names zero, or names no usable price and the
 * model's documented price is free. A reply that names no price for any other model is unknown.
 * An unreadable price is unknown as well: it is not replaced with the documented free price, and
 * it is not priced from the OpenAI table.
 */
export function priceOf(model: string, usage: unknown): PricedCost {
  const reported = numericCost(usage);
  if (reported === "unreadable") return { costUsd: null, costKind: null };
  if (reported === 0) return { costUsd: 0, costKind: "free" };
  if (typeof reported === "number") return { costUsd: reported, costKind: "reported" };
  if (model === OPENCODE_DECISIONS.model && OPENCODE_DECISIONS.pricing.free) return { costUsd: 0, costKind: "free" };
  return { costUsd: null, costKind: null };
}

/** A usable non-negative price named on the usage object, or null when the reply names none. */
function numericCost(usage: unknown): number | null | "unreadable" {
  if (usage === undefined || usage === null) return null;
  if (typeof usage !== "object") return "unreadable";
  const row = usage as Record<string, unknown>;
  const values = [row.cost_usd, row.cost].filter((value) => value !== undefined && value !== null);
  if (values.length === 0) return null;
  const usable = values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (!usable) return "unreadable";
  const first = values[0] as number;
  if (values.some((value) => value !== first)) return "unreadable";
  return first;
}

const JevTokens = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
});

/** Tokens the reply reported. Null when it reported none that can be read. Never a guess. */
export function readTokens(raw: unknown): TokenUsage | null {
  const parsed = JevTokens.safeParse(raw);
  if (!parsed.success) return null;
  return { inputTokens: parsed.data.input_tokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: parsed.data.output_tokens };
}

/** The state Jev judges. Shared facts and this call's evidence travel together. There is no cache breakpoint: the price table has no cache price for this model. */
export function buildState(input: DecisionInput): unknown {
  if (input.shared === undefined) return input.evidence;
  return { shared: input.shared, evidence: input.evidence };
}

/** One question as Jev takes it. A predicate is a noul. Its yes and no meanings go in criteria, and no confidence is added. */
export function toJevQuestion(q: Question): Record<string, unknown> {
  if (q.type === "predicate") {
    const question: Record<string, unknown> = { type: "noul", instructions: q.instructions };
    if (q.when) question.criteria = { true: q.when.true, false: q.when.false };
    return question;
  }
  if (q.type === "choice") return { type: "choice", instructions: q.instructions, criteria: q.choices };
  return {
    type: "score",
    instructions: q.instructions,
    criteria: q.levels.map((level) => (level.description ? { label: level.label, description: level.description } : level.label)),
  };
}

export function buildRequest(input: DecisionInput, questions: Questions): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) mapped[name] = toJevQuestion(question);
  return { model: OPENCODE_DECISIONS.model, state: buildState(input), questions: mapped };
}

/**
 * Checks the reply's answers against the questions. Every question is answered once, by its own
 * type or by a refusal. A noul becomes a predicate probability, with no confidence attached.
 * A choice is one that was offered. A score is inside its scale. A probability is from 0 to 1.
 */
export function readAnswers(questions: Questions, raw: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const [name, item] of Object.entries(raw)) {
    const parsed = JevAnswer.safeParse(item);
    if (!parsed.success) throw new DecisionError("malformed", `an answer is not in a known shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 2).join("; ")}`);
    const question = questions[name];
    if (!question || !Object.hasOwn(questions, name)) throw new DecisionError("incomplete", `an answer came back for "${name}", which was not asked`);
    if (Object.hasOwn(out, name)) throw new DecisionError("incomplete", `"${name}" was answered twice`);
    out[name] = toAnswer(name, parsed.data, question);
  }
  const missing = Object.keys(questions).filter((key) => !Object.hasOwn(out, key));
  if (missing.length) throw new DecisionError("incomplete", `${missing.length} of ${Object.keys(questions).length} questions were left unanswered: ${missing.slice(0, 5).join(", ")}`);
  return Object.fromEntries(Object.keys(questions).map((key) => [key, out[key] as Answer]));
}

function toAnswer(name: string, answer: JevAnswer, question: Question): Answer {
  if (answer.type === "refusal") return { type: "refusal" };
  if (answer.type === "noul") {
    if (question.type !== "predicate") throw new DecisionError("malformed", `"${name}" is a ${question.type} question and was answered as noul`);
    return { type: "predicate", probability: answer.noul };
  }
  if (answer.type === "choice") {
    if (question.type !== "choice") throw new DecisionError("malformed", `"${name}" is a ${question.type} question and was answered as choice`);
    if (!Object.hasOwn(question.choices, answer.choice)) throw new DecisionError("malformed", `"${name}" was answered with ${JSON.stringify(answer.choice)}, which is not one of its choices`);
    const probabilities: Record<string, number> = {};
    for (const [value, probability] of Object.entries(answer.probabilities ?? {})) {
      if (!Object.hasOwn(question.choices, value)) throw new DecisionError("malformed", `"${name}" has a probability for ${JSON.stringify(value)}, which is not one of its choices`);
      probabilities[value] = probability;
    }
    return { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence ?? null };
  }
  if (question.type !== "score") throw new DecisionError("malformed", `"${name}" is a ${question.type} question and was answered as score`);
  const top = question.levels.length - 1;
  if (!(answer.score >= 0 && answer.score <= top + 1e-6)) throw new DecisionError("malformed", `"${name}" scored ${answer.score} on a scale of 0 to ${top}`);
  const probabilities: number[] = [];
  const reported = answer.probabilities ?? {};
  const keys = Object.keys(reported);
  if (keys.length) {
    const byLevel = new Map<number, number>();
    for (const key of keys) {
      if (!/^\d+$/.test(key) || String(Number(key)) !== key) throw new DecisionError("malformed", `"${name}" has a probability for level ${JSON.stringify(key)} on a scale of 0 to ${top}`);
      const index = Number(key);
      if (index > top || byLevel.has(index)) throw new DecisionError("malformed", `"${name}" has a probability for level ${key} on a scale of 0 to ${top}`);
      const probability = reported[key];
      if (probability === undefined) throw new DecisionError("malformed", `"${name}" has a probability for level ${key} that could not be read`);
      byLevel.set(index, probability);
    }
    if (byLevel.size !== question.levels.length) throw new DecisionError("malformed", `"${name}" left a level out of its probabilities`);
    for (let index = 0; index <= top; index++) probabilities.push(byLevel.get(index) as number);
  }
  return { type: "score", score: Math.min(answer.score, top), levels: question.levels.length, probabilities, confidence: answer.confidence ?? null };
}

const RETRIED: readonly Outcome[] = ["rate_limited", "server_error", "timeout", "network"];

type Attempt = {
  outcome: Outcome;
  status: number | null;
  usage: TokenUsage | null;
  costUsd: number | null;
  costKind: UsageLine["costKind"];
  answers?: Answers;
  refusals?: number;
  error?: DecisionError;
  retryAfterMs?: number;
  /** Not worth another try, whatever the outcome. */
  final?: boolean;
};

export class OpenCodeDecisions implements Decider {
  readonly identity: DeciderIdentity;
  readonly usage: DecisionUsage = { calls: 0, attempts: 0, retries: 0, failed: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, estimatedUsd: 0, unknownAttempts: 0, unknownBoundUsd: 0, freeAttempts: 0 };
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

  constructor(opts: OpenCodeDecisionsOptions = {}) {
    const env = opts.env ?? process.env;
    const needsLimits = opts.runCapUsd === undefined || opts.budgetUsd === undefined;
    const limits = needsLimits ? limitsOrThrow(env) : null;
    this.apiKey = opts.apiKey ?? keyOrThrow(env);
    if (!this.apiKey) throw new DecisionError("config", "there is no API key for decisions");
    registerSecret(this.apiKey);
    const openaiKey = (env.OPENAI_API_KEY ?? "").trim();
    if (openaiKey) registerSecret(openaiKey);
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = opts.endpoint ?? OPENCODE_DECISIONS.endpoint;
    this.identity = { backend: OPENCODE_DECISIONS.backend, model: OPENCODE_DECISIONS.model, requestVersion: OPENCODE_DECISIONS.requestVersion };
    this.runCapUsd = opts.runCapUsd ?? limits?.runCapUsd ?? DECISIONS.runSpendCapUsd;
    this.budgetUsd = opts.budgetUsd === undefined ? (limits?.budgetUsd ?? null) : opts.budgetUsd;
    this.usageLog = opts.usageLog === undefined ? PATHS.decisionsUsage : opts.usageLog;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = opts.timeoutMs ?? DECISIONS.timeoutMs;
    this.spentBefore = this.usageLog && this.budgetUsd !== null ? spentSince(this.usageLog).totalUsd : 0;
  }

  async decide(input: DecisionInput, questions: Questions, call: DecisionCall): Promise<Answers> {
    const count = Object.keys(questions).length;
    if (count === 0) return {};
    checkQuestions(questions);
    const body = JSON.stringify(buildRequest(input, questions));
    const where = `${call.stage}${call.jobId ? ` for ${call.jobId}` : ""}`;

    let last: Attempt | null = null;
    for (let attempt = 1; attempt <= DECISIONS.maxRetries + 1; attempt++) {
      this.checkLimits(where);
      if (attempt > 1) {
        this.usage.retries++;
        await this.sleep(Math.min(DECISIONS.retryMaxMs, last?.retryAfterMs ?? DECISIONS.retryBaseMs * 2 ** (attempt - 2)));
      }
      const started = Date.now();
      last = await this.attempt(body, questions);
      this.record(last, { call, attempt, count, ms: Date.now() - started });
      if (last.answers) {
        this.usage.calls++;
        return last.answers;
      }
      if (last.final || !RETRIED.includes(last.outcome)) break;
    }
    this.usage.failed++;
    const error = last?.error ?? new DecisionError("server", "the decision call failed");
    throw new DecisionError(error.kind, `decisions (${where}): ${error.message}`, error.status);
  }

  private checkLimits(where: string): void {
    const run = this.usage.estimatedUsd + this.usage.unknownBoundUsd;
    if (run > this.runCapUsd) {
      throw new DecisionError("spend_limit", `decisions (${where}): this command has used about $${run.toFixed(4)} of its $${this.runCapUsd} limit. Nothing was sent. The limit is DECISIONS_RUN_CAP_USD.`);
    }
    if (this.budgetUsd !== null && this.spentBefore + run > this.budgetUsd) {
      throw new DecisionError("spend_limit", `decisions (${where}): about $${(this.spentBefore + run).toFixed(4)} of the $${this.budgetUsd} budget is used. Nothing was sent. The budget is DECISIONS_BUDGET_USD.`);
    }
  }

  private async attempt(body: string, questions: Questions): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const timedOut = controller.signal.aborted || (err as { name?: string }).name === "AbortError" || (err as { name?: string }).name === "TimeoutError";
      const price = priceOf(this.identity.model, undefined);
      return timedOut
        ? { outcome: "timeout", status: null, usage: null, ...splitPrice(price), error: new DecisionError("timeout", `no reply in ${this.timeoutMs / 1000}s`) }
        : { outcome: "network", status: null, usage: null, ...splitPrice(price), error: new DecisionError("network", `could not reach the backend: ${scrub(String((err as Error)?.message ?? err)).slice(0, 200)}`) };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return this.failure(res, text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { outcome: "invalid_reply", status: res.status, usage: null, ...splitPrice(priceOf(this.identity.model, undefined)), error: new DecisionError("malformed", "the reply was not JSON") };
    }
    const shaped = Envelope.safeParse(json);
    if (!shaped.success) {
      return { outcome: "invalid_reply", status: res.status, usage: readTokens((json as { usage?: unknown } | null)?.usage), ...splitPrice(priceOf(this.identity.model, (json as { usage?: unknown } | null)?.usage)), error: new DecisionError("malformed", "the reply had no answers") };
    }
    const usage = readTokens(shaped.data.usage);
    const price = splitPrice(priceOf(this.identity.model, shaped.data.usage));
    try {
      const answers = readAnswers(questions, shaped.data.answers);
      return { outcome: "ok", status: res.status, usage, ...price, answers, refusals: Object.values(answers).filter((answer) => answer.type === "refusal").length };
    } catch (err) {
      const error = err instanceof DecisionError ? err : new DecisionError("malformed", String(err));
      return { outcome: "invalid_reply", status: res.status, usage, ...price, error };
    }
  }

  private failure(res: Response, text: string): Attempt {
    const parsed = errorParts(safeJson(text));
    const said = scrub(parsed.message || text).slice(0, 300);
    const status = res.status;
    const price = splitPrice(priceOf(this.identity.model, undefined));
    const base = { status, usage: null, ...price } as const;
    if (status === 401 || status === 403) return { ...base, outcome: "rejected", final: true, error: new DecisionError("auth", `the backend did not accept OPENCODE_API_KEY (${status}). ${said}`, status) };
    if (status === 402 || (status === 429 && /insufficient_quota|billing|payment/i.test(`${parsed.code} ${said}`))) {
      return { ...base, outcome: "quota", final: true, error: new DecisionError("quota", `the OpenCode account cannot pay for this call. ${said}`, status) };
    }
    if (status === 429) {
      const after = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : undefined;
      if (retryAfterMs !== undefined && retryAfterMs > DECISIONS.retryMaxMs) {
        return { ...base, outcome: "rate_limited", final: true, error: new DecisionError("rate_limited", `rate limited, and asked to wait ${Math.round(after)}s, longer than this tool waits. ${said}`, status) };
      }
      return { ...base, outcome: "rate_limited", error: new DecisionError("rate_limited", `rate limited after every retry. ${said}`, status), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    if (status >= 500) return { ...base, outcome: "server_error", error: new DecisionError("server", `the backend failed (${status}). ${said}`, status) };
    const tooLong = status === 413 || /max_tokens_exceeded|context[_ ]length|context[_ ]window|too long|too large|maximum context/i.test(`${parsed.code} ${said}`);
    return { ...base, outcome: "rejected", final: true, error: new DecisionError(tooLong ? "too_long" : "rejected", `the backend refused the request (${status}). ${said}`, status) };
  }

  private record(attempt: Attempt, meta: { call: DecisionCall; attempt: number; count: number; ms: number }): void {
    const line: UsageLine = {
      v: 1,
      at: new Date().toISOString(),
      run: THIS_RUN.id,
      command: THIS_RUN.command,
      backend: this.identity.backend,
      model: this.identity.model,
      stage: meta.call.stage,
      jobId: meta.call.jobId ?? null,
      attempt: meta.attempt,
      outcome: attempt.outcome,
      status: attempt.status,
      questions: meta.count,
      refusals: attempt.refusals ?? 0,
      usage: attempt.usage,
      costUsd: attempt.costUsd,
      ...(attempt.costKind ? { costKind: attempt.costKind } : {}),
      // Unknown stays null. This backend has no price table to turn a missing price into a bound, and the OpenAI prices are not used.
      boundUsd: null,
      ms: meta.ms,
    };
    this.usage.attempts++;
    if (attempt.usage) {
      this.usage.inputTokens += attempt.usage.inputTokens;
      this.usage.cachedTokens += attempt.usage.cachedTokens;
      this.usage.cacheWriteTokens += attempt.usage.cacheWriteTokens;
      this.usage.outputTokens += attempt.usage.outputTokens;
    }
    if (attempt.costKind === "free") this.usage.freeAttempts = (this.usage.freeAttempts ?? 0) + 1;
    if (attempt.costUsd === null) {
      this.usage.unknownAttempts++;
      this.usage.unknownBoundUsd += chargeOf(line);
    } else if (attempt.costKind !== "free") this.usage.estimatedUsd += attempt.costUsd;
    if (!this.usageLog) return;
    try {
      appendUsage(this.usageLog, line);
    } catch {
      /* The limits of this process still hold from its own count. */
    }
  }
}

function splitPrice(price: PricedCost): { costUsd: number | null; costKind: UsageLine["costKind"] } {
  if (price.costUsd === null) return { costUsd: null, costKind: undefined };
  return { costUsd: price.costUsd, costKind: price.costKind };
}

function keyOrThrow(env: NodeJS.ProcessEnv): string {
  try {
    const apiKey = (env.OPENCODE_API_KEY ?? "").trim();
    if (!apiKey) throw new Error("OPENCODE_API_KEY is not set. Copy .env.example to .env and put your key after OPENCODE_API_KEY= in that file. Do not paste the key into a chat.");
    if (/\s/.test(apiKey)) throw new Error("OPENCODE_API_KEY has a space or a line break in it. It must be the key alone.");
    return apiKey;
  } catch (err) {
    throw new DecisionError("config", err instanceof Error ? err.message : String(err));
  }
}

function limitsOrThrow(env: NodeJS.ProcessEnv): DecisionLimits {
  try {
    return decisionLimits(env);
  } catch (err) {
    throw new DecisionError("config", err instanceof Error ? err.message : String(err));
  }
}

function errorParts(raw: unknown): { message: string; code: string } {
  if (!raw || typeof raw !== "object") return { message: "", code: "" };
  const body = raw as { detail?: unknown; error?: { message?: unknown; code?: unknown; type?: unknown } };
  if (typeof body.detail === "string") return { message: body.detail, code: "" };
  if (Array.isArray(body.detail)) {
    const messages: string[] = [];
    const codes: string[] = [];
    for (const item of body.detail) {
      if (!item || typeof item !== "object") continue;
      const row = item as { msg?: unknown; type?: unknown };
      if (typeof row.msg === "string") messages.push(row.msg);
      if (typeof row.type === "string") codes.push(row.type);
    }
    return { message: messages.join("; "), code: codes.join(" ") };
  }
  if (body.detail && typeof body.detail === "object") {
    const row = body.detail as { message?: unknown; code?: unknown; type?: unknown };
    const message = typeof row.message === "string" ? row.message : "";
    const code = typeof row.code === "string" ? row.code : typeof row.type === "string" ? row.type : "";
    return { message, code };
  }
  const error = body.error;
  if (error && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message : "";
    const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "";
    return { message, code };
  }
  return { message: "", code: "" };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
