import { describe, expect, it } from "vitest";
import { formatCost, summarizeCost } from "../src/log/cost.js";
import { UsageLine, type UsageLine as U } from "../src/decisions/usage.js";
import { WriterUsageLine, type WriterUsageLine as W } from "../src/writer/usage.js";

const decision = (x: Partial<U> = {}): U => UsageLine.parse({ v: 1, at: "2026-11-09T12:00:00Z", run: "r", command: "apply", backend: "x", model: "m", stage: "screening", jobId: "j", attempt: 1, outcome: "ok", status: 200, questions: 1, refusals: 0, usage: { inputTokens: 10, cachedTokens: 2, cacheWriteTokens: 0, outputTokens: 1 }, costUsd: 0.01, boundUsd: 0, ms: 1, ...x });
const writer = (x: Partial<W> = {}): W => WriterUsageLine.parse({ v: 1, at: "2026-11-09T12:00:00Z", run: "r", command: "apply", task: "form_answers", jobId: "j", identity: "x", writer: "w", model: "m", outcome: "ok", billing: "subscription", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 }, costUsd: null, ms: 1, ...x });

describe("cost report", () => {
  it("separates tries, failures, stages, runs, and unknown decision cost", () => {
    const c = summarizeCost([decision(), decision({ stage: "mapping", attempt: 2, outcome: "timeout", costUsd: null, boundUsd: 0.02, at: "2026-11-09T13:00:00Z" })], [], [], "");
    expect(c.decisions.total).toMatchObject({ calls: 1, retries: 1, failedAttempts: 1, unknownAttempts: 1, unknownBoundUsd: 0.02, estimatedUsd: 0.01 });
    expect(c.decisions.runs[0]?.startedAt).toBe("2026-11-09T12:00:00Z");
    expect(formatCost(c)).toContain("at most $0.0200");
    expect(formatCost(c)).toContain("  Unknown:");
  });
  it("counts never applied ratings and completed application unit costs", () => {
    const c = summarizeCost([decision(), decision({ jobId: "k", stage: "screening" }), decision({ stage: "mapping" })], [], [{ jobId: "j", appliedAt: "2026-11-09T12:30:00Z" }]);
    expect(c.screening).toMatchObject({ postings: 2, applied: 1, neverApplied: { calls: 1 } });
    expect(c.applications).toMatchObject({ started: 1, completed: 1, perCompletedFormUsd: 0.01 });
    expect(summarizeCost([], [], []).applications.perCompletedAllUsd).toBeNull();
  });
  it("applies since to usage and completions", () => {
    const c = summarizeCost([decision({ at: "2026-11-08T12:00:00Z" }), decision()], [], [{ jobId: "j", appliedAt: "2026-11-08T12:00:00Z" }], "2026-11-09");
    expect(c.decisions.total.calls).toBe(1);
    expect(c.applications.completed).toBe(0);
    expect(formatCost(c)).not.toContain("No calls recorded");
  });
  it("tracks writer billing, unknown tokens and costs without pricing subscriptions", () => {
    const c = summarizeCost([], [writer(), writer({ billing: "metered", costUsd: 0.03 }), writer({ billing: "metered", costUsd: null }), writer({ outcome: "spawn", billing: null, usage: null })], []);
    expect(c.writer.total).toMatchObject({ calls: 4, failed: 1, knownCostUsd: 0.03, costUnknown: 2, tokensUnknown: 1 });
    expect(c.writer.total.byBilling).toMatchObject({ subscription: 1, metered: 2 });
    expect(formatCost(c)).toContain("Writer (your configured command)");
    expect(formatCost(c)).toContain("Metered cost reported: $0.0300.");
  });
  it("uses per completed sentence and only includes budget when supplied", () => {
    const c = summarizeCost([decision({ stage: "mapping" })], [], []);
    expect(formatCost(c)).toContain("no completed application in this period, so there is no per-application figure");
    expect(formatCost(c)).not.toContain("Budget:");
    expect(formatCost(c, { limitUsd: 8, spentUsd: 0.01 })).toContain("Budget:");
    expect(formatCost(summarizeCost([], [], []))).toBe("No calls recorded yet.");
  });
  it("separates thousands in token counts", () => {
    const c = summarizeCost([decision({ usage: { inputTokens: 12000, cachedTokens: 2000, cacheWriteTokens: 0, outputTokens: 0 } })], [], []);
    expect(formatCost(c)).toContain("12,000");
    expect(formatCost(c)).toContain("2,000");
  });
});
