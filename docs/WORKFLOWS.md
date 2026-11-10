# Workflows

Use these commands from the project folder. A person can run them alone, or ask an agent to help read the output and make choices. You make the decisions about your facts, applications and consent. An agent does not need to be present.

For installation and configuration, see [Setup](SETUP.md). For the daily run and its standing policy, see [Daily](DAILY.md). For job-board accounts and sign-in, see [Accounts](ACCOUNTS.md).

## Profile

Use this when your contact details, experience, education, skills, work authorization or other candidate facts change. Edit `data/profile.json` by hand in a text editor. Keep the JSON valid and use the existing structure as a guide:

- `name`, `email`, `phone` and `location` are contact details.
- `summary`, `skills`, `experience` and `education` describe your background. Include only facts you can support.
- `workAuthorization` and related country or sponsorship facts affect which jobs and answers are allowed.
- Resume and preference fields tell the tool which document and constraints to use.

Do not invent a fact, infer a credential, or let an agent fill gaps with guesses. Review every change yourself, then validate it:

```sh
npx job-search doctor
```

Doctor checks the configuration and files offline, then prints what to do next. It does not make a paid call unless you explicitly add `--probe-decisions`. Decide yourself whether a proposed fact is accurate and whether it belongs in your profile. Editing the profile does not submit an application, create an account or sign in.

## Discover

Use this to find postings from configured sources, filter and rate them, and update the queue and record.

```sh
npx job-search discover
```

It prints a summary of the run. For a smaller run, use `--limit <n>`. To skip direct company board polling, use `--no-boards`. To choose the posting age window, use `--max-age <days>`; the default is 14. Use `--json` for a JSON summary.

Read the queue and any exclusions. Decide whether a posting is worth pursuing and correct your profile or preferences if the facts are wrong. Discover does not apply, submit, create accounts or sign in. See [Decisions](DECISIONS.md) for how ratings and refusals work.

## Apply

Use this to fill forms for queued jobs. Always rehearse first:

```sh
npx job-search apply --dry
```

The dry run prints progress and reports what it could fill or what needs your attention. It records nothing, sends nothing and closes its tabs. Read the report carefully. Decide whether each answer is true, whether the documents are suitable, and whether every open question is resolved.

When the rehearsal is acceptable, run the intended jobs without `--dry` to leave ready forms open for review:

```sh
npx job-search apply <id>
```

To send, explicitly add `--submit`:

```sh
npx job-search apply --submit <id>
```

Without ids, `--count <n>` takes that many jobs from the top of the queue (default 1). Supported options include `--tailor`, `--cover`, `--plain`, `--fresh`, `--resubmit` and `--json`; check `npx job-search apply --help` before using them. A form counts as sent only when the page after clicking is read as a confirmation with enough support. Otherwise it is **not confirmed**, and waits for `npx job-search reconcile`.

Ending statuses describe what happened:

- **applied**: a confirmation was read with enough support.
- **needs_review**: a person must review a form or field before continuing.
- **blocked**: the site requires a step that the tool cannot complete, such as a sign-in, code or robot check. Finish it yourself, then use `resume`.
- **failed**: the attempt could not finish. Read the reason; fix the cause or leave it queued.
- **queued**: it remains available to try later.
- **skipped**: the job was excluded. Review the reason before deciding whether to revisit it.
- **not confirmed**: the click did not produce enough evidence of a confirmation. Use `reconcile`; do not assume it was sent.

The tool never submits without `--submit` or a standing policy. No account is made and no sign-in happens without your recorded consent. Work authorization is derived from your profile in code, and every typed value is read back. You decide what to send. Writing comes from the configured writer, explained in [Writer](WRITER.md).

## Resume

Use this when a form was left open for you to finish a sign-in, emailed code or robot check. The command watches those forms; it does not type or click for you.

```sh
npx job-search resume
```

It prints each form's progress and records an application when a confirmation is seen. If you finished a form by hand and want to read its current page without clicking, use:

```sh
npx job-search check <id>
```

If Submit was clicked but no confirmation was seen, inspect and settle the tab with:

```sh
npx job-search reconcile <id>
```

Reconcile records applied or not sent when the page supports that result. If the evidence proves neither, the job stays unconfirmed for you to settle with `mark`:

```sh
npx job-search mark <id> --status needs_review --reason "Explain what you observed"
```

`mark` accepts `applied`, `skipped`, `failed`, `blocked`, `needs_review` or `queued`; use `--reason` and `--notes` to preserve the evidence. Decide what the page means and whether to record a manual outcome. `resume --submit` explicitly sends forms that become ready after your sign-in; use it only when you have decided to submit. The tool does not sign in or read mail here.

## Tailor

Use this to create a resume for specific jobs from your profile:

```sh
npx job-search tailor <id>
```

It prints progress and writes PDFs under `documents/tailored/`. Add `--cover` for a cover letter, `--fresh` to write again when documents exist, and `--open` to open each PDF. Review every document and decide whether it represents you accurately before using it. Claims are checked against your profile; when the writer cannot run, the run stops and unfinished work remains available. Tailoring does not apply or submit. See [Writer](WRITER.md) for the writer's input, billing and limits.

## Status

Use this for current totals and reasons jobs were skipped:

```sh
npx job-search status
```

It prints totals and skip reasons. Add `--json` for machine-readable output. Decide whether a status or reason needs follow-up. This command does not contact job boards, submit, create accounts, sign in or read mail.

## Inbox

Use this to check replies to applications when you have connected Gmail yourself:

```sh
npx job-search inbox
```

It reads connected Gmail read-only for the previous 7 days and records replies it can classify. Add `--days <n>` to change the window or `--json` for JSON output. Unclear messages wait for you in the dashboard. Decide what to do with uncertain replies. Mail is read only after you connect Gmail; the tool reads verification mail and reply subjects, not general mail. It never signs in or sends mail.

## Report

Use this to review the local record in a dashboard:

```sh
npx job-search report
```

It opens a local dashboard with totals, applications by day and board, and each row with its status. Add `--open` to open the page in your browser, `--port <n>` to choose the port, or `--static <file>` to write a self-contained snapshot and exit. Review rows and decide whether any status needs correction. The report does not submit, create accounts, sign in or read mail.

## If a run stops early

If the decision backend or writer cannot run, has no credit, reaches a spend limit, cannot start or has billing you did not accept, the run stops and unfinished jobs return to the queue. A form needing your action stays for you. Decision limits, confidence and refusals are described in [Decisions](DECISIONS.md). Writer setup, billing and failure behavior are described in [Writer](WRITER.md). Do not treat an unknown result as success. Read the report, decide what to correct, and resume or reconcile the job when ready.
