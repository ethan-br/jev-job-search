import { describe, expect, it } from "vitest";
import { RUN } from "../src/config.js";
import type { QueueEntry } from "../src/jobs/queue.js";
import { employerKey, interleaveEmployers, pickJobs } from "../src/run/pipeline.js";

const entry = (id: string, company: string, score: number): QueueEntry =>
  ({
    job: { id, source: "t", company, title: "SWE Intern", url: `https://job-boards.greenhouse.io/${id}/jobs/1`, ats: "greenhouse", locations: ["Toronto, ON"], postedAt: "2026-10-06", terms: [], sponsorship: "unknown", degrees: [], category: null },
    fit: { score, decision: "apply", skipReason: null, reasons: [], components: {}, locationTier: "canada", answers: {} },
    preFilterReason: null, status: "queued", statusReason: null, attempts: 0, discoveredAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", appliedAt: null, notes: null,
  }) as unknown as QueueEntry;

describe("employerKey", () => {
  it("joins spellings of one employer", () => {
    expect(employerKey("DoorDash")).toBe(employerKey("Doordash Canada"));
    expect(employerKey("Harvey")).toBe(employerKey("Harvey, Inc."));
    expect(employerKey("Clay")).not.toBe(employerKey("Clayton"));
  });
});

describe("interleaveEmployers", () => {
  it("keeps score order but never puts one employer's jobs next to each other when it can help it", () => {
    const out = interleaveEmployers([entry("a1", "Harvey", 0.9), entry("a2", "Harvey", 0.8), entry("b1", "Clay", 0.7), entry("a3", "Harvey", 0.6), entry("c1", "Ramp", 0.5)]);
    expect(out.map((e) => e.job.id)).toEqual(["a1", "b1", "a2", "c1", "a3"]);
  });
  it("leaves a single-employer list alone", () => {
    const out = interleaveEmployers([entry("a1", "Harvey", 0.9), entry("a2", "Harvey", 0.8)]);
    expect(out.map((e) => e.job.id)).toEqual(["a1", "a2"]);
  });
});

describe("pickJobs with several roles at one employer", () => {
  it("takes at most perEmployerPerRun from one employer and fills the count from others", () => {
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => entry(`h${i}`, "Harvey", 0.9 - i / 100)),
      entry("c1", "Clay", 0.5),
      entry("r1", "Ramp", 0.4),
    ];
    const { picked } = pickJobs(entries, [], { count: 5, dry: true });
    const harvey = picked.filter((e) => e.job.company === "Harvey");
    expect(harvey.length).toBe(RUN.perEmployerPerRun);
    expect(picked.length).toBe(5);
    expect(picked[0]?.job.company).toBe("Harvey");
    expect(picked[1]?.job.company).not.toBe("Harvey");
  });
  it("still respects the account gate", () => {
    const entries = [entry("a", "Harvey", 0.9), entry("b", "Clay", 0.8)];
    const { picked } = pickJobs(entries, [], { count: 5, dry: true }, (url) => (url.includes("/a/") ? "wait" : null));
    expect(picked.map((e) => e.job.id)).toEqual(["b"]);
  });
});

describe("greenhouse submit gap", () => {
  it("is configured well above the default site gap", () => {
    expect(RUN.submitGapByHost["greenhouse.io"]).toBeGreaterThan(RUN.submitGapMs * 10);
    expect(RUN.employerGapMs).toBeGreaterThan(RUN.submitGapByHost["greenhouse.io"] as number);
  });
});
