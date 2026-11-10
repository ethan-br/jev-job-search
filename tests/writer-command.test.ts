import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runWriterCommand, writerEnv } from "../src/writer/command.js";
import { WRITER } from "../src/config.js";
import { WriterError, WRITER_CONTRACT, type WriterRequest } from "../src/writer/contract.js";
import type { WriterSettings } from "../src/settings.js";

const MOCK = "examples/writers/mock-writer.mjs";
const temp = mkdtempSync(path.join(tmpdir(), "job-search-writer-"));
const settings = (flags: string[] = [], passEnv: string[] = []): WriterSettings => ({ command: [process.execPath, MOCK, ...flags], passEnv, billing: ["subscription", "free"], identity: "test" });
const request = (timeoutMs = 10_000): WriterRequest => ({ contract: WRITER_CONTRACT, task: { kind: "probe", id: "t1", jobId: null, promptVersion: 1, schemaVersion: 1 }, system: "s", input: "i", output: { format: "json", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }, timeoutMs, settings: { effort: "low" } });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kindOf = async (p: Promise<unknown>): Promise<string> => p.then(() => "resolved", (e) => (e instanceof WriterError ? e.kind : `other: ${e}`));
const pidAt = (file: string): number => Number(readFileSync(file, "utf8"));
const waitDead = async (pid: number): Promise<void> => {
  const until = Date.now() + 2_000;
  while (alive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
};

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("external writer command", () => {
  it("returns a plain response", async () => {
    const result = await runWriterCommand(request(), settings());
    expect(result.contract).toBe(WRITER_CONTRACT);
    expect(result.writer.name).toBe("mock-writer");
    expect(result.billing).toBe("free");
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
  });
  it("sends the request unchanged", async () => {
    const file = path.join(temp, "request.json");
    const input = request();
    await runWriterCommand(input, settings(["--echo-request", file]));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(input);
  });
  it("returns reported billing and usage", async () => {
    const result = await runWriterCommand(request(), settings(["--billing", "metered", "--usage", "10,2,3", "--cost", "0.01", "--model", "m1"]));
    expect(result.billing).toBe("metered");
    expect(result.usage).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 });
    expect(result.costUsd).toBe(0.01);
    expect(result.writer.model).toBe("m1");
  });
  it("reports a nonzero exit and stderr", async () => {
    try { await runWriterCommand(request(), settings(["--exit", "3"])); } catch (error) {
      expect(error).toBeInstanceOf(WriterError);
      if (!(error instanceof WriterError)) throw error;
      expect(error.kind).toBe("exit");
      expect(error.message).toContain("code 3");
      expect(error.message).toContain("asked to fail");
      return;
    }
    throw new Error("expected rejection");
  });
  it("rejects malformed output without quoting it", async () => {
    // One wait per call. Waiting twice on the same rejection reports it as unhandled.
    const read = async (flags: string[]): Promise<WriterError> => {
      try {
        await runWriterCommand(request(), settings(flags));
      } catch (error) {
        if (error instanceof WriterError) return error;
        throw error;
      }
      throw new Error("expected rejection");
    };
    const garbage = await read(["--garbage"]);
    const wrong = await read(["--wrong-contract"]);
    expect(garbage.kind).toBe("malformed");
    expect(wrong.kind).toBe("malformed");
    expect(garbage.message).not.toContain("this is not JSON");
    expect(wrong.message).not.toContain("invalid contract");
  });
  it("limits stdout", async () => {
    expect(await kindOf(runWriterCommand(request(), settings(["--flood", String(WRITER.maxOutputBytes + 100_000)])))).toBe("output_limit");
  });
  it("stops the whole process group on timeout", async () => {
    const pidFile = path.join(temp, "timeout.pid");
    const childFile = path.join(temp, "timeout-child.pid");
    expect(await kindOf(runWriterCommand(request(300), settings(["--sleep-ms", "60000", "--pid-file", pidFile, "--child-pid-file", childFile])))).toBe("timeout");
    await waitDead(pidAt(pidFile));
    await waitDead(pidAt(childFile));
    expect(alive(pidAt(pidFile))).toBe(false);
    expect(alive(pidAt(childFile))).toBe(false);
  }, 20_000);
  it("kills a writer that ignores SIGTERM", async () => {
    const pidFile = path.join(temp, "ignore.pid");
    const started = Date.now();
    expect(await kindOf(runWriterCommand(request(300), settings(["--ignore-term", "--sleep-ms", "60000", "--pid-file", pidFile])))).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(WRITER.killGraceMs);
    expect(alive(pidAt(pidFile))).toBe(false);
  }, 20_000);
  it("cancels an active writer and skips an already aborted call", async () => {
    const pidFile = path.join(temp, "cancel.pid");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    expect(await kindOf(runWriterCommand(request(), settings(["--sleep-ms", "60000", "--pid-file", pidFile]), { signal: controller.signal }))).toBe("cancelled");
    await waitDead(pidAt(pidFile));
    expect(alive(pidAt(pidFile))).toBe(false);
    const neverStarted = path.join(temp, "aborted.pid");
    const aborted = new AbortController();
    aborted.abort();
    expect(await kindOf(runWriterCommand(request(), settings(["--pid-file", neverStarted]), { signal: aborted.signal }))).toBe("cancelled");
    expect(existsSync(neverStarted)).toBe(false);
  }, 20_000);
  it("reports a missing program", async () => {
    expect(await kindOf(runWriterCommand(request(), { ...settings(), command: ["no-such-program-job-search-test"] }))).toBe("spawn");
  });
  it("passes arguments without a shell", async () => {
    const first = path.join(temp, "pwned");
    const second = path.join(temp, "pwned2");
    const stderr = `$(touch ${first}); \`touch ${second}\``;
    const result = await runWriterCommand(request(), settings(["--stderr", stderr, "--model", "a b;c && d"]));
    expect(result.writer.model).toBe("a b;c && d");
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });
  it("filters environment variables and passes only permitted extras", async () => {
    const names = ["OPENAI_API_KEY", "OPENCODE_API_KEY", "JOB_SEARCH_ACCOUNTS_PASSWORD", "WRITER_TEST_TOKEN", "WRITER_TEST_UNLISTED"];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.OPENAI_API_KEY = "dummy-openai";
      process.env.OPENCODE_API_KEY = "dummy-opencode";
      process.env.JOB_SEARCH_ACCOUNTS_PASSWORD = "dummy-password";
      process.env.WRITER_TEST_TOKEN = "dummy-token";
      process.env.WRITER_TEST_UNLISTED = "dummy-unlisted";
      const configured = settings([], ["WRITER_TEST_TOKEN", "OPENAI_API_KEY", "OPENCODE_API_KEY", "JOB_SEARCH_ACCOUNTS_PASSWORD"]);
      const env = writerEnv(configured);
      expect(env.WRITER_TEST_TOKEN).toBe("dummy-token");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENCODE_API_KEY).toBeUndefined();
      expect(env.JOB_SEARCH_ACCOUNTS_PASSWORD).toBeUndefined();
      expect(env.WRITER_TEST_UNLISTED).toBeUndefined();
      const denied = await kindOf(runWriterCommand(request(), settings(["--print-env", "OPENAI_API_KEY", "--exit", "7"])));
      expect(denied).toBe("exit");
      await expect(runWriterCommand(request(), settings(["--print-env", "OPENAI_API_KEY", "--exit", "7"]))).rejects.toThrow("OPENAI_API_KEY=unset");
      await expect(runWriterCommand(request(), settings(["--print-env", "WRITER_TEST_TOKEN", "--exit", "7"], ["WRITER_TEST_TOKEN"]))).rejects.toThrow("WRITER_TEST_TOKEN=set");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  it("scrubs secrets from stderr", async () => {
    // Put together here so no key-shaped text sits in the repository, which the CI check refuses.
    const fake = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    await expect(runWriterCommand(request(), settings(["--stderr", `key ${fake}`, "--exit", "2"]))).rejects.toMatchObject({ kind: "exit" });
    await expect(runWriterCommand(request(), settings(["--stderr", `key ${fake}`, "--exit", "2"]))).rejects.not.toThrow(fake);
  });
  it("rejects an invalid request before starting", async () => {
    const pidFile = path.join(temp, "invalid.pid");
    expect(await kindOf(runWriterCommand(request(0), settings(["--pid-file", pidFile])))).toBe("config");
    expect(existsSync(pidFile)).toBe(false);
  });
});
