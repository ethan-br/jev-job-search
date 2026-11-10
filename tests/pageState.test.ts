import { describe, expect, it } from "vitest";
import { DECISIONS, PAGE_STATE } from "../src/config.js";
import { decidePageState, isConfirmation, sureness } from "../src/forms/pageState.js";
import { DecisionError, type Answers, type Decider, type DecisionInput, type DecisionUsage, type Questions, type DecisionCall } from "../src/decisions/types.js";

const usage: DecisionUsage = {
  calls: 0,
  attempts: 0,
  retries: 0,
  failed: 0,
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  estimatedUsd: 0,
  unknownAttempts: 0,
  unknownBoundUsd: 0,
};

const answers = (): Answers => ({
  state: { type: "choice", choice: "application_form", confidence: 0.9, probabilities: { application_form: 0.8 } },
  has_apply_button: { type: "predicate", probability: 0 },
  has_more_pages: { type: "predicate", probability: 0 },
  requires_references: { type: "predicate", probability: 0 },
  requires_cover_letter: { type: "predicate", probability: 0 },
});

function fakeDecider(onCall: (input: DecisionInput, questions: Questions, call: DecisionCall) => Answers): Decider {
  return {
    identity: { backend: "test", model: "m", requestVersion: 1 },
    usage,
    decide: async (input, questions, call) => onCall(input, questions, call),
  };
}

describe("decidePageState", () => {
  it("shows the start and the end of a long page, since what a click produced is at the end", async () => {
    let seen = "";
    const decider = fakeDecider((input) => {
      seen = String((input.evidence as { text: string }).text);
      return answers();
    });
    const page = `About the role. ${"word ".repeat(DECISIONS.maxPageTextChars)}A verification code was sent to you.`;
    const res = await decidePageState(decider, page, "https://x/1");
    expect(res.state).toBe("application_form");
    expect(seen.startsWith("About the role.")).toBe(true);
    expect(seen.endsWith("A verification code was sent to you.")).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(DECISIONS.maxPageTextChars + 10);
  });

  it("names the verification stage and passes the job id", async () => {
    let seenCall: DecisionCall | undefined;
    const decider = fakeDecider((_input, _questions, call) => {
      seenCall = call;
      return answers();
    });
    await decidePageState(decider, "form", "https://x/1", "job-7");
    expect(seenCall).toEqual({ stage: "verification", jobId: "job-7" });
  });

  it("throws when the state question is refused", async () => {
    const decider = fakeDecider(() => ({ ...answers(), state: { type: "refusal" } }));
    await expect(decidePageState(decider, "form", "https://x/1")).rejects.toBeInstanceOf(DecisionError);
    await expect(decidePageState(decider, "form", "https://x/1")).rejects.toMatchObject({ kind: "refused" });
  });

  it("throws when a predicate is refused", async () => {
    const decider = fakeDecider(() => ({ ...answers(), has_more_pages: { type: "refusal" } }));
    await expect(decidePageState(decider, "form", "https://x/1")).rejects.toBeInstanceOf(DecisionError);
    await expect(decidePageState(decider, "form", "https://x/1")).rejects.toMatchObject({ kind: "refused" });
  });

  it("leaves confidence null when neither confidence nor probabilities were reported", async () => {
    const decider = fakeDecider(() => ({
      ...answers(),
      state: { type: "choice", choice: "application_form", confidence: null, probabilities: {} },
    }));
    expect((await decidePageState(decider, "form", "https://x/1")).confidence).toBeNull();
  });

  it("uses the weaker reported confidence and picked probability", async () => {
    const decider = fakeDecider(() => ({
      ...answers(),
      state: { type: "choice", choice: "application_form", confidence: 0.7, probabilities: { application_form: 0.4 } },
    }));
    expect((await decidePageState(decider, "form", "https://x/1")).confidence).toBe(0.4);
  });
});

describe("page state helpers", () => {
  it("requires submitted state and enough confidence for confirmation", () => {
    expect(isConfirmation({ state: "submitted", confidence: PAGE_STATE.confirmationSupport })).toBe(true);
    expect(isConfirmation({ state: "submitted", confidence: PAGE_STATE.confirmationSupport - 0.01 })).toBe(false);
    expect(isConfirmation({ state: "submitted", confidence: null })).toBe(false);
    expect(isConfirmation({ state: "application_form", confidence: 0.99 })).toBe(false);
  });

  it("formats sureness or reports missing confidence", () => {
    expect(sureness(null)).toBe("no confidence given");
    expect(sureness(0.7)).toBe("0.70");
  });
});
