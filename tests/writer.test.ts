import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WRITER } from "../src/config.js";
import { WriterRequest, WRITER_CONTRACT } from "../src/writer/contract.js";
import { createWriter, getWriter, probeWriter, setWriterForTests, writerFingerprint, writerUsage, writerUsageLine, WriterError, type WriterTask } from "../src/writer/index.js";
import { readWriterUsage } from "../src/writer/usage.js";
import { z } from "zod";
import type { WriterResponse } from "../src/writer/contract.js";

function settings(billing: WriterResponse["billing"][] = ["subscription", "free"], identity = "id-1") {
  return { command: ["fake"], passEnv: [], billing, identity };
}

function respond(over: Partial<WriterResponse> = {}): WriterResponse {
  return {
    contract: WRITER_CONTRACT,
    output: { ok: true },
    writer: { name: "fake", version: "1", model: "m" },
    billing: "subscription",
    usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
    costUsd: null,
    ...over,
  };
}

function task(over: Partial<WriterTask<{ ok: boolean }>> = {}): WriterTask<{ ok: boolean }> {
  return {
    kind: "probe",
    jobId: "job-1",
    system: "system",
    input: "input",
    promptVersion: 2,
    output: { version: 3, jsonSchema: { type: "object" }, parse: (value: unknown) => z.object({ ok: z.boolean() }).parse(value) },
    ...over,
  };
}

function resetUsage(): void {
  writerUsage.calls = 0;
  writerUsage.failed = 0;
  writerUsage.byBilling = { subscription: 0, metered: 0, free: 0, unknown: 0 };
  writerUsage.inputTokens = 0;
  writerUsage.cachedInputTokens = 0;
  writerUsage.outputTokens = 0;
  writerUsage.tokensUnknown = 0;
  writerUsage.knownCostUsd = 0;
  writerUsage.costUnknown = 0;
}

describe("writer interface", () => {
  beforeEach(() => resetUsage());
  afterEach(() => setWriterForTests(null));

  it("rejects missing configuration before creating a process writer", () => {
    const previous = process.env.WRITER_COMMAND;
    delete process.env.WRITER_COMMAND;
    try {
      expect(() => getWriter()).toThrowError(expect.objectContaining({ kind: "config" }));
    } finally {
      if (previous === undefined) delete process.env.WRITER_COMMAND;
      else process.env.WRITER_COMMAND = previous;
    }
  });

  it("sends a contract request and gives each call a new task id", async () => {
    const requests: unknown[] = [];
    const writer = createWriter(settings(), { run: async (request) => { requests.push(request); return respond(); }, usageLog: null });
    await writer.write(task());
    await writer.write(task());
    const first = WriterRequest.parse(requests[0]);
    const second = WriterRequest.parse(requests[1]);
    expect(first).toMatchObject({ contract: WRITER_CONTRACT, task: { kind: "probe", jobId: "job-1", promptVersion: 2, schemaVersion: 3 }, system: "system", input: "input", output: { schema: { type: "object" } }, timeoutMs: WRITER.timeoutMs, settings: { effort: WRITER.effort.probe } });
    expect(first.task.id).not.toBe(second.task.id);
  });

  it("resolves a good response", async () => {
    await expect(createWriter(settings(), { run: async () => respond(), usageLog: null }).write(task())).resolves.toMatchObject({ output: { ok: true }, writer: { name: "fake" }, billing: "subscription", usage: { inputTokens: 100 }, costUsd: null });
  });

  it("refuses unaccepted billing before parsing output", async () => {
    const parse = vi.fn((value: unknown) => value as { ok: boolean });
    const call = (billing: WriterResponse["billing"], accepted: WriterResponse["billing"][]) => createWriter(settings(accepted), { run: async () => respond({ billing }), usageLog: null }).write(task({ output: { ...task().output, parse } }));
    await expect(call("metered", ["subscription", "free"])).rejects.toMatchObject({ kind: "billing" });
    expect(parse).not.toHaveBeenCalled();
    await expect(call("unknown", ["subscription", "free"])).rejects.toMatchObject({ kind: "billing" });
    expect(parse).not.toHaveBeenCalled();
    await expect(call("metered", ["subscription", "metered"])).resolves.toMatchObject({ billing: "metered" });
  });

  it("rejects output that does not fit", async () => {
    await expect(createWriter(settings(), { run: async () => respond({ output: { ok: "yes" } }), usageLog: null }).write(task())).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("rethrows run errors unchanged", async () => {
    const error = new WriterError("timeout", "late");
    await expect(createWriter(settings(), { run: async () => { throw error; }, usageLog: null }).write(task())).rejects.toBe(error);
  });

  it("passes the task signal to run", async () => {
    const controller = new AbortController();
    let received: unknown;
    await createWriter(settings(), { run: async (_request, _settings, options) => { received = options; return respond(); }, usageLog: null }).write(task({ signal: controller.signal }));
    expect(received).toEqual({ signal: controller.signal });
  });

  it("tracks calls, token gaps, billing, and metered costs", async () => {
    let count = 0;
    const writer = createWriter(settings(["subscription", "metered", "free"]), { run: async () => {
      count++;
      if (count === 1) return respond();
      if (count === 2) return respond({ billing: "metered", costUsd: 0.02 });
      if (count === 3) return respond({ billing: "metered", costUsd: null });
      if (count === 4) return respond({ billing: "free", usage: null });
      throw new Error("failed");
    }, usageLog: null });
    for (let index = 0; index < 4; index++) await writer.write(task());
    await expect(writer.write(task())).rejects.toThrow("failed");
    expect(writerUsage).toMatchObject({ calls: 5, failed: 1, byBilling: { subscription: 1, metered: 2, free: 1, unknown: 0 }, inputTokens: 300, cachedInputTokens: 120, outputTokens: 60, tokensUnknown: 2, knownCostUsd: 0.02, costUnknown: 2 });
  });

  it("does not count subscription or free costs", async () => {
    const writer = createWriter(settings(["subscription", "free"]), { run: async (_request, config) => respond({ billing: config.billing[0] as "subscription", costUsd: 4 }), usageLog: null });
    await writer.write(task());
    await writer.write(task());
    expect(writerUsage.knownCostUsd).toBe(0);
    expect(writerUsage.costUnknown).toBe(0);
  });

  it("records each call and supports a disabled usage log", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "writer-test-"));
    const file = path.join(dir, "usage.jsonl");
    try {
      const writer = createWriter(settings(), { run: async () => respond(), usageLog: file });
      await writer.write(task());
      expect(readWriterUsage(file)).toMatchObject({ unreadable: 0, lines: [{ task: "probe", jobId: "job-1", outcome: "ok", billing: "subscription", usage: respond().usage, costUsd: null, writer: "fake", model: "m" }] });
      const failedFile = path.join(dir, "failed.jsonl");
      await createWriter(settings(), { run: async () => { throw new WriterError("timeout", "late"); }, usageLog: failedFile }).write(task()).catch(() => undefined);
      expect(readWriterUsage(failedFile).lines[0]).toMatchObject({ outcome: "timeout", billing: null, usage: null, costUsd: null });
      const disabled = path.join(dir, "disabled.jsonl");
      await createWriter(settings(), { run: async () => respond(), usageLog: null }).write(task());
      expect(existsSync(disabled)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints clear usage summaries", async () => {
    await createWriter(settings(), { run: async () => { throw new Error("failed"); }, usageLog: null }).write(task()).catch(() => undefined);
    expect(writerUsageLine()).toContain("cost unknown for 1 call");
    expect(writerUsageLine()).not.toContain("$0");
    resetUsage();
    await createWriter(settings(), { run: async () => respond(), usageLog: null }).write(task());
    expect(writerUsageLine()).toContain("on a subscription");
    expect(writerUsageLine()).not.toContain("cost unknown");
    expect(writerUsageLine()).not.toContain("$");
  });

  it("derives identity from writer settings", () => {
    expect(createWriter(settings(["subscription", "free"], "id-1")).identity).not.toBe(createWriter(settings(["subscription", "free"], "id-2")).identity);
    expect(createWriter(settings()).identity).toBe(createWriter(settings()).identity);
  });

  it("fingerprints writer identity and task versions", () => {
    const first = createWriter(settings());
    setWriterForTests(first);
    const base = writerFingerprint("probe", 1, 1);
    expect(writerFingerprint("probe", 1, 1)).toBe(base);
    expect(writerFingerprint("probe", 1, 1)).not.toBe(writerFingerprint("form_answers", 1, 1));
    expect(writerFingerprint("probe", 1, 1)).not.toBe(writerFingerprint("probe", 2, 1));
    expect(writerFingerprint("probe", 1, 1)).not.toBe(writerFingerprint("probe", 1, 2));
    setWriterForTests(createWriter(settings(["subscription", "free"], "id-2")));
    expect(writerFingerprint("probe", 1, 1)).not.toBe(base);
  });

  it("probes with the probe task", async () => {
    let kind = "";
    setWriterForTests(createWriter(settings(), { run: async (request) => { kind = request.task.kind; return respond(); }, usageLog: null }));
    await expect(probeWriter()).resolves.toMatchObject({ output: { ok: true } });
    expect(kind).toBe("probe");
  });
});
