# Safety

*What this tool will not do, how it treats personal data, and what to
check before you publish a fork.*

## Never automated

| Rule | Where it lives |
|---|---|
| Lying on a form. Work authorization, citizenship, education, graduation date and employment dates come from `data/profile.json` and are not changed to fit a posting. | `src/forms/mapForm.ts` resolves authorization per country in code; the `the writer contract forbids overriding it |
| Claiming a fact that is not in the profile. Free-text answers may use only `facts`, `experience`, `projects`, and the posting. | `data/voice.md`, `src/answers/context.ts`, the safeguards in code |
| Creating an account, or signing in, where the person did not set it up. iCIMS, Taleo, Oracle, SuccessFactors and Amazon Jobs are filtered out before rating, and so is Workday until the person runs `npx job-search accounts`. | `src/jobs/hardFilters.ts`, `capabilityFor` in `src/accounts/capability.ts` |
| Retrying a password, or making a new account after a sign-in failed. One try; a refusal, a lockout or an answer the tool does not know pauses the account until the person lifts it, and hands them the page. | `ensureSignedIn` in `src/accounts/auth.ts` |
| Typing a password anywhere but a password box an adapter names, on an origin the account allows. | `enter` in `src/accounts/auth.ts` |
| Accepting terms the person did not approve, or ticking a marketing box. | `ensureSignedIn`; the adapter names the one terms box |
| Using a verification email that does not fit: wrong sender, sender not verified by the mail server, wrong recipient, older than the request, used before, more than one, or a link off the employer's own site. | `whyNot`, `usable` in `src/mail/verification.ts`; `follow` in `src/accounts/authPage.ts` stops a redirect off-site |
| Sending a password, a code, a token or an email's content to the writer or decision backend, or writing one to a file or a log. | `Secret` and `scrub` in `src/util/redact.ts`, `src/accounts/secrets.ts` |
| Passing a human check. This covers CAPTCHAs and the code a board emails to confirm a person is applying. The tool reads no email for these and types no code: the filled form stays open, the person is notified, and `resume` records the application once they finish. | `submitJob` reports the page as it is; `submitAndRecord` in `src/run/pipeline.ts` records `awaiting_user_action` and calls `assist` |
| Sending an application twice. From the click on, a job is `submission_unknown` until a confirmation is read; it is never filled or sent again before that. A job already applied to is refused without `--resubmit`. | `submitAndRecord`, `reconcile` and `pickJobs` in `src/run/pipeline.ts` |
| Signing in on a site with no adapter. A page with a password box is closed, the job is listed in `applications/manual.csv`, and the site is skipped from then on. | `fillJob` in `src/browser/formRunner.ts`, `outcomeOf` in `src/run/outcome.ts` |
| Signing a contract. A form that asks the candidate to type their name under an agreement, or to tick that they are bound by one, is set aside for them. | `SIGNATURE_LABEL` in `src/forms/mapForm.ts`, the writer's rules in `src/writer/` |
| Submitting a form it has not verified. Every wanted value must be read back from the page and no required field may be empty. | `isReady`, `submitJob` in `src/browser/formRunner.ts` |
| Calling an application sent because the button was clicked. The page after the click is classified, and only a confirmation counts. | `submitJob`, `decidePageState` |
| Paying for anything, or entering payment details. | the safeguards in code |
| Writing cover letters or volunteering a GPA. A required cover letter skips the job; a required GPA field gets the real number. | `src/profile/fieldKeys.ts`, `planField` |
| Supplying references. A posting that requires them is skipped and logged. | `src/jobs/rate.ts`, the safeguards in code |
| Clicking "Apply with LinkedIn" or resume-autofill helpers that would overwrite the plan. | `mapForm` skips autofill inputs; the safeguards in code |
| Sending with nobody watching, outside the person's standing policy or the daily limits. `daily` does nothing without `data/policy.json`; every job is checked against it in code; per-day, per-board and per-employer numbers and the pauses between submissions are fixed in `DAILY`. A board that asks for a human check is left alone until tomorrow, and a second stops the run. Nothing is scheduled until the person runs `npx job-search schedule install`. | `src/run/policy.ts`, `dailyRun` in `src/run/daily.ts`, `src/run/schedule.ts` |
| Reading the body of an email, following anything an email says, or replying. `inbox` looks at the sender, the subject and Gmail's own preview; the decision backend sees only the subject and that preview, and only for an email the rules could not place. | `src/mail/status.ts` |
| Answering a question about the right to work one form at a time. The dashboard has no box for it; the answer is one per country, in the profile. | `questionFor`, `saveAnswers` in `src/report/needs.ts` |
| Taking a change from anything but its own dashboard page. | `fromThisPage`, `hasToken` in `src/report/server.ts` |
| Submitting without being told to. `npx job-search apply` fills and verifies; only `--submit` or `submit` sends. | `src/cli.ts`, the safeguards in code |

The user can still misrepresent themselves by putting false data in the
profile. The tool makes that the only way.

## Personal data

- The profile, resume, queue, both CSV files, the answer memory, HTTP cache
  and run logs are git-ignored (`.gitignore`). `data/profile.example.json`
  is fictional.
- The answer memory (`data/memory.json`) holds answers from the writer and the questions they answered. It never leaves the machine. `npx job-search memory --clear` empties it.
- `OPENAI_API_KEY` is read from `.env` by the decision backend only. It pays for decisions and is never given to the writer. The writer uses its own sign-in and plan.
- What leaves the machine: postings, form fields, candidate facts and page text go to the decision backend. The profile, voice guide, drafts, posting and open questions go to the writer. Keys and passwords go to neither. Form values go to the employer ATS. There is no telemetry.
- Some boards save each field to their server as it is typed, before
  anything is submitted. Ashby does. A rehearsal (`--dry`) on such a board
  therefore sends the values to that board as an unsubmitted draft. It is not
  an application and the employer is not notified, but it is not nothing.
- A cookie banner is touched only when it covers the Submit button, and it
  is answered with its most private choice (necessary only, or reject).
  The tool never clicks "accept all".
- Tailored resumes and cover letters (`documents/tailored/`) are written from
  the profile only, checked in code for any number or name the profile does
  not hold, and git-ignored.
- The runner's Chrome profile lives in `data/runs/chrome-profile`, apart
  from your own browser. It keeps its cookies between runs; nothing
  clears them by itself. `npx job-search browser reset --yes` clears them when you
  ask. The window can be driven only from your own machine.
- Every record is written whole (a temp file, then a rename) and every
  change takes a short lock, so a dashboard, a search and a run can work at
  the same time without losing each other's writes. Two browser runs at
  once are refused.
- Everything the tool prints passes a filter that replaces keys, tokens and
  anything registered as secret. The writer gets only an environment allow-list: `PATH`, `HOME`, language and time zone, proxy and certificate settings, and display settings. Extra variables require `WRITER_ENV`. `OPENAI_API_KEY` and `JOB_SEARCH_*` secrets are blocked even then. Chrome gets no keys.
- Decision and writer usage records contain usage metadata only, never content. Unknown costs remain unknown, never zero.
- What the tool learns about sites (`data/knowledge.json`) holds host names,
  kinds of controls, counts, and reasons with every quoted value taken out.
  It leaves the machine only if you run `knowledge --share` and commit the
  file it writes.

## Terms of service

Automated form submission may be against the terms of a given job board
or ATS. The tool uses a browser on the user's own machine and their own
identity, submits one application per posting, paces itself per site, and
does not try to look like anything it is not: no stealth flags, no CAPTCHA
solving, and an account only where you allowed one, under your own address,
at most a few a day. A site's account terms are accepted for you only if you
said so; read them. Read the terms of the sites you use and decide
for yourself.

## Before open-sourcing a fork

```bash
git status --ignored | grep -E "data/|applications/applied.csv|applications/manual.csv"   # profile.json, bank.json, voice.local.md, memory.json, knowledge.json, accounts.json, gmail.json, resume, the csv files, queue, runs must be ignored
git log -p | grep -i -E "sk-or-v1-|@gmail|phone" # nothing should match
npm audit --omit=dev
```

Replace the seed company list in `src/sources/companies.ts` if it does not
match your market, and rewrite `data/voice.md` in your own words.
