/**
 * One decision call tells the apply loop what it is looking at after a
 * navigation or a click.
 */
import { DECISIONS, PAGE_STATE } from "../config.js";
import { choice, choiceOf, DecisionError, predicate, probabilityOf, supportOf, type Decider } from "../decisions/types.js";
import { truncate } from "../util/text.js";

export type PageState = {
  state: "job_description" | "application_form" | "submitted" | "login_required" | "captcha" | "closed" | "error" | "other";
  /** How far the state can be relied on, as the backend reported it. Null when it reported nothing: every caller treats that as not sure. */
  confidence: number | null;
  probabilities: Record<string, number>;
  hasApplyButton: number;
  hasMorePages: number;
  requiresReferences: number;
  requiresCoverLetter: number;
};

/**
 * True when the page is a confirmation and the backend was sure enough of it for an application to
 * be recorded as sent. A confirmation it was not sure of, or gave no confidence for, does not count.
 */
export const isConfirmation = (s: Pick<PageState, "state" | "confidence">): boolean => s.state === "submitted" && s.confidence !== null && s.confidence >= PAGE_STATE.confirmationSupport;

/** How sure a reading was, for a line a person reads. */
export const sureness = (confidence: number | null): string => (confidence === null ? "no confidence given" : confidence.toFixed(2));

export async function decidePageState(decider: Decider, pageText: string, url: string, jobId = ""): Promise<PageState> {
  // What a click produced is usually at the end of a long page (a confirmation, an error, a request for a code), so a long page is shown by its start and its end.
  const flat = pageText.replace(/\s+/g, " ");
  const half = Math.floor(DECISIONS.maxPageTextChars / 2);
  const text = flat.length <= DECISIONS.maxPageTextChars ? flat : `${truncate(flat.slice(0, half), half)} [...] ${flat.slice(-half)}`;
  const questions = {
    state: choice("What kind of page is this?", {
      job_description: "A job posting with a description and an Apply button or link, but no form fields yet",
      application_form: "An application form with input fields to fill (name, email, resume, questions)",
      submitted: "A confirmation that the application was received or submitted, a thank-you page",
      login_required: "A sign-in, create-account or password page that blocks the application",
      captcha: "A CAPTCHA, bot check, or 'verify you are human' challenge",
      closed: "The posting is closed, expired, no longer accepting applications, or not found",
      error: "An error page: validation errors shown on the form, a 404 or 500, or a blank page",
      other: "None of the above",
    }),
    has_apply_button: predicate("Is there an Apply, Apply now, or Start application button or link?"),
    has_more_pages: predicate("Does the form continue on another page (a Next, Continue or Save and continue button rather than Submit)?"),
    requires_references: predicate("Does the form require references (names and contact details of referees)?"),
    requires_cover_letter: predicate("Is a cover letter required (not optional)?"),
  };
  const answers = await decider.decide({ evidence: { url, text } }, questions, { stage: "verification", ...(jobId ? { jobId } : {}) });
  // A page the backend would not read is a page that was not understood. It is never taken for "other" or for "no".
  const refused = (key: string) => new DecisionError("refused", `the decision backend declined to classify the page: ${key}`);
  const need = (key: string): number => {
    const p = probabilityOf(answers, key);
    if (p === null) throw refused(key);
    return p;
  };
  const state = choiceOf(answers, "state");
  if (state === null) throw refused("state");
  const hasApplyButton = need("has_apply_button");
  const hasMorePages = need("has_more_pages");
  const requiresReferences = need("requires_references");
  const requiresCoverLetter = need("requires_cover_letter");
  return {
    state: state.choice as PageState["state"],
    confidence: supportOf(state),
    probabilities: state.probabilities,
    hasApplyButton,
    hasMorePages,
    requiresReferences,
    requiresCoverLetter,
  };
}
