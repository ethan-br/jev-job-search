/**
 * The fit rating. One decision call per job with every question the pipeline
 * might need (speculative fan-out). Code turns the typed answers into a
 * composite score, hard skips, and human-readable reasons.
 */
import { FIT_GATES, FIT_WEIGHTS, GRADUATION_MISMATCH_MULTIPLIER, LOCATION_MULTIPLIER, RECENCY_FLOOR, DISCOVER } from "../config.js";
import { choice, choiceOf, DecisionError, predicate, probabilityOf, score, scoreOf, scoreToUnit, supports } from "../decisions/types.js";
import type { Answers, ChoiceAnswer, Decider, DeciderIdentity, Questions, ScoreAnswer } from "../decisions/types.js";
import { monthName, usStatus, type Profile } from "../profile/schema.js";
import { locationTier, type LocationTier } from "./hardFilters.js";
import { ageDays, type Job } from "./normalize.js";
import { hashOf, type KeyedCache } from "../util/cache.js";

const LEVELS5 = ["None", "Weak", "Partial", "Strong", "Near exact"];
const CALLBACK_LEVELS = ["Very unlikely", "Unlikely", "Possible", "Likely", "Very likely"];

/** The term criteria, worded for the candidate's own graduation year so the same code serves any class. */
function termCriteria(gradMonth: number, gradYear: number): Record<string, string> {
  const grad = `${monthName(gradMonth)} ${gradYear}`;
  return {
    summer: `Summer ${gradYear} internship or co-op (roughly May to August ${gradYear})`,
    new_grad: `Full-time role a candidate graduating in ${grad} could start by mid ${gradYear}`,
    winter: `Winter or Spring ${gradYear} term (January to April ${gradYear})`,
    earlier: `Fall ${gradYear - 1} or starts before January ${gradYear}`,
    other: "A different term, rolling with no term stated, or unclear",
  };
}

/** Every question for one posting, with the term and graduation wording taken from the profile. */
export function fitQuestions(profile: Pick<Profile, "education">): Questions {
  const edu = profile.education[0];
  const month = edu?.gradMonth ?? 4;
  const year = edu?.gradYear ?? new Date().getUTCFullYear() + 1;
  return {
    ...FIT_QUESTIONS,
    term: choice("Which term or start does this posting target?", termCriteria(month, year)),
    graduation_excluded: predicate(`Does the posting require a graduation date or year of study that a candidate graduating in ${monthName(month)} ${year} does not meet?`, {
      true: `It names a graduation window, class year or "returning to school after" rule that excludes ${monthName(month)} ${year}`,
      false: `No graduation requirement is stated, or ${monthName(month)} ${year} fits it`,
    }),
  };
}

export const FIT_QUESTIONS: Questions = {
  is_software_role: predicate("Is this a software engineering or software developer role (writing application, backend, frontend, mobile, infrastructure or platform code)?", {
    true: "The day-to-day work is writing software",
    false: "Hardware, data science, analytics, product, research, IT support, or anything else",
  }),
  level: choice("What level is this posting?", {
    internship: "Internship, co-op, student or work term",
    new_grad: "New grad, early career, entry level, or junior with 0 to 2 years",
    experienced: "Requires 3 or more years of professional experience, or is mid, senior or staff",
    other: "Unclear or not a job posting",
  }),
  is_unpaid: predicate("Does the posting say the role is unpaid, volunteer, or for academic credit only?"),
  needs_advanced_degree: predicate("Does the posting require (not merely prefer) a Master's degree or PhD?"),
  work_auth: choice("What does the posting require for work authorization?", {
    canada_ok: "Canadian work authorization is enough, or the role is in Canada with no restriction stated",
    us_sponsors: "The role is in the United States and the posting says sponsorship is available or possible",
    us_no_sponsorship: "The role is in the United States and the posting says no sponsorship, or must be authorized without sponsorship",
    us_citizenship_required: "US citizenship, a security clearance, or ITAR eligibility is required",
    remote_global: "Remote and open to candidates in any country",
    unclear: "Not stated and not inferable",
  }),
  term: choice("Which term or start does this posting target?", termCriteria(4, new Date().getUTCFullYear() + 1)),
  graduation_excluded: predicate("Does the posting require a graduation date or year of study the candidate does not meet?"),
  returning_student_required: predicate("Does the posting require the candidate to return to school after the internship?"),
  stack_match: score("How well does the candidate's technical stack match what the posting asks for?", LEVELS5),
  experience_match: score("How well does the candidate's experience level and background match what the posting asks for?", LEVELS5),
  location_tier: choice("Where is the role?", {
    vancouver: "Vancouver or the Lower Mainland, BC",
    canada: "Elsewhere in Canada",
    remote: "Remote, and not restricted to the United States",
    us: "In the United States, or remote restricted to the United States",
    international: "Outside Canada and the United States",
    unclear: "Not stated",
  }),
  interview_practical: predicate("Does the posting describe a practical interview process (take-home, pair programming, project review, or AI tools permitted) rather than algorithm puzzles?"),
  callback_likelihood: score("Given everything, how likely is this candidate to be invited to interview if they apply?", CALLBACK_LEVELS),
  needs_account: predicate("Does applying require creating an account or logging in on the company's own careers portal (as opposed to a single form)?"),
  requires_references: predicate("Does the posting say references are required with the application?"),
};

export type FitResult = {
  score: number;
  decision: "apply" | "below_threshold" | "skip";
  skipReason: string | null;
  reasons: string[];
  components: Record<string, number>;
  locationTier: LocationTier;
  answers: Answers;
};

export function buildFitState(job: Job, profile: Profile, now = new Date()): Record<string, unknown> {
  const age = ageDays(job, now);
  return {
    job: {
      company: job.company,
      title: job.title,
      locations: job.locations,
      posted_days_ago: age,
      terms_from_source: job.terms,
      sponsorship_flag_from_source: job.sponsorship,
      description: job.description || "(no description available; judge from the title and company)",
    },
    candidate: {
      summary: profile.summary,
      skills: profile.skills,
      facts: profile.facts,
      graduation: profile.education[0] ? `${monthName(profile.education[0].gradMonth)} ${profile.education[0].gradYear}` : "not given",
      citizenship: profile.workAuthorization.citizenships,
      authorized_to_work_in: profile.workAuthorization.authorizedCountries,
      preferred_locations: profile.preferences.preferredLocations,
    },
  };
}

/**
 * What a rating depends on: the posting as the decision backend sees it, the candidate, the
 * questions, and who decides (backend, model, request version), so an answer from another model
 * is never reused. The posting's age is left out. It changes every day, it is not what the
 * questions are about, and the score takes it from the date, not from the backend.
 */
export function ratingKey(job: Job, profile: Profile, identity: DeciderIdentity): string {
  const state = buildFitState(job, profile, new Date(0)) as { job: Record<string, unknown>; candidate: unknown };
  const { posted_days_ago: _age, ...posting } = state.job;
  return hashOf({ id: job.id, posting, candidate: state.candidate, questions: fitQuestions(profile), identity });
}

/**
 * Rates a posting. With a cache, an unchanged posting gets the answers given before, and the score
 * is worked out afresh for today. Answers that cannot be scored (a question refused or left out)
 * throw before anything is cached, so a posting is never remembered as rated when it was not.
 */
export async function rateJob(decider: Decider, job: Job, profile: Profile, now = new Date(), cache?: KeyedCache<Answers>): Promise<FitResult> {
  const key = cache ? ratingKey(job, profile, decider.identity) : "";
  const cached = cache?.get(key);
  if (cached) return scoreFromAnswers(job, cached, now, usStatus(profile));
  const state = buildFitState(job, profile, now) as { job: Record<string, unknown>; candidate: Record<string, unknown> };
  // The candidate is the same for every posting, so it is the shared part a backend can reuse.
  const answers = await decider.decide({ shared: { candidate: state.candidate }, evidence: { job: state.job } }, fitQuestions(profile), { stage: "screening", jobId: job.id });
  const result = scoreFromAnswers(job, answers, now, usStatus(profile));
  cache?.set(key, answers);
  return result;
}

/**
 * Turns the answers into a score, the hard skips and the reasons. Every question must have an
 * answer of its own kind: one the backend declined, or one that is missing, cannot be read as
 * "no" or as a low score, so it throws and the posting stays unrated.
 */
export function scoreFromAnswers(job: Job, answers: Answers, now = new Date(), us: { authorized: boolean; citizen: boolean } = { authorized: false, citizen: false }): FitResult {
  const declined = (k: string): never => {
    throw new DecisionError("refused", `the backend declined to answer ${k}, so the posting cannot be rated`);
  };
  const n = (k: string): number => probabilityOf(answers, k) ?? declined(k);
  const c = (k: string): ChoiceAnswer => choiceOf(answers, k) ?? declined(k);
  const s = (k: string): ScoreAnswer => scoreOf(answers, k) ?? declined(k);
  // Read every question once up front, so a rating fails whole or not at all.
  for (const [k, q] of Object.entries(FIT_QUESTIONS)) {
    if (q.type === "predicate") n(k);
    else if (q.type === "choice") c(k);
    else s(k);
  }
  const reasons: string[] = [];

  const codeTier = locationTier(job.locations);
  const tier: LocationTier = codeTier !== "unclear" ? codeTier : (c("location_tier").choice as LocationTier);

  let skipReason: string | null = null;
  if (n("is_software_role") < FIT_GATES.softwareRole) skipReason = "not a software role";
  else if (c("level").choice === "experienced" && supports(c("level"), FIT_GATES.experiencedLevel)) skipReason = "requires professional experience";
  else if (n("is_unpaid") > FIT_GATES.unpaid) skipReason = "unpaid";
  else if (n("needs_advanced_degree") > FIT_GATES.advancedDegree) skipReason = "advanced degree required";
  else if (c("work_auth").choice === "us_no_sponsorship" && supports(c("work_auth"), FIT_GATES.workAuth) && !us.authorized) skipReason = "US role, no sponsorship";
  else if (c("work_auth").choice === "us_citizenship_required" && supports(c("work_auth"), FIT_GATES.workAuth) && !us.citizen) skipReason = "US citizenship or clearance required";
  else if (job.ats === "other" && n("needs_account") > FIT_GATES.needsAccount) skipReason = "needs an account to apply";
  else if (n("requires_references") > FIT_GATES.references) skipReason = "references required";

  const levelFit = { internship: 1, new_grad: 1, experienced: 0.1, other: 0.3 }[c("level").choice] ?? 0.3;
  const termFit = { summer: 1, new_grad: 1, winter: 0.8, earlier: 0.3, other: 0.5 }[c("term").choice] ?? 0.5;
  const components = {
    stackMatch: scoreToUnit(s("stack_match").score, LEVELS5.length),
    experienceMatch: scoreToUnit(s("experience_match").score, LEVELS5.length),
    callbackLikelihood: scoreToUnit(s("callback_likelihood").score, CALLBACK_LEVELS.length),
    levelFit,
    termFit,
    interviewPractical: n("interview_practical"),
  };
  let base = 0;
  for (const [k, w] of Object.entries(FIT_WEIGHTS)) base += w * (components[k as keyof typeof components] ?? 0);
  const age = ageDays(job, now);
  const recency = age === null ? 0.85 : 1 - (1 - RECENCY_FLOOR) * Math.min(1, age / DISCOVER.maxAgeDays);
  // The candidate may still apply, so a graduation window that excludes them lowers the rank instead of dropping the job.
  const gradExcluded = n("graduation_excluded") > FIT_GATES.graduationExcluded;
  const scoreValue = Math.round(base * LOCATION_MULTIPLIER[tier] * recency * (gradExcluded ? GRADUATION_MISMATCH_MULTIPLIER : 1) * 1000) / 1000;

  if (c("work_auth").choice === "us_sponsors" && !us.authorized) reasons.push("US role, sponsorship offered");
  if (c("work_auth").choice === "unclear" && tier === "us" && !us.authorized) reasons.push("US role, sponsorship not stated");
  if (gradExcluded) reasons.push("asks for a different graduation date");
  if (n("returning_student_required") > FIT_GATES.returningStudent) reasons.push("may require returning to school after the term");
  if (n("interview_practical") > FIT_GATES.interviewPractical) reasons.push("practical interview process");
  reasons.push(`stack ${LEVELS5[Math.round(s("stack_match").score)] ?? ""}`.toLowerCase());
  reasons.push(`callback ${CALLBACK_LEVELS[Math.round(s("callback_likelihood").score)] ?? ""}`.toLowerCase());

  const decision: FitResult["decision"] = skipReason ? "skip" : scoreValue >= DISCOVER.applyThreshold ? "apply" : "below_threshold";
  return { score: scoreValue, decision, skipReason, reasons, components, locationTier: tier, answers };
}
