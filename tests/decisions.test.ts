import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISIONS } from "../src/config.js";
import { choice, predicate, score, type Questions } from "../src/decisions/types.js";
import { appendUsage, boundCostUsd, estimateCostUsd, type UsageLine } from "../src/decisions/usage.js";
import { buildRequest, OpenAIDecisions } from "../src/decisions/openai.js";

const key = ["sk", "test", "x".repeat(20)].join("-");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function reply(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), headers ? { status, headers } : { status });
}

function client(fetchImpl: ReturnType<typeof vi.fn>, opts: Record<string, unknown> = {}): OpenAIDecisions {
  return new OpenAIDecisions({
    apiKey: key,
    fetchImpl: fetchImpl as never,
    runCapUsd: 1,
    budgetUsd: null,
    usageLog: null,
    sleep: async () => {},
    ...opts,
  });
}

const questions: Questions = {
  eligible: predicate("Can this person work there?", { true: "authorized", false: "not authorized" }),
  location: choice("Choose a location", { remote: "Remote work", office: "Office work" }),
  fit: score("Rate fit", [{ label: "low", description: "Poor fit" }, { label: "high" }]),
};
const input = { shared: { candidate: "profile" }, evidence: { role: "engineer" } };
const call = { stage: "screening" as const };
const ok = (answers: unknown[]) => reply(200, { answers });
const answer = (type: string, name: string, fields: Record<string, unknown> = {}) => ({ type, name, ...fields });
async function expectKind(promise: Promise<unknown>, kind: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "DecisionError", kind });
}

describe("A. request mapping", () => {
  it("maps shared data, evidence, questions and headers", async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const q: Questions = { eligible: predicate("Can this person work there?", { true: "authorized", false: "not authorized" }), location: choice("Choose a location", { remote: "Remote work", office: "Office work" }), fit: score("Rate fit", [{ label: "low", description: "Poor fit" }, { label: "high" }]) };
    fetchImpl.mockImplementation(async () => ok([
      answer("predicate", "eligible", { probability: 0.8 }),
      answer("choice", "location", { choice: "remote" }),
      answer("score", "fit", { score: 1 }),
    ]));
    await client(fetchImpl).decide(input, q, call);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DECISIONS.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input[0].role).toBe("user");
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: `What is the same for every request:\n${JSON.stringify(input.shared)}`, prompt_cache_breakpoint: { mode: "explicit" } });
    expect(body.input[0].content[1]).toEqual({ type: "input_json", data: input.evidence });
    expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(body.questions.map((q: { name: string }) => q.name)).toEqual(["eligible", "location", "fit"]);
    expect(body.questions[0].instructions).toContain("True when: authorized\nFalse when: not authorized");
    expect(body.questions[1].choices).toEqual([{ value: "remote", description: "Remote work" }, { value: "office", description: "Office work" }]);
    expect(body.questions[2].levels).toEqual([{ label: "low", description: "Poor fit" }, { label: "high" }]);
  });
  it("uses one evidence part without shared data and text for string evidence", async () => {
    const fetchImpl = vi.fn(async () => ok([answer("predicate", "p", { probability: 1 })]));
    await client(fetchImpl).decide({ evidence: "posting" }, { p: predicate("Check") }, call);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).input[0].content).toEqual([{ type: "input_text", text: "posting" }]);
  });
});

describe("B. response mapping", () => {
  it("returns answers in question order with normalized probabilities", async () => {
    const fetchImpl = vi.fn(async () => ok([
      answer("score", "fit", { score: 1, probabilities: [{ value: 1, label: "high", probability: 0.7 }] }),
      answer("choice", "location", { choice: "remote", probabilities: [{ value: "remote", probability: 0.9 }], confidence: 0.8 }),
      answer("predicate", "eligible", { probability: 0.6 }),
    ]));
    const result = await client(fetchImpl).decide(input, questions, call);
    expect(Object.keys(result)).toEqual(["eligible", "location", "fit"]);
    expect(result.location).toEqual({ type: "choice", choice: "remote", probabilities: { remote: 0.9 }, confidence: 0.8 });
    expect(result.fit).toEqual({ type: "score", score: 1, levels: 2, probabilities: [0, 0.7], confidence: null });
  });
});

describe("C. refusals", () => {
  it("returns a refusal while preserving other answers", async () => {
    const fetchImpl = vi.fn(async () => ok([answer("refusal", "eligible"), answer("choice", "location", { choice: "office" }), answer("score", "fit", { score: 0 })]));
    const result = await client(fetchImpl).decide(input, questions, call);
    expect(result.eligible).toEqual({ type: "refusal" });
    expect(result.location?.type).toBe("choice");
  });
});

describe("D. absent confidence and probabilities", () => {
  it("does not invent confidence or probability values", async () => {
    const fetchImpl = vi.fn(async () => ok([answer("choice", "location", { choice: "remote" }), answer("score", "fit", { score: 0 })]));
    const result = await client(fetchImpl).decide(input, { location: choice("Choose a location", { remote: "Remote work", office: "Office work" }), fit: score("Rate fit", [{ label: "low", description: "Poor fit" }, { label: "high" }]) }, call);
    expect(result.location).toEqual({ type: "choice", choice: "remote", probabilities: {}, confidence: null });
    expect(result.fit).toEqual({ type: "score", score: 0, levels: 2, probabilities: [], confidence: null });
  });
});

describe("E. rejected replies", () => {
  const cases: [string, Questions, unknown[], string][] = [
    ["missing", { p: predicate("P") }, [], "incomplete"],
    ["duplicate", { p: predicate("P") }, [answer("predicate", "p", { probability: 1 }), answer("predicate", "p", { probability: 0 })], "incomplete"],
    ["unasked name", { p: predicate("P") }, [answer("predicate", "other", { probability: 1 })], "incomplete"],
    ["wrong type", { p: predicate("P") }, [answer("choice", "p", { choice: "x" })], "malformed"],
    ["unoffered choice", { c: choice("C", { yes: "Yes", no: "No" }) }, [answer("choice", "c", { choice: "maybe" })], "malformed"],
    ["boolean choice", { c: choice("C", { yes: "Yes", no: "No" }) }, [answer("choice", "c", { choice: true })], "malformed"],
    ["unoffered probability", { c: choice("C", { yes: "Yes", no: "No" }) }, [answer("choice", "c", { choice: "yes", probabilities: [{ value: "maybe", probability: 0.2 }] })], "malformed"],
    ["score above scale", { s: score("S", ["a", "b"]) }, [answer("score", "s", { score: 2 })], "malformed"],
    ["negative score", { s: score("S", ["a", "b"]) }, [answer("score", "s", { score: -1 })], "malformed"],
    ["probability above one", { p: predicate("P") }, [answer("predicate", "p", { probability: 2 })], "malformed"],
  ];
  it.each(cases)("rejects %s", async (_name, q, answers, kind) => {
    const fetchImpl = vi.fn(async () => ok(answers));
    await expectKind(client(fetchImpl).decide(input, q, call), kind);
  });
  it("rejects a non-JSON body as malformed", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    await expectKind(client(fetchImpl).decide(input, { p: predicate("P") }, call), "malformed");
  });
  it("rejects a body without answers as malformed", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { result: [] }));
    await expectKind(client(fetchImpl).decide(input, { p: predicate("P") }, call), "malformed");
  });
});

describe("F. request limits", () => {
  it.each([
    ["too many", Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`p${i}`, predicate("P")])) as Questions],
    ["one choice", { c: choice("C", { yes: "Yes" }) }],
    ["too many levels", { s: score("S", Array.from({ length: 11 }, (_, i) => `L${i}`)) }],
    ["empty instructions", { p: predicate(" ") }],
  ])("rejects %s before fetch", async (_name, q) => {
    const fetchImpl = vi.fn();
    await expectKind(client(fetchImpl).decide(input, q as Questions, call), "request");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("returns empty answers without fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl).decide(input, {}, call)).resolves.toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("G. errors and retries", () => {
  it("retries 429 and 500 and succeeds on the third attempt", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(429, {})).mockResolvedValueOnce(reply(500, {})).mockResolvedValueOnce(ok([answer("predicate", "p", { probability: 1 })]));
    const c = client(fetchImpl);
    await c.decide(input, { p: predicate("P") }, call);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(c.usage.retries).toBe(2);
  });
  it("uses retry-after seconds as the sleep duration", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(429, {}, { "retry-after": "2" })).mockResolvedValueOnce(ok([answer("predicate", "p", { probability: 1 })]));
    await client(fetchImpl, { sleep }).decide(input, { p: predicate("P") }, call);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it("stops on retry-after beyond the maximum", async () => {
    const fetchImpl = vi.fn(async () => reply(429, {}, { "retry-after": String(DECISIONS.retryMaxMs / 1000 + 1) }));
    await expectKind(client(fetchImpl).decide(input, { p: predicate("P") }, call), "rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([[401, {}, "auth"], [429, { error: { code: "insufficient_quota" } }, "quota"], [400, { error: { message: "context length exceeded" } }, "too_long"], [400, {}, "rejected"]] as const)("maps HTTP %i", async (status, body, kind) => {
    const fetchImpl = vi.fn(async () => reply(status, body));
    await expectKind(client(fetchImpl).decide(input, { p: predicate("P") }, call), kind);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retries AbortError to the configured maximum and counts failure", async () => {
    const err = Object.assign(new Error("timeout"), { name: "AbortError" });
    const fetchImpl = vi.fn(async () => { throw err; });
    const c = client(fetchImpl);
    await expectKind(c.decide(input, { p: predicate("P") }, call), "timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(DECISIONS.maxRetries + 1);
    expect(c.usage.failed).toBe(1);
  });
  it("retries a network error to the configured maximum, and counts each try as of unknown cost", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); });
    const c = client(fetchImpl);
    await expectKind(c.decide(input, { p: predicate("P") }, call), "network");
    expect(fetchImpl).toHaveBeenCalledTimes(DECISIONS.maxRetries + 1);
    // The request may have reached the backend each time, so none of the tries is counted as free.
    expect(c.usage.unknownAttempts).toBe(DECISIONS.maxRetries + 1);
    expect(c.usage.unknownBoundUsd).toBeGreaterThan(0);
  });
});

describe("H. secret redaction", () => {
  it("removes the key from HTTP error text and network errors", async () => {
    const body = { error: { message: `bad ${key}` } };
    await expect(client(vi.fn(async () => reply(400, body))).decide(input, { p: predicate("P") }, call)).rejects.toSatisfy((e: Error) => !e.message.includes(key));
    const fetchImpl = vi.fn(async () => { throw new TypeError(`failed ${key}`); });
    await expect(client(fetchImpl).decide(input, { p: predicate("P") }, call)).rejects.toSatisfy((e: Error) => !e.message.includes(key));
  });
});

describe("I. spend limits", () => {
  it("stops before sending when the per run cap is too small", async () => {
    const fetchImpl = vi.fn();
    await expectKind(client(fetchImpl, { runCapUsd: 0.0000001 }).decide(input, { p: predicate("P") }, call), "spend_limit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("honors existing usage above the total budget", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "decisions-test-"));
    dirs.push(dir);
    const file = path.join(dir, "usage.jsonl");
    const line: UsageLine = { v: 1, at: new Date().toISOString(), run: "test", command: "test", backend: "openai-decisions", model: "gpt-6-luna", stage: "screening", jobId: null, attempt: 1, outcome: "ok", status: 200, questions: 1, refusals: 0, usage: null, costUsd: 1, boundUsd: null, ms: 1 };
    appendUsage(file, line);
    const fetchImpl = vi.fn();
    await expectKind(client(fetchImpl, { budgetUsd: 0.5, usageLog: file }).decide(input, { p: predicate("P") }, call), "spend_limit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks the cap again before a retry", async () => {
    const fetchImpl = vi.fn(async () => reply(500, {}));
    const q = { p: predicate("P") };
    // Room for one try and not for two: a failed try of unknown cost is charged at its bound.
    const bound = boundCostUsd(JSON.stringify(buildRequest(DECISIONS.model, input, q)).length);
    const c = client(fetchImpl, { runCapUsd: bound * 1.5 });
    await expectKind(c.decide(input, q, call), "spend_limit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.usage.unknownAttempts).toBe(1);
  });
});

describe("J. usage accounting", () => {
  it("sums reported tokens and estimates cost, then bounds missing usage", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(200, { answers: [answer("predicate", "p", { probability: 1 })], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 }, output_tokens: 5 } })).mockResolvedValueOnce(ok([answer("predicate", "p", { probability: 1 })]));
    const c = client(fetchImpl);
    await c.decide(input, { p: predicate("P") }, call);
    const before = c.usage.estimatedUsd;
    expect(c.usage).toMatchObject({ inputTokens: 1000, cachedTokens: 200, cacheWriteTokens: 100, outputTokens: 5 });
    expect(before).toBe(estimateCostUsd({ inputTokens: 1000, cachedTokens: 200, cacheWriteTokens: 100, outputTokens: 5 }));
    await c.decide(input, { p: predicate("P") }, call);
    expect(c.usage.unknownAttempts).toBe(1);
    expect(c.usage.unknownBoundUsd).toBeGreaterThan(0);
    expect(c.usage.estimatedUsd).toBe(before);
  });
});
