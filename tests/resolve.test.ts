import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, buildSystem, candidateContext, contextFingerprint, FORM_PROMPT_VERSION, FORM_SCHEMA_VERSION, logNotes, NOTES_SCHEMA, parseResolution, resolveOpenFields, RESOLUTION_SCHEMA } from "../src/answers/resolve.js";
import { ProfileSchema } from "../src/profile/schema.js";
import { setWriterForTests, WriterError, type Writer } from "../src/writer/index.js";

const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
const open = [{ selector: "#q1", kind: "textarea", label: "Why Acme?", question: "", hint: "", required: true, maxLength: 500, options: [], why: "needs writing" }];
let reply: unknown = { verdict: "ready", reason: "", answers: [{ selector: "#q1", value: "Because." }], note: null };
let seen: Array<Parameters<Writer["write"]>[0]> = [];
let identity = "fake-1";
const fake: Writer = {
  get identity() { return identity; },
  async write(task) {
    seen.push(task);
    return { output: task.output.parse(reply), writer: { name: "fake", version: null, model: null }, billing: "free", usage: null, costUsd: null };
  },
};
afterEach(() => { setWriterForTests(null); seen = []; reply = { verdict: "ready", reason: "", answers: [{ selector: "#q1", value: "Because." }], note: null }; identity = "fake-1"; });

describe("resolution", () => {
  it("parses JSON values, nullable notes, defaults and verdict validation", () => {
    expect(parseResolution({ verdict: "ready", answers: [{ selector: "#q1", value: "yes" }], note: null })).toEqual({ verdict: "ready", reason: "", answers: [{ selector: "#q1", value: "yes", reusable: false }] });
    expect(() => parseResolution({ verdict: "maybe" })).toThrow();
  });
  it("keeps the candidate prompt and context", () => {
    expect(buildSystem(profile)).toContain("Truth comes first.");
    expect(candidateContext(profile).candidate).toBeDefined();
    expect(JSON.parse(buildPrompt(null, [], open)).open_fields).toHaveLength(1);
    const text = buildSystem(profile);
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}|OPENAI_API_KEY/);
    expect(text).not.toContain(profile.resume.path);
  });
  it("writes one task and filters unknown selectors", async () => {
    setWriterForTests(fake);
    reply = { verdict: "ready", reason: "", answers: [{ selector: "#q1", value: "yes" }, { selector: "#other", value: "no" }], note: null };
    const result = await resolveOpenFields(profile, null, [], open);
    expect(result.answers).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "form_answers", jobId: null, promptVersion: FORM_PROMPT_VERSION, system: buildSystem(profile), input: buildPrompt(null, [], open), output: { version: FORM_SCHEMA_VERSION } });
  });
  it("does not call the writer for no open fields and propagates writer errors", async () => {
    setWriterForTests(fake);
    await resolveOpenFields(profile, null, [], []);
    expect(seen).toHaveLength(0);
    setWriterForTests({ identity: "bad", async write() { throw new WriterError("exit", "failed"); } });
    await expect(resolveOpenFields(profile, null, [], open)).rejects.toThrow("failed");
  });
  it("leaves the tracking notes empty when the writer fails, and says so", async () => {
    setWriterForTests({ identity: "bad", async write() { throw new WriterError("billing", "refused"); } });
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await logNotes(profile, [{ job: { id: "job-1", company: "A", title: "B", description: "C" } } as never])).toEqual(new Map());
    expect(said).toHaveBeenCalledWith(expect.stringContaining("refused"));
    said.mockRestore();
  });
  it("maps tracking notes by job id", async () => {
    setWriterForTests(fake);
    reply = { notes: [{ id: "job-1", what_they_do: "Builds tools.", why_fit: "I shipped tools." }] };
    expect(await logNotes(profile, [{ job: { id: "job-1", company: "A", title: "B", description: "C" } } as never])).toEqual(new Map([["job-1", { whatTheyDo: "Builds tools.", whyFit: "I shipped tools." }]]));
    expect(seen[0]).toMatchObject({ kind: "tracking_notes", jobId: null });
  });
  it("keys context by profile and writer", () => {
    setWriterForTests(fake);
    const first = contextFingerprint(profile);
    expect(contextFingerprint(profile)).toBe(first);
    expect(contextFingerprint({ ...profile, facts: [...profile.facts, "new"] })).not.toBe(first);
    identity = "fake-2";
    expect(contextFingerprint(profile)).not.toBe(first);
  });
  it("uses strict schemas and its own parser", async () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const value = node as Record<string, unknown>;
      if (value.properties && typeof value.properties === "object") {
        expect(value.additionalProperties).toBe(false);
        expect(value.required).toEqual(Object.keys(value.properties));
      }
      Object.values(value).forEach(walk);
    };
    walk(RESOLUTION_SCHEMA);
    walk(NOTES_SCHEMA);
    setWriterForTests(fake);
    reply = { verdict: "maybe" };
    await expect(resolveOpenFields(profile, null, [], open)).rejects.toThrow();
  });
});
