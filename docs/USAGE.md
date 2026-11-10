# Using job-search day to day

What the tool handles, what it leaves to you, where your records are, and
how it learns. The README has the short version; this is the long one.

## How `npx job-search apply` works, step by step

Follow [docs/SETUP.md](SETUP.md) the first time. `npx job-search doctor`
reports the next step. Find jobs, then rehearse before sending anything.

1. **Find jobs.** The tool reads its sources, filters and rates postings, and
   saves a ranked queue.

   ```bash
   npx job-search discover
   ```

2. **Rehearse.** This fills forms without sending or recording applications,
   then closes the tabs. Read the fill reports and correct your profile or
   answers before a real run.

   ```bash
   npx job-search apply --dry --count 5
   ```

3. **Fill forms.** Without `--submit`, ready forms are left open for you to
   review. To send forms that are ready, add `--submit`.

   ```bash
   npx job-search apply --count 5
   npx job-search apply --count 5 --submit
   ```

   You can also pass job ids or posting links. Stay near your computer while
   it runs. You may need to handle a code, sign-in or robot check yourself.

4. **Check the result.** A form counts as sent only when the page after the
   click is read as a confirmation with enough support. If the result cannot
   be confirmed, it remains unconfirmed for `npx job-search reconcile`.

### Codes and checks that are yours

The tool does not read a code from mail, type it, or pass a robot check. The
form stays open for you. After you finish the check, use
`npx job-search resume` to let the tool read the page and record a confirmed
application.

### A click with no confirmation

If the page after Submit does not prove that the application was sent, the
tool records it as not confirmed and does not fill or send it again by
itself. Use `npx job-search reconcile` to read the page again. If it still
proves neither outcome, settle it yourself in the dashboard or with
`npx job-search mark <id>`.

## What the tool handles

### Where it finds jobs

The tool reads configured public lists, company boards and CSV files in
`data/imports/`. The current sources are listed in
[`docs/SOURCES.md`](SOURCES.md). To add a list or a company, see that guide.

### Which jobs it keeps

The tool applies code-based filters first, then asks the decision backend to
rate the remaining postings using the posting and your candidate facts. It
uses the answers to rank the queue. A graduation date mismatch can lower a
rank without removing a job. See [docs/DECISIONS.md](DECISIONS.md) for the
questions, thresholds and refusal behavior.

### Which job boards it can fill

Support depends on the site and its form. The tool reads the page, maps its
fields, fills what it can support, and reads every typed value back. Rehearse
with `--dry` and inspect the reports before relying on a board. If a form
cannot be read or safely filled, it is left for you.

#### How it paces itself

The tool follows its configured limits for submissions and per-employer
spacing. See the tunable values in `src/config.ts`.

### Which parts of a form it fills

- text boxes, long answers and supported choice controls
- dates and contact details from your profile
- resume files from your profile, or a tailored resume when requested
- questions that appear after another answer, by reading the page again
- required answers only when it has a supported value

Every value typed into a form is read back. Work authorization comes from
your profile and code. Nothing is submitted without `--submit` or a standing
policy.

### Which questions it answers

| Kind of question | Where the answer comes from |
|---|---|
| Your name, contact details, address and links | Your profile |
| School, degree, field of study and dates | Your profile |
| Work history | Your profile |
| Work authorization and sponsorship | Your profile, resolved by code for the job's country |
| Personal demographic details | Your profile, if you chose to provide them |
| Open questions asking for written answers | The writer you configured, using your facts, drafts, voice guide and the posting; see [docs/WRITER.md](WRITER.md) |

### What it leaves to you

The tool does not submit a form and leaves it for you when it cannot safely
answer a required question, the form asks you to sign or agree to a contract,
an interview time must be chosen, or the site needs an unsupported sign-in
or verification step. No account is made and no sign-in happens without your
recorded consent. A failed decision backend or writer run stops the run, and
unfinished jobs return to the queue.

## Find your applications

Application records and fill reports are kept under `data/` on your
computer. Use `npx job-search log` and `npx job-search report` to view your
records. `npx job-search survey` totals answers landed and what did not across
fill reports.

### Jobs left for you

Jobs the tool could not complete remain available for you to review in your
records and dashboard.

### Every job considered

The job records include postings the tool considered and their outcomes.
`npx job-search status` shows totals and skip reasons.

## How well it works

Nothing is measured on the new backend yet. To measure your own runs, rehearse
with `npx job-search apply --dry`, read the fill reports, then review
`npx job-search survey` and `npx job-search cost`. The cost command estimates
decisions from reported tokens and shows the writer's reported usage apart.

## How the tool learns

The tool does not train a model. It keeps notes and cached answers on your
machine.

| What it keeps | Where | What it is for |
|---|---|---|
| Site notes | `knowledge/sites.json` and local data | How site controls behave |
| Answer memory | `data/memory.json` | Reuse prior writing for the same question |
| Decision cache | `data/cache/` | Reuse posting ratings and form mappings |

Site notes record how controls behaved, whether a sign-in was needed, page
counts and controls that could not be set. They do not include your answers
or names. Share notes only when you choose to.

## Where your information goes

- Posting text, form fields and your candidate facts go to the decision
  backend for judgements. See [docs/DECISIONS.md](DECISIONS.md).
- Your profile, voice guide, drafts and the posting go to the writer you
  configured when it writes. See [docs/WRITER.md](WRITER.md).
- Your answers go to the employer's job board when you submit.
- Mail is read only after you connect Gmail, and only for verification mail
  and reply subjects.
- Nothing else leaves your machine. Secrets are not sent to either service.

Decisions and writing have separate bills. `OPENAI_API_KEY` pays for
decisions only; the writer uses its own sign-in and plan. A ChatGPT
subscription does not cover API calls. `npx job-search cost` reports
decisions estimated by stage, per run and per completed application, and
writer-reported usage separately. Unknown costs stay unknown. See the
spending limits in [docs/DECISIONS.md](DECISIONS.md) and writer billing in
[docs/WRITER.md](WRITER.md).

Some job boards save answers as you type. A rehearsal can leave an unsent
draft on that board; it is not an application.

## What is planned

Check the project issue tracker for current plans. LinkedIn is not planned:
its terms forbid automation.
