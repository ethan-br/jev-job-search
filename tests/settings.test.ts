import { describe, expect, it } from "vitest";
import { DECISIONS, OPENCODE_DECISIONS } from "../src/config.js";
import { decisionSettings, settingsProblems, writerSettings } from "../src/settings.js";

describe("decision settings", () => {
  it("requires a clean key and reads spend defaults and amounts", () => {
    expect(() => decisionSettings({})).toThrow(/OPENAI_API_KEY.*Do not paste the key into a chat/);
    expect(() => decisionSettings({ OPENAI_API_KEY: "has space" })).toThrow(/OPENAI_API_KEY/);
    expect(decisionSettings({ OPENAI_API_KEY: "runtime-key" })).toMatchObject({ runCapUsd: DECISIONS.runSpendCapUsd, budgetUsd: null });
    expect(decisionSettings({ OPENAI_API_KEY: "runtime-key", DECISIONS_RUN_CAP_USD: "0.25", DECISIONS_BUDGET_USD: "8" })).toMatchObject({ runCapUsd: 0.25, budgetUsd: 8 });
  });
  it("rejects malformed and inconsistent amounts by variable", () => {
    for (const amount of ["abc", "-1", "1e3", "$5"]) expect(() => decisionSettings({ OPENAI_API_KEY: "key", DECISIONS_BUDGET_USD: amount })).toThrow(/DECISIONS_BUDGET_USD/);
    expect(decisionSettings({ OPENAI_API_KEY: "key", DECISIONS_BUDGET_USD: "   " }).budgetUsd).toBeNull();
    expect(() => decisionSettings({ OPENAI_API_KEY: "key", DECISIONS_RUN_CAP_USD: "0" })).toThrow(/DECISIONS_RUN_CAP_USD/);
    expect(() => decisionSettings({ OPENAI_API_KEY: "key", DECISIONS_RUN_CAP_USD: "2", DECISIONS_BUDGET_USD: "1" })).toThrow(/DECISIONS_RUN_CAP_USD.*DECISIONS_BUDGET_USD/);
  });
  it("does not honour the previous key name", () => {
    const oldKey = ["OPENROUTER", "API", "KEY"].join("_");
    expect(() => decisionSettings({ [oldKey]: "legacy" })).toThrow(/OPENAI_API_KEY/);
  });
  it("uses the OpenCode key only when that backend is named", () => {
    const openai = "openai-secret-value";
    const opencode = "opencode-secret-value";
    expect(decisionSettings({ OPENAI_API_KEY: openai, OPENCODE_API_KEY: opencode }).backend).toBe("openai");
    expect(decisionSettings({ OPENAI_API_KEY: openai, OPENCODE_API_KEY: opencode }).apiKey).toBe(openai);
    const selected = decisionSettings({ DECISIONS_BACKEND: "opencode", OPENAI_API_KEY: openai, OPENCODE_API_KEY: opencode });
    expect(selected).toMatchObject({ backend: "opencode", apiKey: opencode });
    expect(JSON.stringify(selected)).not.toContain(openai);
    expect(() => decisionSettings({ DECISIONS_BACKEND: "opencode", OPENAI_API_KEY: openai })).toThrow(/OPENCODE_API_KEY.*Do not paste the key into a chat/);
    expect(() => decisionSettings({ DECISIONS_BACKEND: "opencode", OPENCODE_API_KEY: "has space" })).toThrow(/OPENCODE_API_KEY/);
    expect(() => decisionSettings({ DECISIONS_BACKEND: "jev" })).toThrow(/no fallback/);
    expect(OPENCODE_DECISIONS.model).toBe("jev-1.13-free");
  });
});

const writer = (env: NodeJS.ProcessEnv = {}) => writerSettings({ WRITER_COMMAND: JSON.stringify(["node", "examples/writers/mock-writer.mjs"]), ...env });
describe("writer settings", () => {
  it("validates command JSON and preserves a valid command", () => {
    expect(() => writerSettings({})).toThrow(/WRITER_COMMAND.*docs\/WRITER\.md/);
    expect(() => writerSettings({ WRITER_COMMAND: "node examples/writers/mock-writer.mjs" })).toThrow(/JSON array/);
    for (const command of ["{}", "[]", '["node",2]', '[" "]']) expect(() => writerSettings({ WRITER_COMMAND: command })).toThrow(/WRITER_COMMAND/);
    const command = ["node", "examples/writers/mock-writer.mjs"];
    expect(writerSettings({ WRITER_COMMAND: JSON.stringify(command) }).command).toEqual(command);
  });
  it("checks the writer environment pass list", () => {
    expect(writer({ WRITER_ENV: "  KEEP_A, KEEP_B  " }).passEnv).toEqual(["KEEP_A", "KEEP_B"]);
    expect(() => writer({ WRITER_ENV: "OPENAI_API_KEY" })).toThrow(/decisions only/);
    expect(() => writer({ WRITER_ENV: "OPENCODE_API_KEY" })).toThrow(/never handed to the writer/);
    expect(() => writer({ WRITER_ENV: "JOB_SEARCH_THING" })).toThrow(/WRITER_ENV/);
    expect(() => writer({ WRITER_ENV: "not-a-name" })).toThrow(/WRITER_ENV/);
    expect(writer().passEnv).toEqual([]);
  });
  it("validates billing modes", () => {
    expect(writer().billing).toEqual(["subscription", "free"]);
    expect(writer({ WRITER_BILLING: "metered,unknown" }).billing).toEqual(["metered", "unknown"]);
    expect(() => writer({ WRITER_BILLING: "paid" })).toThrow(/WRITER_BILLING/);
  });
  it("identifies command and passed environment names independent of name order", () => {
    const a = writer({ WRITER_ENV: "A,B" });
    expect(writer({ WRITER_ENV: "B,A" }).identity).toBe(a.identity);
    const command = (args: string[]) => writerSettings({ WRITER_COMMAND: JSON.stringify(args) });
    expect(command(["node", "--model", "a"]).identity).not.toBe(command(["node", "--model", "b"]).identity);
    expect(writer().identity).not.toBe(a.identity);
  });
  it("reports each broken group without exposing the key value", () => {
    expect(settingsProblems({})).toMatchObject({ decisions: expect.stringContaining("OPENAI_API_KEY"), writer: expect.stringContaining("WRITER_COMMAND") });
    expect(settingsProblems({ OPENAI_API_KEY: "sensitive-value", WRITER_COMMAND: "[]" })).toMatchObject({ decisions: null, writer: expect.stringContaining("WRITER_COMMAND") });
    expect(JSON.stringify(settingsProblems({ OPENAI_API_KEY: "sensitive-value", WRITER_COMMAND: "[]" }))).not.toContain("sensitive-value");
    expect(settingsProblems({ OPENAI_API_KEY: "runtime-key", WRITER_COMMAND: '["node"]' })).toEqual({ decisions: null, writer: null });
  });
  it("ignores the previous writer variable", () => {
    const previousName = ["WRITER", "BACKEND"].join("_");
    expect(() => writerSettings({ [previousName]: "ignored" })).toThrow(/WRITER_COMMAND/);
  });
});
