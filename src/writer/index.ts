/** The writer turns typed tasks into checked output. Nothing here names a harness, model or provider. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DOCTOR, PATHS, WRITER } from "../config.js";
import { SettingsError, writerSettings, type BillingMode, type WriterSettings } from "../settings.js";
import { hashOf } from "../util/cache.js";
import { THIS_RUN } from "../util/run.js";
import { WRITER_CONTRACT, WriterError, type TaskKind } from "./contract.js";
import type { WriterRequest, WriterResponse } from "./contract.js";
import { runWriterCommand } from "./command.js";
import type { RunOptions } from "./command.js";
import { appendWriterUsage } from "./usage.js";
import type { WriterUsageLine } from "./usage.js";

export type { TaskKind } from "./contract.js";
export { WriterError, writerStopsEveryCall } from "./contract.js";

export type OutputSpec<T> = {
  version: number;
  jsonSchema: Record<string, unknown>;
  parse: (value: unknown) => T;
};

export type WriterTask<T> = {
  kind: TaskKind;
  jobId: string | null;
  system: string;
  input: string;
  promptVersion: number;
  output: OutputSpec<T>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type Written<T> = {
  output: T;
  writer: WriterResponse["writer"];
  billing: BillingMode;
  usage: NonNullable<WriterResponse["usage"]> | null;
  costUsd: number | null;
};

export interface Writer {
  readonly identity: string;
  write<T>(task: WriterTask<T>): Promise<Written<T>>;
}

export type WriterTotals = {
  calls: number;
  failed: number;
  byBilling: Record<BillingMode, number>;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  tokensUnknown: number;
  knownCostUsd: number;
  costUnknown: number;
};

export const writerUsage: WriterTotals = {
  calls: 0,
  failed: 0,
  byBilling: { subscription: 0, metered: 0, free: 0, unknown: 0 },
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  tokensUnknown: 0,
  knownCostUsd: 0,
  costUnknown: 0,
};

export type CreateOptions = {
  run?: typeof runWriterCommand;
  usageLog?: string | null;
};

function outcomeOf(error: unknown): WriterUsageLine["outcome"] {
  if (!(error instanceof WriterError)) return "spawn";
  switch (error.kind) {
    case "billing": return "billing_refused";
    case "config": return "spawn";
    case "invalid_output": return "invalid_output";
    case "malformed": return "malformed";
    case "exit": return "exit";
    case "spawn": return "spawn";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "output_limit": return "output_limit";
  }
}

export function createWriter(settings: WriterSettings, opts: CreateOptions = {}): Writer {
  const identity = hashOf({ contract: WRITER_CONTRACT, command: settings.identity });
  const run = opts.run ?? runWriterCommand;
  const usageLog = opts.usageLog === undefined ? (process.env.NODE_ENV === "test" ? null : PATHS.writerUsage) : opts.usageLog;
  return {
    identity,
    async write<T>(task: WriterTask<T>): Promise<Written<T>> {
      const started = Date.now();
      let response: WriterResponse | null = null;
      let outcome: WriterUsageLine["outcome"] = "ok";
      try {
        const request: WriterRequest = {
          contract: WRITER_CONTRACT,
          task: { kind: task.kind, id: randomUUID(), jobId: task.jobId, promptVersion: task.promptVersion, schemaVersion: task.output.version },
          system: task.system,
          input: task.input,
          output: { format: "json", schema: task.output.jsonSchema },
          timeoutMs: task.timeoutMs ?? WRITER.timeoutMs,
          settings: { effort: WRITER.effort[task.kind] },
        };
        const runOptions: RunOptions = task.signal ? { signal: task.signal } : {};
        response = await run(request, settings, runOptions);
        if (!settings.billing.includes(response.billing)) {
          throw new WriterError("billing", `The writer reported ${response.billing}, but WRITER_BILLING accepts ${settings.billing.join(", ")}. Nothing it wrote was used. Add the mode to WRITER_BILLING if that is meant.`);
        }
        let output: T;
        try {
          output = task.output.parse(response.output);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new WriterError("invalid_output", message.slice(0, 400));
        }
        writerUsage.byBilling[response.billing]++;
        return { output, writer: response.writer, billing: response.billing, usage: response.usage, costUsd: response.costUsd };
      } catch (error) {
        outcome = outcomeOf(error);
        throw error;
      } finally {
        writerUsage.calls++;
        if (outcome !== "ok") writerUsage.failed++;
        if (response) {
          const usage = response.usage;
          if (!usage || usage.inputTokens === null || usage.outputTokens === null) writerUsage.tokensUnknown++;
          else {
            writerUsage.inputTokens += usage.inputTokens;
            writerUsage.outputTokens += usage.outputTokens;
            writerUsage.cachedInputTokens += usage.cachedInputTokens ?? 0;
          }
          if (response.billing === "metered" || response.billing === "unknown") {
            if (typeof response.costUsd === "number") writerUsage.knownCostUsd += response.costUsd;
            else writerUsage.costUnknown++;
          }
        } else {
          writerUsage.tokensUnknown++;
          writerUsage.costUnknown++;
        }
        if (usageLog !== null) {
          try {
            appendWriterUsage(usageLog, {
              v: 1, at: new Date().toISOString(), run: THIS_RUN.id, command: THIS_RUN.command,
              task: task.kind, jobId: task.jobId, identity,
              writer: response?.writer.name ?? null, model: response?.writer.model ?? null,
              outcome, billing: response?.billing ?? null, usage: response?.usage ?? null,
              costUsd: response?.costUsd ?? null, ms: Date.now() - started,
            });
          } catch { /* Usage logging must not fail a writer call. */ }
        }
      }
    },
  };
}

let testWriter: Writer | null = null;
let processWriter: Writer | null = null;

export function setWriterForTests(writer: Writer | null): void {
  testWriter = writer;
}

export function getWriter(): Writer {
  if (testWriter) return testWriter;
  if (processWriter) return processWriter;
  try {
    processWriter = createWriter(writerSettings());
    return processWriter;
  } catch (error) {
    if (error instanceof SettingsError) throw new WriterError("config", error.message);
    throw error;
  }
}

export function writerFingerprint(kind: TaskKind, promptVersion: number, schemaVersion: number): string {
  return hashOf({ writer: getWriter().identity, kind, promptVersion, schemaVersion, effort: WRITER.effort[kind] });
}

export async function probeWriter(timeoutMs = DOCTOR.writerProbeTimeoutMs): Promise<Written<{ ok: true }>> {
  return getWriter().write({
    kind: "probe", jobId: null,
    system: "You are being checked for a working connection. Reply with the JSON object asked for.",
    input: 'Reply with {"ok": true}.', promptVersion: 1, timeoutMs,
    output: {
      version: 1,
      jsonSchema: { type: "object", properties: { ok: { type: "boolean", enum: [true] } }, required: ["ok"], additionalProperties: false },
      parse: (value: unknown) => z.object({ ok: z.literal(true) }).parse(value),
    },
  });
}

export function writerUsageLine(u: WriterTotals = writerUsage): string {
  const parts = [`${u.calls.toLocaleString("en-US")} calls`];
  const paid = (["subscription", "free", "metered"] as const).filter((mode) => u.byBilling[mode] > 0).map((mode) => `${u.byBilling[mode].toLocaleString("en-US")} ${mode === "subscription" ? "on a subscription" : mode}`);
  if (paid.length) parts.push(paid.join(", "));
  if (u.failed) parts.push(`${u.failed.toLocaleString("en-US")} failed`);
  const tokens = u.inputTokens + u.outputTokens;
  if (tokens) parts.push(`${u.inputTokens.toLocaleString("en-US")} tokens in and ${u.outputTokens.toLocaleString("en-US")} out reported`);
  if (u.tokensUnknown) parts.push(`${u.tokensUnknown.toLocaleString("en-US")} calls reported no tokens`);
  if (u.knownCostUsd) parts.push(`metered cost $${u.knownCostUsd.toFixed(4)} reported`);
  if (u.costUnknown) parts.push(`cost unknown for ${u.costUnknown.toLocaleString("en-US")} call${u.costUnknown === 1 ? "" : "s"}`);
  return `writer: ${parts.join(", ")}`;
}
