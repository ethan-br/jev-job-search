# Decisions: what the backend is and how this tool uses it

Every small judgement in this tool is a typed question sent to one decision backend: the OpenAI
Decisions API. Is this posting a software role? Which profile value belongs in this box? Is this
page a confirmation? The backend answers with a type and a probability. It writes nothing. All
writing goes to the writer you configure, which is a separate program with its own sign-in
(`docs/WRITER.md`).

**What has been tested.** The client is tested against recorded and hand-built responses
(`tests/decisions.test.ts`, `tests/decisions-usage.test.ts`). No live call has been made from this
fork: the request and response shapes below follow the API reference, and no latency, accuracy or
cost figure here was measured. The first live call is yours to make, with
`npx job-search doctor --probe-decisions`.

## The API

```
POST https://api.openai.com/v1/decisions
Authorization: Bearer <OPENAI_API_KEY>
Content-Type: application/json
```

The model is `gpt-6-luna`. The endpoint, the model and the prices are in `DECISIONS` in
`src/config.ts`. There is no other backend and no fallback: when this one cannot answer, the call
fails and says why.

A request has the evidence and a list of named questions:

```json
{
  "model": "gpt-6-luna",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "What is the same for every request: ...", "prompt_cache_breakpoint": { "mode": "explicit" } },
    { "type": "input_json", "data": { "job": { "company": "Example", "title": "Software Engineer Intern" } } }
  ] }],
  "questions": [
    { "type": "predicate", "name": "is_software_role", "instructions": "Is this a software engineering role?" },
    { "type": "choice", "name": "level", "instructions": "What level is this posting?", "choices": [{ "value": "internship", "description": "Internship, co-op or work term" }, { "value": "experienced", "description": "Requires 3 or more years" }] },
    { "type": "score", "name": "stack_match", "instructions": "How well does the stack match?", "levels": [{ "label": "No overlap" }, { "label": "Partial overlap" }, { "label": "Strong overlap" }] }
  ],
  "prompt_cache_options": { "mode": "explicit" }
}
```

What every call of one kind shares (your candidate facts) goes first, with a cache boundary after
it, so a repeat is read from the backend's cache at the cached price. Caching is explicit on
purpose: left implicit, every one-off posting would be written to the cache at a surcharge and
never read again.

## The three question types

| Type | Asks | Answer |
|---|---|---|
| `predicate` | Is this true? | `probability` from 0 to 1 that it is |
| `choice` | Which one of these (2 to 255)? | `value`, and when reported a `confidence` and a probability per choice |
| `score` | Where on this ordered scale (2 to 10 levels)? | `score` as an index, and when reported a `confidence` and a probability per level |
| any | | `refusal`: the backend declined this question |

One request takes at most 400 questions. A request outside these limits is refused by this tool
before it is sent, so it is never paid for.

In the code the questions are built with `predicate`, `choice` and `score` from
`src/decisions/types.ts`, and nothing outside `src/decisions/` knows which backend answers them.

## What the client checks

`src/decisions/openai.ts` treats a reply as an answer only when all of this holds:

- every question asked has exactly one answer, under its own name, and no answer is for a question that was not asked;
- each answer has the type its question had, or is a refusal;
- a choice is one of the choices offered, and a score is inside its levels;
- every probability is between 0 and 1.

Anything else is a malformed reply. It is an error, the call is recorded as failed, and nothing
from it is used.

How each failure is handled:

| What happened | What the tool does |
|---|---|
| Rate limit (429), server error (5xx), timeout, network error | Tried again, at most 3 more times, with a growing pause. A `Retry-After` up to 20 seconds is obeyed |
| Bad key or no permission (401, 403) | Stops. Not tried again. The run ends, and jobs go back to the queue |
| Out of credit or quota | Stops the same way |
| Request refused (400), input too long | Not tried again. A form too long for one call is split in two and each half is asked |
| Malformed reply, a missing answer | An error. Not tried again |
| A refusal for one question | A first-class answer, never a "no" and never a low score. See below |

## Refusals and confidence

A refusal is not an answer of "no". Where a refusal shows up:

- **Rating a posting.** The posting is not rated and stays out of the queue until a later search.
  It is not skipped and not scored.
- **Mapping a form field.** The field goes to review with the note "the decision backend declined
  this field". It is not filled and not left blank on a guess.
- **Reading a page after a click.** The read fails, and the application stays "not confirmed" for you to settle.
- **Reading a reply in your inbox.** The email is held for you to confirm in the dashboard.

Confidence is never made up. An answer carries the confidence the backend reported, or `null`.
Gates use *support*: the weaker of the reported confidence and the probability of the value that
was picked (`supportOf` in `src/decisions/types.ts`). Backends define "confidence" loosely, so
neither number is trusted alone. When the backend reported neither, the support is unknown, and an
unknown support passes no gate. A value that code decided (your email, a date from your profile)
has no confidence at all and is marked that way.

## Thresholds

The thresholds are in `src/config.ts`. They were set for the earlier backend and reviewed for this
one, but **none has been measured against `gpt-6-luna`**. Treat them as conservative starting
points, rehearse with `--dry`, and read the fill reports before you trust a run.

| Where | Rule |
|---|---|
| Form field (`FORM`) | Support at or above 0.9: fill. From 0.5 to 0.9: fill and note the support in the report. Below 0.5 or unknown: review |
| Checkbox (`FORM.gates`) | Ticked at a probability of 0.7 or more, left at 0.3 or less, yours to decide in between |
| Work authorization answers | An option that is not a plain yes or no needs support of 0.85. The yes or no itself always comes from your profile, in code |
| Statements about you that code cannot check | Filled at support of 0.8 or more, among at most 6 options |
| Confirmation page (`PAGE_STATE`) | An application is recorded as sent only when the page is read as "submitted" with support of 0.7 or more. Otherwise it is "not confirmed" and waits for `npx job-search reconcile` |
| Hard skips in rating (`FIT_GATES`) | Each needs clear evidence, for example "not a software role" below 0.5 and "references required" above 0.85 |
| Inbox (`INBOX`) | A reply is recorded without asking you only above the confidence set there |

What stays outside the model, decided by code from your profile: whether you may work in a
country, whether you need sponsorship, your GPA policy, dates, your contact details, which resume
is attached, and every rule about what may be submitted.

## Cost, usage and the spend limits

The API reports token counts and no price. Every cost this tool shows is therefore an **estimate**,
worked out from the reported tokens at the published prices recorded in `DECISIONS.pricing`:

| Tokens | Price per million |
|---|---|
| Input, not cached | $0.10 |
| Input read from the cache | $0.01 |
| Input written to the cache | $0.125 |
| Output | not charged on this endpoint |

A request with more than 272,000 input tokens is counted at twice the price. The prices were
recorded on the date in `DECISIONS.pricing.verifiedOn`. If OpenAI changes them, change them there.

Every attempt, including each retry and each failure, is one line in
`data/runs/decisions-usage.jsonl`: when, which command, which stage, which job, the outcome, the
tokens, and the estimated cost. A line never holds the request, the reply, or the key.

**Unknown cost stays unknown.** A timeout, a server error or a reply with no usage may or may not
have been billed. Such an attempt is recorded with a cost of `null`, never zero, and with an upper
bound worked out from the size of the request. Reports show known estimates and unknown attempts
apart.

Two limits stop spending. Both count the estimate plus the bound of everything unknown, and both
are checked before every attempt, retries included:

| Setting | Default | What it does |
|---|---|---|
| `DECISIONS_RUN_CAP_USD` | 1.00 | The most one command may spend. A guard against a bug |
| `DECISIONS_BUDGET_USD` | none | The most all recorded calls together may cost. Set it under your prepaid balance |

When the next call could pass a limit, it is not sent. The run stops, says so, and the jobs it did
not get through go back to the queue as they were. The daily run has its own limit on top,
`decisionsBudgetUsd` in `data/policy.json`.

`npx job-search cost` prints the record: by stage (screening, mapping, follow-up, verification,
memory, inbox), per command run, what was spent rating postings you never applied to, retries and
failed attempts, and the estimate per completed application. It reads files and calls nothing.

**No benchmark.** Any figure for "applications per dollar" is a guess until you have run this on
real forms. After your first runs, `npx job-search cost` gives you measured numbers of your own.

## Cached answers

Ratings and form plans are cached on disk. Every cache key includes the backend, the model and the
request version (`decider.identity`), so an answer from one backend or model is never reused as if
another had given it. Raise `DECISIONS.requestVersion` when you change how questions are worded.

## Every question this tool asks

### Fit rating (`src/jobs/rate.ts`, one call per posting, stage `screening`)

Shared: your summary, skills, facts, graduation, citizenship and where you may work. Evidence: the
posting's company, title, locations, age, and description.

| Key | Type | Use |
|---|---|---|
| `is_software_role` | predicate | Skip below 0.5 |
| `level` | choice | "experienced" with support of 0.6 or more is a skip |
| `is_unpaid` | predicate | Skip above 0.7 |
| `needs_advanced_degree` | predicate | Skip above 0.7 |
| `work_auth` | choice | The two United States negatives are skips, unless your profile says you are authorized there |
| `term` | choice | A component of the score |
| `graduation_excluded` | predicate | Lowers the rank. Not a skip |
| `returning_student_required` | predicate | A note only |
| `stack_match`, `experience_match`, `callback_likelihood` | score | Components of the score |
| `location_tier` | choice | Used only when code cannot place the location |
| `interview_practical` | predicate | A small bonus |
| `needs_account` | predicate | Trusted only for a board code does not know, above 0.9 |
| `requires_references` | predicate | Skip above 0.85 |

Hard rules are skips, not low scores, so the queue threshold only trims weak matches.

### Form mapping (`src/forms/mapForm.ts`, one call per 40 fields, stages `mapping` and `follow_up`)

Shared: your flattened profile facts. Evidence: the page, the job's company and country, your work
authorization for that country as code resolved it, and the fields.

| Field kind | Question |
|---|---|
| Text, number, date, textarea | Choice: which profile value fills it, which draft intent it is, or "free text", "leave blank", "unknown" |
| Select, radio, combobox with options shown | Choice among the options, or "none of these" |
| Checkbox | Predicate: should it be ticked for this candidate? |
| File, email, phone, signature, interview slots | No question. Code decides |

### Page state (`src/forms/pageState.ts`, one call per navigation, stage `verification`)

Evidence: the address and the page's visible text, its start and its end.

| Key | Type |
|---|---|
| `state` | choice: job_description, application_form, submitted, login_required, captcha, closed, error, other |
| `has_apply_button`, `has_more_pages`, `requires_references`, `requires_cover_letter` | predicate |

### Answer memory (`src/answers/memory.ts`, stage `memory`) and inbox (`src/mail/status.ts`, stage `inbox`)

The memory asks whether a question on this form means the same as one the writer answered before.
The inbox asks what kind of reply an email is, from its subject and preview only, and only when
plain rules could not tell.

## What decisions are not used for

- Writing anything. Free text comes from the writer, from your profile and your voice guide.
- Reading screenshots. Pages are read as text or as a list of fields.
- Deciding what is true about you. That is your profile, read by code.
