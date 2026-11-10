import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_DECISIONS } from "../src/config.js";
import { createDecider } from "../src/decisions/index.js";
import { OpenAIDecisions } from "../src/decisions/openai.js";
import { OpenCodeDecisions, priceOf } from "../src/decisions/opencode.js";
import { choice, predicate, score, type Questions } from "../src/decisions/types.js";
import { readUsage } from "../src/decisions/usage.js";

const openaiKey = "sk-openai-secret-value";
const opencodeKey = "oc-live-secret-value";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function reply(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), headers ? { status, headers } : { status });
}

function client(fetchImpl: ReturnType<typeof vi.fn>, opts: Record<string, unknown> = {}): OpenCodeDecisions {
  return new OpenCodeDecisions({
    apiKey: opencodeKey,
    env: { OPENAI_API_KEY: openaiKey, OPENCODE_API_KEY: opencodeKey },
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
const okBody = {
  model: OPENCODE_DECISIONS.model,
  answers: {
    fit: { type: "score", score: 1, confidence: 0.4, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "low", "1": "high" } },
    location: { type: "choice", choice: "remote", confidence: 0.8, probabilities: { remote: 0.9, office: 0.1 } },
    eligible: { type: "noul", noul: 0.6, confidence: 0.99 },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

function sent(fetchImpl: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe("Jev response mapping", () => {
  it("maps noul, choice and score onto the application's answers and sends the OpenCode request", async () => {
    const fetchImpl = vi.fn(async () => reply(200, okBody));
    const result = await client(fetchImpl).decide(input, questions, call);
    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe(OPENCODE_DECISIONS.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${opencodeKey}`, "Content-Type": "application/json" });
    expect(body.model).toBe("jev-1.13-free");
    expect(body.state).toEqual({ shared: input.shared, evidence: input.evidence });
    expect(body.questions).toEqual({
      eligible: { type: "noul", instructions: "Can this person work there?", criteria: { true: "authorized", false: "not authorized" } },
      location: { type: "choice", instructions: "Choose a location", criteria: { remote: "Remote work", office: "Office work" } },
      fit: { type: "score", instructions: "Rate fit", criteria: [{ label: "low", description: "Poor fit" }, "high"] },
    });
    expect(Object.keys(result)).toEqual(["eligible", "location", "fit"]);
    expect(result.eligible).toEqual({ type: "predicate", probability: 0.6 });
    expect(JSON.stringify(result.eligible)).not.toContain("confidence");
    expect(result.location).toEqual({ type: "choice", choice: "remote", probabilities: { remote: 0.9, office: 0.1 }, confidence: 0.8 });
    expect(result.fit).toEqual({ type: "score", score: 1, levels: 2, probabilities: [0.2, 0.8], confidence: 0.4 });
  });

  it("leaves confidence null when a choice or score reports none", async () => {
    const fetchImpl = vi.fn(async () => reply(200, {
      answers: {
        location: { type: "choice", choice: "office" },
        fit: { type: "score", score: 0 },
      },
    }));
    const result = await client(fetchImpl).decide(input, { location: questions.location!, fit: questions.fit! }, call);
    expect(result.location).toEqual({ type: "choice", choice: "office", probabilities: {}, confidence: null });
    expect(result.fit).toEqual({ type: "score", score: 0, levels: 2, probabilities: [], confidence: null });
  });

  it("sends string evidence as the state when nothing is shared", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { answers: { p: { type: "noul", noul: 1 } } }));
    await client(fetchImpl).decide({ evidence: "posting" }, { p: predicate("Check") }, call);
    expect(sent(fetchImpl).body.state).toBe("posting");
  });
});

describe("a refusal", () => {
  it("returns a refusal and keeps the other answers", async () => {
    const fetchImpl = vi.fn(async () => reply(200, {
      answers: {
        eligible: { type: "refusal" },
        location: { type: "choice", choice: "office", probabilities: { office: 1, remote: 0 } },
        fit: { type: "score", score: 0, probabilities: { "0": 1, "1": 0 } },
      },
      usage: { input_tokens: 4, output_tokens: 1 },
    }));
    const result = await client(fetchImpl).decide(input, questions, call);
    expect(result.eligible).toEqual({ type: "refusal" });
    expect(result.location).toMatchObject({ type: "choice", choice: "office" });
    expect(result.fit).toMatchObject({ type: "score", score: 0 });
  });
});

describe("a malformed reply", () => {
  const cases: [string, Questions, Record<string, unknown>, string][] = [
    ["missing", { p: predicate("P") }, {}, "incomplete"],
    ["unasked name", { p: predicate("P") }, { other: { type: "noul", noul: 1 } }, "incomplete"],
    ["wrong type", { p: predicate("P") }, { p: { type: "choice", choice: "x" } }, "malformed"],
    ["unoffered choice", { c: choice("C", { yes: "Yes", no: "No" }) }, { c: { type: "choice", choice: "maybe" } }, "malformed"],
    ["unoffered probability", { c: choice("C", { yes: "Yes", no: "No" }) }, { c: { type: "choice", choice: "yes", probabilities: { maybe: 0.2 } } }, "malformed"],
    ["score above scale", { s: score("S", ["a", "b"]) }, { s: { type: "score", score: 2 } }, "malformed"],
    ["negative score", { s: score("S", ["a", "b"]) }, { s: { type: "score", score: -1 } }, "malformed"],
    ["probability above one", { p: predicate("P") }, { p: { type: "noul", noul: 2 } }, "malformed"],
    ["partial score probabilities", { s: score("S", ["a", "b"]) }, { s: { type: "score", score: 0, probabilities: { "0": 1 } } }, "malformed"],
  ];
  it.each(cases)("rejects %s", async (_name, q, answers, kind) => {
    const fetchImpl = vi.fn(async () => reply(200, { answers }));
    await expect(client(fetchImpl).decide(input, q, call)).rejects.toMatchObject({ name: "DecisionError", kind });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a non-JSON body and a body without answers", async () => {
    const text = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(client(text).decide(input, { p: predicate("P") }, call)).rejects.toMatchObject({ kind: "malformed" });
    const missing = vi.fn(async () => reply(200, { result: {} }));
    await expect(client(missing).decide(input, { p: predicate("P") }, call)).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("the OpenAI key is not sent", () => {
  it("authorizes the OpenCode call with OPENCODE_API_KEY only", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { answers: { p: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    await client(fetchImpl).decide({ evidence: "example" }, { p: predicate("Check") }, call);
    const { init } = sent(fetchImpl);
    const packed = JSON.stringify({ url: OPENCODE_DECISIONS.endpoint, headers: init.headers, body: String(init.body) });
    expect(packed).toContain(opencodeKey);
    expect(packed).not.toContain(openaiKey);
    expect(packed).not.toContain("api.openai.com");
    expect(String(init.body)).not.toContain("input_text");
  });

  it("keeps the OpenCode key off an OpenAI call", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { answers: [{ type: "predicate", name: "p", probability: 1 }] }));
    const openai = new OpenAIDecisions({ apiKey: openaiKey, fetchImpl: fetchImpl as never, runCapUsd: 1, budgetUsd: null, usageLog: null, sleep: async () => {} });
    await openai.decide({ evidence: "example" }, { p: predicate("Check") }, call);
    const packed = JSON.stringify(fetchImpl.mock.calls[0]);
    expect(packed).toContain(openaiKey);
    expect(packed).not.toContain(opencodeKey);
    expect(packed).not.toContain(OPENCODE_DECISIONS.endpoint);
  });

  it("chooses the backend from the setting and does not swap keys", () => {
    vi.stubEnv("DECISIONS_BACKEND", "opencode");
    vi.stubEnv("OPENCODE_API_KEY", opencodeKey);
    vi.stubEnv("OPENAI_API_KEY", openaiKey);
    expect(createDecider().identity).toEqual({ backend: "opencode", model: "jev-1.13-free", requestVersion: OPENCODE_DECISIONS.requestVersion });
    vi.stubEnv("DECISIONS_BACKEND", "openai");
    expect(createDecider().identity).toMatchObject({ backend: "openai-decisions", model: "gpt-6-luna" });
  });
});

describe("failures keep the existing error kinds", () => {
  it("does not retry an auth failure", async () => {
    const fetchImpl = vi.fn(async () => reply(401, { detail: `rejected ${opencodeKey}` }));
    await expect(client(fetchImpl).decide(input, { p: predicate("P") }, call)).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit and a timeout, and records the free price", async () => {
    const limited = vi.fn()
      .mockResolvedValueOnce(reply(429, { detail: "slow down" }, { "retry-after": "1" }))
      .mockResolvedValueOnce(reply(200, { answers: { p: { type: "noul", noul: 1 } }, usage: { input_tokens: 2, output_tokens: 1 } }));
    const sleep = vi.fn(async () => {});
    const c = client(limited, { sleep });
    await c.decide(input, { p: predicate("P") }, call);
    expect(limited).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(c.usage.freeAttempts).toBe(2);
    expect(c.usage.estimatedUsd).toBe(0);
    expect(c.usage.unknownAttempts).toBe(0);

    const err = Object.assign(new Error("timeout"), { name: "AbortError" });
    const timedOut = vi.fn(async () => { throw err; });
    const timeoutClient = client(timedOut);
    await expect(timeoutClient.decide(input, { p: predicate("P") }, call)).rejects.toMatchObject({ kind: "timeout" });
    expect(timedOut).toHaveBeenCalledTimes(4);
    expect(timeoutClient.usage.freeAttempts).toBe(4);
    expect(timeoutClient.usage.unknownAttempts).toBe(0);
  });

  it("stops when the rate limit asks for a longer wait than this tool allows", async () => {
    const fetchImpl = vi.fn(async () => reply(429, { detail: "later" }, { "retry-after": "21" }));
    await expect(client(fetchImpl).decide(input, { p: predicate("P") }, call)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records a free call as free, and an unreadable price as unknown", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "js-oc-"));
    dirs.push(dir);
    const file = path.join(dir, "usage.jsonl");
    const fetchImpl = vi.fn(async () => reply(200, okBody));
    await client(fetchImpl, { usageLog: file }).decide(input, questions, { stage: "screening", jobId: "job-1" });
    const line = readUsage(file).lines[0]!;
    expect(line).toMatchObject({ backend: "opencode", model: "jev-1.13-free", outcome: "ok", costUsd: 0, costKind: "free", boundUsd: null, refusals: 0, usage: { inputTokens: 12, outputTokens: 3 } });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(opencodeKey);
    expect(text).not.toContain(openaiKey);

    const priced = vi.fn(async () => reply(200, { answers: { p: { type: "noul", noul: 1 } }, usage: { input_tokens: 8, output_tokens: 1, cost: 0.02 } }));
    const paid = client(priced);
    await paid.decide(input, { p: predicate("P") }, call);
    expect(paid.usage.estimatedUsd).toBe(0.02);
    expect(paid.usage.freeAttempts).toBe(0);

    const broken = vi.fn(async () => reply(200, { answers: { p: { type: "noul", noul: 1 } }, usage: { input_tokens: 8, output_tokens: 1, cost: -1 } }));
    const unknown = client(broken);
    await unknown.decide(input, { p: predicate("P") }, call);
    expect(unknown.usage.unknownAttempts).toBe(1);
    expect(unknown.usage.estimatedUsd).toBe(0);
    expect(unknown.usage.freeAttempts).toBe(0);
  });
});

describe("price of a reply", () => {
  const tokens = { input_tokens: 10, output_tokens: 1 };
  it("uses a named price, and the documented free price only for the free model", () => {
    expect(priceOf("jev-1.13-free", undefined)).toEqual({ costUsd: 0, costKind: "free" });
    expect(priceOf("jev-1.13-free", tokens)).toEqual({ costUsd: 0, costKind: "free" });
    expect(priceOf("jev-1.13-free", { ...tokens, cost: 0 })).toEqual({ costUsd: 0, costKind: "free" });
    expect(priceOf("jev-1.13-free", { ...tokens, cost_usd: 0.5 })).toEqual({ costUsd: 0.5, costKind: "reported" });
    expect(priceOf("jev-1.13", tokens)).toEqual({ costUsd: null, costKind: null });
    expect(priceOf("jev-1.13", { ...tokens, cost: 0 })).toEqual({ costUsd: 0, costKind: "free" });
    expect(priceOf("jev-1.13-free", { cost: -1 })).toEqual({ costUsd: null, costKind: null });
    expect(priceOf("jev-1.13-free", { cost: 1, cost_usd: 2 })).toEqual({ costUsd: null, costKind: null });
  });
});
