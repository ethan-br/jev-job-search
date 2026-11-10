import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECISIONS } from "../src/config.js";
import { OpenAIDecisions } from "../src/decisions/openai.js";
import { boundCostUsd, chargeOf, estimateCostUsd, readUsage as readLog, spentSince, type TokenUsage } from "../src/decisions/usage.js";
import { predicate } from "../src/decisions/types.js";
import { THIS_RUN } from "../src/util/run.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "js-usage-"));
  dirs.push(dir);
  return path.join(dir, "usage.jsonl");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const usage: TokenUsage = { inputTokens: 1_000_000, cachedTokens: 100_000, cacheWriteTokens: 100_000, outputTokens: 900_000 };

describe("usage costs", () => {
  it("prices input, cache reads and writes within inputTokens and applies long context above the limit", () => {
    expect(estimateCostUsd({ ...usage, cachedTokens: 0, cacheWriteTokens: 0 })).toBe(DECISIONS.pricing.inputPerMillion * DECISIONS.pricing.longContextMultiplier);
    // A request over the long-context limit is charged at the multiplier for all of it, cached parts included.
    const flat = (800_000 * DECISIONS.pricing.inputPerMillion + 100_000 * DECISIONS.pricing.cachedInputPerMillion + 100_000 * DECISIONS.pricing.cacheWritePerMillion) / 1_000_000;
    expect(estimateCostUsd(usage)).toBeCloseTo(flat * DECISIONS.pricing.longContextMultiplier);
    const short: TokenUsage = { inputTokens: 100_000, cachedTokens: 10_000, cacheWriteTokens: 10_000, outputTokens: 0 };
    expect(estimateCostUsd(short)).toBeCloseTo((80_000 * DECISIONS.pricing.inputPerMillion + 10_000 * DECISIONS.pricing.cachedInputPerMillion + 10_000 * DECISIONS.pricing.cacheWritePerMillion) / 1_000_000);
    expect(estimateCostUsd({ ...usage, inputTokens: DECISIONS.pricing.longContextTokens })).toBeLessThan(estimateCostUsd({ ...usage, inputTokens: DECISIONS.pricing.longContextTokens + 1 }));
    expect(estimateCostUsd({ ...usage, outputTokens: 0 })).toBe(estimateCostUsd({ ...usage, outputTokens: 999 }));
  });
  it("bounds bodies conservatively and charges estimates or unknown bounds", () => {
    expect(boundCostUsd(400)).toBeGreaterThan(estimateCostUsd({ inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }));
    expect(boundCostUsd(800)).toBeGreaterThan(boundCostUsd(400));
    expect(chargeOf({ costUsd: 0.3, boundUsd: 8 })).toBe(0.3);
    expect(chargeOf({ costUsd: null, boundUsd: 8 })).toBe(8);
  });
});

describe("attempt records", () => {
  async function invoke(file: string, responses: Array<{ status: number; body: unknown }>, evidence = "example") {
    let i = 0;
    const key = `secret-${Math.random()}-never-log`;
    const client = new OpenAIDecisions({ apiKey: key, runCapUsd: 100, budgetUsd: null, usageLog: file, sleep: async () => {}, fetchImpl: async () => {
      const next = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(next.body), { status: next.status });
    } });
    try { await client.decide({ evidence }, { fit: predicate("Is this relevant?") }, { stage: "screening", jobId: "job-1" }); } catch { /* Failure attempts are still recorded. */ }
    const data = readLog(file);
    expect(readFileSync(file, "utf8")).not.toContain(key);
    return data.lines;
  }
  const ok = { answers: [{ type: "predicate", name: "fit", probability: 0.8 }], model: DECISIONS.model, usage: { input_tokens: 12, input_tokens_details: {}, output_tokens: 3 } };
  it("records success metadata and reported usage", async () => {
    const line = (await invoke(temp(), [{ status: 200, body: ok }]))[0]!;
    expect(line).toMatchObject({ v: 1, run: THIS_RUN.id, command: THIS_RUN.command, backend: "openai-decisions", model: DECISIONS.model, stage: "screening", jobId: "job-1", attempt: 1, outcome: "ok", usage: { inputTokens: 12, outputTokens: 3 }, boundUsd: null });
    expect(typeof line.costUsd).toBe("number");
  });
  it("records unknown costs, known rejection, retry, refusal and invalid answers", async () => {
    expect((await invoke(temp(), [{ status: 200, body: { answers: ok.answers } }]))[0]!.costUsd).toBeNull();
    const unknown = await invoke(temp(), [{ status: 500, body: {} }]);
    expect(unknown[0]).toMatchObject({ costUsd: null }); expect(unknown[0]!.boundUsd).toBeGreaterThan(0);
    const timeoutFile = temp();
    const timeoutClient = new OpenAIDecisions({ apiKey: "another-runtime-secret", runCapUsd: 100, budgetUsd: null, usageLog: timeoutFile, sleep: async () => {}, timeoutMs: 1, fetchImpl: async () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 5)) });
    await expect(timeoutClient.decide({ evidence: "x" }, { fit: predicate("Relevant?") }, { stage: "screening" })).rejects.toThrow();
    expect(readLog(timeoutFile).lines[0]).toMatchObject({ costUsd: null, outcome: "timeout" });
    expect((await invoke(temp(), [{ status: 400, body: { error: { message: "no", code: "invalid" } } }]))[0]!.costUsd).toBe(0);
    const retry = await invoke(temp(), [{ status: 429, body: {} }, { status: 200, body: ok }]);
    expect(retry.map(x => [x.attempt, x.outcome])).toEqual([[1, "rate_limited"], [2, "ok"]]);
    const refused = await invoke(temp(), [{ status: 200, body: { ...ok, answers: [{ type: "refusal", name: "fit" }] } }]);
    expect(refused[0]!.refusals).toBe(1);
    const invalid = await invoke(temp(), [{ status: 200, body: { ...ok, answers: [{ type: "predicate", name: "fit", probability: 5 }] } }]);
    expect(invalid[0]).toMatchObject({ outcome: "invalid_reply", usage: { inputTokens: 12 } });
    expect(invalid[0]!.costUsd).toBeGreaterThan(0);
  });
});

describe("usage log readers", () => {
  it("sums estimates and unknown bounds, filters by time, and counts old or broken lines", () => {
    const file = temp();
    const now = new Date().toISOString();
    const base = { v: 1, at: now, run: "r", command: "test", backend: "openai-decisions", model: "m", stage: "screening", jobId: null, attempt: 1, outcome: "ok", status: 200, questions: 1, refusals: 0, usage: null, costUsd: 0.2, boundUsd: null, ms: 1 };
    const unknown = { ...base, at: "2020-01-01T00:00:00.000Z", costUsd: null, boundUsd: 0.7 };
    const old = JSON.stringify({ at: now, label: "rate:x", cost: 0.001 });
    appendFileSync(file, [JSON.stringify(base), JSON.stringify(unknown), old, "{broken", "", "   "].join("\n"));
    expect(readLog(file).lines).toHaveLength(2); expect(readLog(file).unreadable).toBe(2);
    expect(spentSince(file)).toMatchObject({ estimatedUsd: 0.2, unknownBoundUsd: 0.7, unknownAttempts: 1 });
    expect(spentSince(file).totalUsd).toBeCloseTo(0.9);
    expect(spentSince(file, now)).toMatchObject({ estimatedUsd: 0.2, unknownAttempts: 0, totalUsd: 0.2 });
    expect(readLog(`${file}.missing`).lines).toHaveLength(0);
  });
});
