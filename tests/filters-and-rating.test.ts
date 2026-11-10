import { describe, expect, it } from "vitest";
import { DISCOVER } from "../src/config.js";
import { DecisionError } from "../src/decisions/types.js";
import { locationTier, preFilter } from "../src/jobs/hardFilters.js";
import type { Job } from "../src/jobs/normalize.js";
import { FIT_QUESTIONS, fitQuestions, ratingKey, rateJob, scoreFromAnswers } from "../src/jobs/rate.js";
import { usStatus } from "../src/profile/schema.js";
import type { Answer, Answers, Decider } from "../src/decisions/types.js";
import { ProfileSchema } from "../src/profile/schema.js";
import { readFileSync } from "node:fs";
import { KeyedCache } from "../src/util/cache.js";

const now = new Date("2026-10-02T12:00:00Z");
const job = (over: Partial<Job> = {}): Job => ({
  id: "j", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://job-boards.greenhouse.io/acme/jobs/1", ats: "greenhouse",
  locations: ["Toronto, ON, Canada"], postedAt: "2026-10-01", terms: ["Summer 2027"], sponsorship: "unknown", degrees: [], category: null, ...over,
});

describe("locationTier", () => {
  it.each([
    [["Vancouver, BC, Canada"], "vancouver"],
    [["Burnaby, BC"], "vancouver"],
    [["Toronto, ON"], "canada"],
    [["Montreal, QC, Canada"], "canada"],
    [["Remote"], "remote"],
    [["Remote in USA"], "us"],
    [["SF"], "us"],
    [["NYC"], "us"],
    [["Palo Alto, CA"], "us"],
    [["London, UK"], "international"],
    [[], "unclear"],
  ])("%j → %s", (locs, tier) => {
    expect(locationTier(locs)).toBe(tier);
  });
});

describe("preFilter", () => {
  it("passes a fresh Canadian software internship", () => {
    expect(preFilter(job(), now)).toBeNull();
  });
  it("rejects account-walled ATSs", () => {
    expect(preFilter(job({ ats: "workday" }), now)).toMatch(/workday/);
    expect(preFilter(job({ ats: "icims" }), now)).toMatch(/account/);
    expect(preFilter(job({ ats: "amazon" }), now)).toMatch(/account/);
  });
  it("rejects stale postings but keeps undated ones", () => {
    expect(preFilter(job({ postedAt: "2026-09-01" }), now)).toMatch(/days ago/);
    expect(preFilter(job({ postedAt: null }), now)).toBeNull();
  });
  it("rejects non-software titles unless they also say software", () => {
    expect(preFilter(job({ title: "Hardware Engineer Intern" }), now)).toMatch(/not a software role/);
    expect(preFilter(job({ title: "Product Manager Intern" }), now)).toMatch(/not a software role/);
    expect(preFilter(job({ title: "Software Engineer Intern, Hardware Tools" }), now)).toBeNull();
  });
  it("rejects US roles with no sponsorship or citizenship flags, but not Canadian ones", () => {
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "none" }), now)).toMatch(/no sponsorship/);
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "citizenship" }), now)).toMatch(/citizenship/);
    // A candidate who may work in the United States is not ruled out by "no sponsorship"; only a citizen passes a citizenship flag.
    const resident = { authorized: true, citizen: false };
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "none" }), now, () => false, resident)).toBeNull();
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "citizenship" }), now, () => false, resident)).toMatch(/citizenship/);
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "citizenship" }), now, () => false, { authorized: true, citizen: true })).toBeNull();
    expect(preFilter(job({ locations: ["Austin, TX"], sponsorship: "unknown" }), now)).toBeNull();
    expect(preFilter(job({ locations: ["Toronto, ON"], sponsorship: "none" }), now)).toBeNull();
  });
  it("rejects advanced-degree-only, French and unpaid postings", () => {
    expect(preFilter(job({ degrees: ["Master's", "PhD"] }), now)).toMatch(/advanced degree/);
    expect(preFilter(job({ degrees: ["Bachelor's", "Master's"] }), now)).toBeNull();
    expect(preFilter(job({ title: "Stagiaire en développement logiciel" }), now)).toMatch(/non-English/);
    expect(preFilter(job({ title: "Unpaid Software Intern" }), now)).toMatch(/unpaid/);
  });
});

function answers(over: Record<string, Partial<Answer>> = {}): Record<string, Answer> {
  const base: Record<string, Answer> = {
    is_software_role: { type: "predicate", probability: 0.98 },
    level: { type: "choice", choice: "internship", probabilities: { internship: 1 }, confidence: 1 },
    is_unpaid: { type: "predicate", probability: 0.02 },
    needs_advanced_degree: { type: "predicate", probability: 0.02 },
    work_auth: { type: "choice", choice: "canada_ok", probabilities: { canada_ok: 1 }, confidence: 1 },
    term: { type: "choice", choice: "summer", probabilities: { summer: 1 }, confidence: 1 },
    graduation_excluded: { type: "predicate", probability: 0.05 },
    returning_student_required: { type: "predicate", probability: 0.2 },
    stack_match: { type: "score", score: 3, levels: 5, probabilities: [], confidence: 0.8 },
    experience_match: { type: "score", score: 3, levels: 5, probabilities: [], confidence: 0.8 },
    location_tier: { type: "choice", choice: "canada", probabilities: {}, confidence: 1 },
    interview_practical: { type: "predicate", probability: 0.3 },
    callback_likelihood: { type: "score", score: 3, levels: 5, probabilities: [], confidence: 0.7 },
    needs_account: { type: "predicate", probability: 0.1 },
    requires_references: { type: "predicate", probability: 0.05 },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v } as Answer;
  return base;
}

describe("scoreFromAnswers", () => {
  it("asks every question the scorer reads", () => {
    for (const k of Object.keys(answers())) expect(FIT_QUESTIONS).toHaveProperty(k);
  });
  it("queues a strong, fresh Canadian internship", () => {
    const fit = scoreFromAnswers(job(), answers(), now);
    expect(fit.decision).toBe("apply");
    expect(fit.score).toBeGreaterThan(DISCOVER.applyThreshold);
    expect(fit.locationTier).toBe("canada");
  });
  it("ranks Vancouver above the same job in the US, and fresh above stale", () => {
    const van = scoreFromAnswers(job({ locations: ["Vancouver, BC"] }), answers(), now).score;
    const us = scoreFromAnswers(job({ locations: ["Austin, TX"] }), answers({ work_auth: { choice: "us_sponsors" } }), now).score;
    const stale = scoreFromAnswers(job({ locations: ["Vancouver, BC"], postedAt: "2026-09-19" }), answers(), now).score;
    expect(van).toBeGreaterThan(us);
    expect(van).toBeGreaterThan(stale);
  });
  it("skips on the hard rules regardless of score", () => {
    expect(scoreFromAnswers(job(), answers({ is_software_role: { probability:  0.2 } }), now).skipReason).toBe("not a software role");
    expect(scoreFromAnswers(job(), answers({ level: { choice: "experienced", confidence: 0.9 } }), now).skipReason).toMatch(/experience/);
    expect(scoreFromAnswers(job(), answers({ is_unpaid: { probability:  0.9 } }), now).skipReason).toBe("unpaid");
    expect(scoreFromAnswers(job(), answers({ needs_advanced_degree: { probability:  0.9 } }), now).skipReason).toMatch(/degree/);
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_no_sponsorship", confidence: 0.8 } }), now).skipReason).toMatch(/no sponsorship/);
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_citizenship_required", confidence: 0.8 } }), now).skipReason).toMatch(/citizenship/);
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_no_sponsorship", confidence: 0.8 } }), now, { authorized: true, citizen: false }).skipReason).toBeNull();
    expect(scoreFromAnswers(job({ locations: ["SF"] }), answers({ work_auth: { choice: "us_citizenship_required", confidence: 0.8 } }), now, { authorized: true, citizen: true }).skipReason).toBeNull();
    expect(scoreFromAnswers(job(), answers({ requires_references: { probability:  0.95 } }), now).skipReason).toMatch(/references/);
  });
  it("only trusts the account signal when the ATS is unknown", () => {
    expect(scoreFromAnswers(job({ ats: "greenhouse" }), answers({ needs_account: { probability:  0.95 } }), now).skipReason).toBeNull();
    expect(scoreFromAnswers(job({ ats: "other" }), answers({ needs_account: { probability:  0.95 } }), now).skipReason).toMatch(/account/);
  });
  it("uses the backend's location only when the code cannot tell", () => {
    const fit = scoreFromAnswers(job({ locations: [] }), answers({ location_tier: { choice: "remote" } }), now);
    expect(fit.locationTier).toBe("remote");
  });
});

describe("graduation window and account walls", () => {
  it("ranks a posting that asks for another graduation date lower, without dropping it", () => {
    const fits = scoreFromAnswers(job(), answers(), now);
    const excluded = scoreFromAnswers(job(), answers({ graduation_excluded: { probability:  0.95 } }), now);
    expect(excluded.decision).not.toBe("skip");
    expect(excluded.score).toBeLessThan(fits.score);
    expect(excluded.reasons).toContain("asks for a different graduation date");
  });
  it("rejects a rating saved before the question existed as incomplete", () => {
    const old = answers();
    delete old.graduation_excluded;
    expect(() => scoreFromAnswers(job(), old, now)).toThrowError(expect.objectContaining({ kind: "incomplete" }));
  });
  it("words the term and graduation questions from the profile's own graduation date", () => {
    const q = fitQuestions({ education: [{ school: "U", degree: "BSc", field: "CS", startMonth: 9, startYear: 2025, gradMonth: 12, gradYear: 2028, status: "in_progress" }] });
    expect(JSON.stringify(q.term)).toContain("Summer 2028");
    expect(JSON.stringify(q.graduation_excluded)).toContain("December 2028");
    for (const k of Object.keys(answers())) expect(q).toHaveProperty(k);
  });
  it("skips careers sites that need an account and boards whose forms cannot be read", () => {
    expect(preFilter(job({ url: "https://acme.eightfold.ai/careers/job/1", ats: "other" }), now, () => true)).toMatch(/account/);
    // An older posting passes when one search asks for more days.
    const old = job({ postedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString().slice(0, 10) });
    expect(preFilter(old, now, () => false)).toMatch(/posted 20 days ago/);
    expect(preFilter(old, now, () => false, { authorized: false, citizen: false }, 30)).toBeNull();
    // Jobvite's forms run over several pages, which the runner walks. SmartRecruiters' cannot be read yet.
    expect(preFilter(job({ ats: "jobvite" }), now, () => false)).toBeNull();
    expect(preFilter(job({ ats: "smartrecruiters" }), now, () => false)).toMatch(/cannot be read/);
    expect(preFilter(job(), now, () => false)).toBeNull();
  });
});

describe("decision answers and rating cache", () => {
  it("rejects refused, missing, and wrong-kind answers", () => {
    const refused = answers();
    refused.is_unpaid = { type: "refusal" };
    expect(() => scoreFromAnswers(job(), refused, now)).toThrowError(DecisionError);
    try { scoreFromAnswers(job(), refused, now); } catch (error) { expect(error).toMatchObject({ kind: "refused" }); }
    const missing = answers();
    delete missing.is_unpaid;
    expect(() => scoreFromAnswers(job(), missing, now)).toThrowError(expect.objectContaining({ kind: "incomplete" }));
    const wrong = answers();
    wrong.is_unpaid = { type: "choice", choice: "yes", probabilities: {}, confidence: null };
    expect(() => scoreFromAnswers(job(), wrong, now)).toThrowError(expect.objectContaining({ kind: "malformed" }));
  });
  it("requires supported choice gates", () => {
    expect(scoreFromAnswers(job(), answers({ level: { choice: "experienced", confidence: null, probabilities: {} } }), now).skipReason).toBeNull();
    expect(scoreFromAnswers(job(), answers({ level: { choice: "experienced", confidence: 0.99, probabilities: { experienced: 0.2 } } }), now).skipReason).toBeNull();
    expect(scoreFromAnswers(job(), answers({ level: { choice: "experienced", confidence: 0.99, probabilities: { experienced: 0.99 } } }), now).skipReason).toMatch(/experience/);
  });
  it("maps stack scores to units and uses the level label in reasons", () => {
    expect(scoreFromAnswers(job(), answers({ stack_match: { score: 0 } }), now).components.stackMatch).toBe(0);
    expect(scoreFromAnswers(job(), answers({ stack_match: { score: 4 } }), now).components.stackMatch).toBe(1);
    const middle = scoreFromAnswers(job(), answers({ stack_match: { score: 2 } }), now);
    expect(middle.components.stackMatch).toBe(0.5);
    expect(middle.reasons).toContain("stack partial");
  });
  it("keys ratings by decision identity but not posting age", () => {
    const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
    const identity = { backend: "test", model: "a", requestVersion: 1 };
    expect(ratingKey(job(), profile, identity)).toBe(ratingKey(job(), profile, identity));
    expect(ratingKey(job(), profile, identity)).not.toBe(ratingKey(job(), profile, { ...identity, model: "b" }));
    expect(ratingKey(job(), profile, identity)).not.toBe(ratingKey(job(), profile, { ...identity, backend: "other" }));
    expect(ratingKey(job(), profile, identity)).not.toBe(ratingKey(job(), profile, { ...identity, requestVersion: 2 }));
    expect(ratingKey(job({ postedAt: "2026-09-01" }), profile, identity)).toBe(ratingKey(job({ postedAt: "2026-10-01" }), profile, identity));
  });
  it("rates with screening context, shares candidate input, and caches only valid answers", async () => {
    const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
    const calls: Array<{ input: { shared?: Record<string, unknown>; evidence: Record<string, unknown> | string }; call: { stage: string; jobId?: string } }> = [];
    let refused = false;
    const decider: Decider = {
      identity: { backend: "test", model: "a", requestVersion: 1 },
      usage: { calls: 0, attempts: 0, retries: 0, failed: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, estimatedUsd: 0, unknownAttempts: 0, unknownBoundUsd: 0 },
      async decide(input, _questions, call) { calls.push({ input, call }); const result = answers(); if (refused) result.is_unpaid = { type: "refusal" }; return result; },
    };
    const cache = new KeyedCache<Answers>("/tmp/job-search-rating-test-cache.json", "all");
    await rateJob(decider, job(), profile, now, cache);
    expect(calls[0]?.call).toEqual({ stage: "screening", jobId: "j" });
    await rateJob(decider, job({ id: "other", company: "Other" }), profile, now, cache);
    expect(calls[0]?.input.shared).toEqual(calls[1]?.input.shared);
    await rateJob(decider, job(), profile, now, cache);
    expect(calls).toHaveLength(2);
    refused = true;
    await expect(rateJob(decider, job({ id: "refused" }), profile, now, cache)).rejects.toMatchObject({ kind: "refused" });
    expect(cache.get(ratingKey(job({ id: "refused" }), profile, decider.identity))).toBeUndefined();
  });
});

describe("usStatus", () => {
  const wa = (authorizedCountries: string[], citizenships: string[]) => ({ workAuthorization: { citizenships, authorizedCountries, requiresSponsorshipElsewhere: true, statement: "" } });
  it("reads the candidate's standing in the United States from the profile, however the country is written", () => {
    expect(usStatus(wa(["Canada"], ["Canada"]))).toEqual({ authorized: false, citizen: false });
    expect(usStatus(wa(["United States"], ["India"]))).toEqual({ authorized: true, citizen: false });
    expect(usStatus(wa(["USA", "Canada"], ["U.S."]))).toEqual({ authorized: true, citizen: true });
  });
});

