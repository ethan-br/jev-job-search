# The daily run

*A few applications a day with nobody watching: what you set first, the
limits it keeps, how to schedule it, and how to stop it.*

`npx job-search apply` works while you watch. `npx job-search daily` is for
the days you do not: it finds jobs, then fills and sends one application at
a time, and writes a summary. It is **off until you turn it on**. Nothing
runs until you have written your standing policy.

## 1. Write your standing policy

Copy the example, then edit `data/policy.json` to suit you:

```bash
cp data/policy.example.json data/policy.json
```

| Field | What it means | Default when empty or omitted |
|---|---|---|
| `target` | Applications a day. At most 25 | 15 |
| `where` | Where a job may be: `vancouver`, `canada`, `remote`, `us`, `international`, `unclear` | Any location the search kept |
| `levels` | `internship`, `new_grad` | Both |
| `minScore` | The lowest fit score a job may have, from 0 to 1 | The search threshold |
| `boards` | Job boards by name, such as `greenhouse`, `lever`, `ashby`, `workday` | Every board the tool fills |
| `excludeEmployers` | Employers the daily run never applies to. A name matches any company that contains it | None |
| `documents` | `tailor`: write a resume for each job. `cover`: write a cover letter where a form has a box for one | Both false |
| `decisionsBudgetUsd` | Maximum estimated decision cost for the day. The run stops when reached | $0.50 |

Example: `data/policy.example.json` shows the complete shape. This budget
limits decisions only. The writer has its own sign-in and plan; see
[`docs/DECISIONS.md`](DECISIONS.md) and [`docs/WRITER.md`](WRITER.md) for the
separate bills and settings. The decision spend is an estimate from reported
tokens, not a fixed price.

Every job is checked against this file in code before its form is opened.
A run reads the file once, when it starts. A change while it is working
applies from the next run. There is no pay filter: postings rarely state pay
in a way the tool can read, and it will not guess.

`data/policy.json` is git-ignored.

### Writing your policy

Answer these questions for yourself, then put the choices in
`data/policy.json`:

- How many applications a day? The default is 15; the maximum is 25.
- Where may jobs be? For example, Vancouver, the rest of Canada, remote, the
  United States, or elsewhere. Use the location values listed above.
- Which levels: internships, new-grad roles, or both?
- What fit score is too low for you? Check your queue with `npx job-search
  queue` to see the range before choosing a minimum.
- Are there employers you want to leave out?
- Should the tool tailor a resume for each job, and write a cover letter when
  the form has a box for one? This takes longer.
- How much may decisions cost in a day? The default is $0.50. The writer is
  billed separately on its own sign-in and plan. A ChatGPT subscription does
  not pay for API calls.

## 2. Rehearse

```bash
npx job-search daily --dry
```

This fills and checks forms, sends nothing, and records nothing. Read the
summary before relying on a real run. If your policy includes Workday, a
rehearsal still signs in for real ([`docs/ACCOUNTS.md`](ACCOUNTS.md)).

## 3. Run it

```bash
npx job-search daily
```

It searches for jobs, then applies until the daily target or a limit stops
it, and prints what it sent, what waits for you, and what it could not send.
The summary is also saved in `data/runs/daily-<date>.json`.

`--target 5`, `--max-attempts 10` and `--max-minutes 30` can tighten one
run. `--no-discover` uses the current queue without searching first.
`--stop` asks a run that is working to stop after its current application.

If the decision backend or writer cannot run at all, the run ends at once
and unfinished jobs go back in the queue. This includes a missing key, no
credit, a spend limit, a writer that cannot start, or billing the writer
does not accept. A writer timeout or invalid response leaves that job for
you and the run can continue, as described in [`docs/WRITER.md`](WRITER.md).

An application counts as sent only when the page after the click shows a
supported confirmation. Otherwise it is “not confirmed” and waits for
`npx job-search reconcile`.

## The limits it keeps

No rate is known to be safe on any job board. These limits are set to look
like one careful person. Do not raise them from the command line.

| Limit | Value |
|---|---|
| Applications a day | 15 by default, or your policy's number, never more than 25 |
| To one job board in a day | 8 |
| To one employer in a day | 1 |
| Forms open or unconfirmed with one employer | 2, then that employer is left alone |
| New employer accounts in a day | 3 ([`docs/ACCOUNTS.md`](ACCOUNTS.md)) |
| Between applications to one board | 3 to 6 minutes, chosen at random |
| A board that asks for a human check or says “too many requests” | Left alone until tomorrow |
| Boards asking for a human check in one run | The run stops after 2 |
| Jobs one run opens | 30 |
| Longest run | 90 minutes |
| Decision spend in a day | $0.50 by default, or your policy's `decisionsBudgetUsd` |

They are in `DAILY` in `src/config.ts`. Decision costs from the new backend
have not been measured yet. `npx job-search cost` shows your own figures
after your first runs.

## What it leaves for you

The daily run does not pass a human check or finish a sign-in that needs
you. Such a form stays open in the tool's window, you get a notification,
and the run goes on with another board. When you return, use
`npx job-search resume`. The summary lists these under “Waiting for you”.
Forms left open longer than 12 hours are closed and put on your by-hand
list.

## Schedule it

On macOS, install the daily schedule at 09:00 by default, or choose a time:

```bash
npx job-search schedule install
npx job-search schedule install --at 09:00
```

Use `npx job-search schedule status` to check it and
`npx job-search schedule remove` to remove it. The macOS LaunchAgent runs
`daily` in this folder and writes output to `data/runs/daily.log`. Your Mac
must be on and you must be signed in. The tool's Chrome window opens on your
screen while it works. The schedule holds no key or password.

On Linux, scheduling is not built in. Use cron or a systemd user timer as
described in [`docs/PLATFORMS.md`](PLATFORMS.md). The daily run needs your
desktop session because Chrome opens a window. The writer must already be
signed in, since nobody is there to sign in. Remove any other scheduling
product for this same daily run so you do not start duplicate runs.

## Pause it, stop it, turn it off

- **Pause future runs:** On macOS, run `npx job-search schedule remove`.
  On Linux, disable your cron entry or systemd timer as shown in
  [`docs/PLATFORMS.md`](PLATFORMS.md). A run already working carries on.
- **Stop the current run:** run `npx job-search daily --stop`. It finishes
  the application it is on and opens no other.
- **Turn it off:** remove the schedule and delete `data/policy.json`. Without
  that file, `daily` refuses to run.
