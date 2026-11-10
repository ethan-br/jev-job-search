import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/accounts/secrets.js";
import { checkAccounts, checkChrome, checkDecisionSettings, checkWriterSettings, checkPlatform, runChecks, checkNode, checkProfile, checkResume, formatChecks, isReadyToRun, nextStep, type Check } from "../src/doctor.js";

const ok = (name: string): Check => ({ name, ok: true, detail: "fine", fix: "" });
const bad = (name: string, fix: string, optional = false): Check => ({ name, ok: false, detail: "missing", fix, optional });

describe("doctor", () => {
  it("accepts Node 22 and newer", () => {
    expect(checkNode("22.16.0").ok).toBe(true);
    expect(checkNode("20.11.1").ok).toBe(false);
  });
  it("checks decision settings without revealing the key", () => {
    expect(checkDecisionSettings({})).toMatchObject({ ok: false, detail: expect.stringContaining("OPENAI_API_KEY") });
    const key = `sk-${"k".repeat(12)}`;
    const check = checkDecisionSettings({ OPENAI_API_KEY: key });
    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain(key);
    expect(checkDecisionSettings({ OPENAI_API_KEY: key, DECISIONS_RUN_CAP_USD: "bad" }).ok).toBe(false);
  });
  it("checks writer settings without starting the program", () => {
    const env = { ...process.env, PATH: process.env.PATH };
    expect(checkWriterSettings({ ...env, WRITER_COMMAND: undefined }).ok).toBe(false);
    expect(checkWriterSettings({ ...env, WRITER_COMMAND: '["no-such-program-xyz"]' }).detail).toContain("was not found");
    expect(checkWriterSettings({ ...env, WRITER_COMMAND: JSON.stringify([process.execPath, "x.mjs"]) }).ok).toBe(true);
  });
  it("checks browser and platform support", () => {
    expect(checkChrome(null).ok).toBe(false);
    const linux = checkPlatform("linux", { PATH: "" });
    expect(linux.every((check) => check.optional)).toBe(true);
    expect(linux.map((check) => check.name)).toEqual(["Opening files", "Notifications", "Password store", "Scheduled runs"]);
    expect(checkPlatform("darwin", {}).filter((check) => ["Password store", "Scheduled runs"].includes(check.name)).every((check) => check.ok)).toBe(true);
  });
  it("does not call either backend by default", async () => {
    vi.mock("../src/writer/index.js", () => ({ probeWriter: vi.fn() }));
    vi.mock("../src/decisions/openai.js", () => ({ createDecider: vi.fn() }));
    const checks = await runChecks();
    const writerModule = await import("../src/writer/index.js");
    const decisionsModule = await import("../src/decisions/openai.js");
    expect(writerModule.probeWriter).not.toHaveBeenCalled();
    expect(decisionsModule.createDecider).not.toHaveBeenCalled();
    expect(checks.map((check) => check.name)).not.toContain("Decisions answer");
    expect(checks.map((check) => check.name)).not.toContain("Writer answers");
  });
  it("reads the example profile and names a missing one", () => {
    const { check, profile } = checkProfile(new URL("../data/profile.example.json", import.meta.url).pathname);
    expect(check.ok).toBe(true);
    expect(profile?.name.first).toBeTruthy();
    expect(checkProfile("/nowhere/profile.json").check).toMatchObject({ ok: false });
    expect(checkResume(null).ok).toBe(false);
  });
  it("names the first thing that blocks a run before anything optional", () => {
    const checks = [ok("Node.js"), bad("Your drafts", "write drafts", true), bad("Decisions key", "add the key"), bad("Your profile", "run setup")];
    expect(nextStep(checks)).toBe("add the key");
    expect(isReadyToRun(checks)).toBe(false);
    expect(formatChecks(checks)).toContain("Next step: add the key");
  });
  it("is ready when only optional things are missing, and still suggests them", () => {
    const checks = [ok("Node.js"), bad("Job queue", "run discover", true)];
    expect(isReadyToRun(checks)).toBe(true);
    expect(nextStep(checks)).toBe("run discover");
    expect(nextStep([ok("Node.js")])).toMatch(/Everything is in place/);
  });
  it("treats job-board accounts as optional, and says how each part works", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-search-doctor-"));
    const files = { accounts: path.join(dir, "accounts.json"), gmail: path.join(dir, "gmail.json") };
    const store = new MemoryStore();
    expect(checkAccounts(store, files)).toMatchObject({ ok: true, optional: true, detail: expect.stringMatching(/not set up/) });
    writeFileSync(files.accounts, JSON.stringify({ providers: { workday: { email: "candidate@example.com", mode: "create_if_missing", emailVerification: true, agreements: ["account_terms"] } } }));
    // No password is needed from the person: new accounts get one made for them. Gmail is optional too.
    expect(checkAccounts(store, files)).toMatchObject({ ok: true, detail: expect.stringMatching(/you click each verification link/) });
    writeFileSync(files.gmail, JSON.stringify({ clientId: "1234567890-fake.apps.googleusercontent.com", email: "candidate@example.com", connectedAt: "2026-10-03T00:00:00Z" }));
    store.values.set("gmail-refresh-token", "1//fake-refresh-token-0123456789");
    const ready = checkAccounts(store, files);
    expect(ready.detail).toMatch(/read from Gmail/);
    expect(JSON.stringify(ready)).not.toMatch(/fake-refresh/);
    writeFileSync(files.accounts, JSON.stringify({ enabled: false, accounts: [{ id: "workday:acme", provider: "workday", tenant: "acme", allowedOrigins: ["https://acme.wd5.myworkdayjobs.com"], email: "candidate@example.com", mode: "existing_only" }] }));
    expect(checkAccounts(store, files).detail).toMatch(/switched off/);
  });
});
