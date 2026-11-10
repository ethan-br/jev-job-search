/**
 * What the decision backend leaves open goes to the writer: the drafts, the fields a person would
 * have reviewed, and anything the page refused. The writer is whatever program the person
 * configured (see `src/writer/`). It is asked for one JSON value in a schema this file owns, and
 * what comes back is checked against that schema before any of it is used.
 */
import { z } from "zod";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import { getWriter, WriterError, writerFingerprint } from "../writer/index.js";
import { WRITER } from "../config.js";
import { BANK_DRAFTS, BANK_INTENTS } from "./bank.js";
import { answerContext, jobContext } from "./context.js";
import { fingerprintOf, Resolution, type OpenField } from "./memory.js";

export { Resolution, type OpenField };

/**
 * Raise a prompt version when its instructions change and a schema version when its output does.
 * Both are part of what remembered answers are tied to, so nothing written under old rules is reused.
 */
export const FORM_PROMPT_VERSION = 1;
export const FORM_SCHEMA_VERSION = 1;
export const NOTES_PROMPT_VERSION = 1;
export const NOTES_SCHEMA_VERSION = 1;

const SYSTEM = [
  "You finish job application forms for one candidate. You are given the candidate's facts, the job, what is already filled in, and the fields still open.",
  'Reply with one JSON object in the schema you are given: {"verdict": "ready" | "needs_review" | "skip", "reason": string, "answers": [{"selector": string, "value": string, "reusable": boolean}], "note": {"what_they_do": string, "why_fit": string} | null}. reason is an empty string when there is nothing to say.',
  "",
  "Truth comes first.",
  "- Use only the candidate's facts, experience, projects, standing answers and the job posting. Never invent a fact, a number, a skill level, a date or a credential.",
  "- Work authorization, citizenship, education and dates are exactly as given. The candidate is authorized only in the countries listed and needs sponsorship elsewhere.",
  "- If a required field cannot be answered truthfully from the facts (a residence the candidate does not have, a self-rating of a skill the facts do not mention, a quiz or take-home, a clearance, a reference's contact details), do not guess: set verdict to \"needs_review\" and say which field in reason.",
  "- needs_review is only for that. When the facts or a standing answer reasonably settle a field, answer it and keep the verdict \"ready\". A person who is not employed has no notice period, so the shortest option is true.",
  "- Never sign for the candidate. A field that asks them to type their name to agree to an NDA or any other contract, and any NDA, is left unanswered and the verdict is \"needs_review\". A checkbox that acknowledges an agreement, a notice or terms follows the standing answers.",
  "- Never choose a date, a time slot or a venue for an interview, an assessment or an event on the candidate's behalf. That field is left unanswered and the verdict is \"needs_review\".",
  "- If the form requires a cover letter or references, set verdict to \"skip\" with the reason.",
  "- Whether to apply is the candidate's decision, already made. A posting that prefers another graduation date, location or visa status is not a reason to stop: answer every question truthfully, follow the standing answers, and note the mismatch in reason while keeping the verdict \"ready\".",
  "",
  "How to answer each kind of field.",
  "- select, radio, combobox with options: value is one option copied exactly. With no options listed for a combobox, value is the text to search for.",
  "- calendar: one date as YYYY-MM-DD, taken from the facts. When the facts give only a month, use its first day.",
  "- checkbox: \"true\" or \"false\". Consent that is needed to submit the application is \"true\". Optional marketing, job alerts, text messages and keeping data for future roles are \"false\".",
  "- text and textarea: write in the candidate's voice, following the voice rules exactly, inside maxLength. Match the length to the question: one line for a one-line box, 60 to 140 words for an open question unless it asks for more or less.",
  "- A checkbox or radio option comes with its question. Decide the whole group together from the question: tick the options that are true for the candidate, and for a yes/no pair tick exactly one.",
  "- A group of checkboxes where none applies: tick \"None of the above\" only if the facts settle every item in the group, otherwise tick \"I prefer not to answer\" when that exists.",
  "- Salary: use the standing wording unless a number is forced, which is needs_review.",
  "- Answer what is asked and no more. Sponsorship, visa status, GPA and anything else that counts against the candidate are stated truthfully wherever a field asks for them, and are not volunteered in free text that did not ask.",
  "- An optional field gets a value whenever the facts give a true one. Leave it out of answers only when nothing true applies to it.",
  "- A field listed with a reason like \"the page did not keep the value\" needs the value in the format the field wants (for a date box, a real date such as 2027-05-03 or 05/03/2027 as the hint or placeholder shows).",
  "",
  "Answer every open field you can, even when the verdict is needs_review, so a person only has to finish what is left.",
  "",
  "Two things that are not part of the form.",
  "- reusable, on each answer: true only when this exact value is the right answer to the same question on any other company's application form. It is false whenever the question or the value names or depends on this company, this role, its team, its product, its office or location, its pay or its dates, and false when you are not sure.",
  "- note is for the candidate's own tracking sheet. what_they_do: one plain sentence on what the company builds, from the posting, or empty if the posting does not say. why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\". Under 30 words each, no em dashes, no hype words. note is null when no job is given.",
].join("\n");

/** Everything about the candidate that is the same for every job: the voice guide, the facts and the starting drafts. */
export function candidateContext(profile: Profile): Record<string, unknown> {
  const ctx = answerContext(profile, null, "");
  return {
    voice_rules: ctx.voice,
    candidate: {
      ...ctx.candidate,
      email: profile.email,
      phone: `${profile.phone.countryCode} ${profile.phone.national}`,
      education: profile.education,
      address: `${profile.address.city}, ${profile.address.region}, ${profile.address.country}`,
      spokenLanguages: profile.spokenLanguages,
      demographics: profile.demographics,
      preferences: profile.preferences,
      workAuthorization: profile.workAuthorization,
    },
    /** Starting drafts for common questions. Adapt one to the question and the company; text in braces is for you to write. */
    bank: Object.fromEntries(Object.keys(BANK_INTENTS).map((k) => [k, { asks: BANK_INTENTS[k], draft: BANK_DRAFTS[k] }])),
  };
}

/** The system prompt: the rules, then the candidate. */
export function buildSystem(profile: Profile): string {
  return `${SYSTEM}\n\nThe candidate, the same for every form:\n${JSON.stringify(candidateContext(profile), null, 1)}`;
}

/**
 * What remembered answers are tied to: the rules, the candidate, and who writes (the configured
 * writer, the prompt and schema versions, the effort asked for). A change to any of them means
 * the answers are asked for afresh. Throws a WriterError when no writer is configured.
 */
export const contextFingerprint = (profile: Profile) => fingerprintOf(buildSystem(profile) + "|" + writerFingerprint("form_answers", FORM_PROMPT_VERSION, FORM_SCHEMA_VERSION));

/** The part that changes per form: the job, what is already filled, and the open fields. */
export function buildPrompt(entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): string {
  return JSON.stringify({ job: jobContext(entry), already_filled: filled, open_fields: open }, null, 1);
}

/** Checks what the writer returned. The schema makes every property required, so a note that does not apply comes as null and is dropped. */
export function parseResolution(value: unknown): Resolution {
  if (typeof value === "object" && value !== null && "note" in value && value.note === null) {
    const { note: _note, ...rest } = value;
    return Resolution.parse(rest);
  }
  return Resolution.parse(value);
}

/** The output asked of the writer, in the subset strict structured-output modes take. `Resolution` is what it is checked against. */
export const RESOLUTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ready", "needs_review", "skip"] },
    reason: { type: "string" },
    answers: { type: "array", items: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" }, reusable: { type: "boolean" } }, required: ["selector", "value", "reusable"], additionalProperties: false } },
    note: { type: ["object", "null"], properties: { what_they_do: { type: "string" }, why_fit: { type: "string" } }, required: ["what_they_do", "why_fit"], additionalProperties: false },
  },
  required: ["verdict", "reason", "answers", "note"],
  additionalProperties: false,
};

const LOG_SYSTEM = [
  "You write two short cells per job for a job-application tracking sheet. You are given several jobs and one candidate.",
  'Reply with one JSON object in the schema you are given: {"notes": [{"id": string, "what_they_do": string, "why_fit": string}]}, one entry per job, with the job\'s own id.',
  "what_they_do: one plain sentence on what the company builds, from the posting. If the posting says nothing about it, leave it empty.",
  "why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\".",
  "Use only the postings and the candidate's facts. No em dashes, no hype words, under 30 words each.",
].join("\n");

const LogNotes = z.object({ notes: z.array(z.object({ id: z.string(), what_they_do: z.string().default(""), why_fit: z.string().default("") })).default([]) });
export type LogNote = { whatTheyDo: string; whyFit: string };

export const NOTES_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { notes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, what_they_do: { type: "string" }, why_fit: { type: "string" } }, required: ["id", "what_they_do", "why_fit"], additionalProperties: false } } },
  required: ["notes"],
  additionalProperties: false,
};

/** Asks the writer to settle the open fields of one form. An answer for a field that was not asked about is dropped. */
export async function resolveOpenFields(profile: Profile, entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): Promise<Resolution> {
  if (!open.length) return { verdict: "ready", reason: "", answers: [] };
  const result = await getWriter().write({
    kind: "form_answers",
    jobId: entry?.job.id ?? null,
    system: buildSystem(profile),
    input: buildPrompt(entry, filled, open),
    promptVersion: FORM_PROMPT_VERSION,
    output: { version: FORM_SCHEMA_VERSION, jsonSchema: RESOLUTION_SCHEMA, parse: parseResolution },
  });
  const known = new Set(open.map((field) => field.selector));
  return { ...result.output, answers: result.output.answers.filter((answer) => known.has(answer.selector)) };
}

/**
 * The two tracking-sheet cells for jobs that have none yet, several jobs in one writer call.
 * The notes are a convenience: when the writer fails, the reason is printed and the cells stay empty.
 */
export async function logNotes(profile: Profile, entries: QueueEntry[]): Promise<Map<string, LogNote>> {
  const out = new Map<string, LogNote>();
  if (!entries.length) return out;
  const jobs = entries.map((entry) => ({ id: entry.job.id, company: entry.job.company, title: entry.job.title, posting: (entry.job.description ?? "").slice(0, WRITER.maxNoteChars) }));
  try {
    const result = await getWriter().write({
      kind: "tracking_notes",
      jobId: null,
      system: LOG_SYSTEM,
      input: JSON.stringify({ candidate: { summary: profile.summary, facts: profile.facts }, jobs }, null, 1),
      promptVersion: NOTES_PROMPT_VERSION,
      output: { version: NOTES_SCHEMA_VERSION, jsonSchema: NOTES_SCHEMA, parse: (value: unknown) => LogNotes.parse(value) },
    });
    for (const note of result.output.notes) out.set(note.id, { whatTheyDo: note.what_they_do, whyFit: note.why_fit });
  } catch (err) {
    if (!(err instanceof WriterError)) throw err;
    console.error(`[notes] the tracking notes were not written: ${err.message}`);
  }
  return out;
}
