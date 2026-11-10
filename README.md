# job-search

*A job search tool that fills application forms for you.*

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An open-source command-line tool that finds software jobs, rates them with a decision backend, and fills application forms in a Chrome window you can watch. Decisions come from the backend; all writing comes from the writer you configure. The tool reads every value back from the page before a form is ready to send.

| | |
|---|---|
| **Who it is for** | Students and new graduates applying to software roles in Canada, the United States or remotely. It writes in English. |
| **What you need** | Node.js 22 or newer, Google Chrome or Chromium, an OpenAI API key for decisions, and a writer command with its own sign-in. |
| **What it costs** | Two separate bills: OpenAI API usage for decisions, and the writer's own sign-in and plan for writing. See [costs](#costs). |
| **What it checks** | Your work authorization, education and dates come from your profile. Every typed value is read back. Forms that need your input stay open for you. |
| **What it is not** | A download-and-open app. It is a local command-line tool and dashboard. New or unsupported forms may need your review. |

## What this is

The decision backend handles small, typed judgements: which profile value belongs in a field, which listed option fits, whether a posting meets a rule, and what a page shows after submission. The writer you configure writes open form answers, tracking notes, tailored resumes and cover letters. Code handles the browser, checks, records and rules about what may be submitted. The backend and writer are separate programs with separate billing. See [Decisions](docs/DECISIONS.md) and [the writer](docs/WRITER.md).

Four safeguards are built into the code. Work authorization, education and dates come from your profile and are not changed to fit a form; a required question the profile cannot answer holds the form. Every value is read back from the page. Nothing is submitted without `--submit` or a standing policy. A sign-in or account creation happens only with your recorded consent. What the tool cannot finish is left for you with a reason.

## Prerequisites

- [Node.js](https://nodejs.org) 22 or newer.
- Google Chrome or Chromium. The tool opens its own Chrome window and profile; your everyday browser is not touched. If Chrome is in a different location, set `CHROME_PATH` in `.env`.
- An `OPENAI_API_KEY` for decisions. This pays for decisions only and is never passed to the writer.
- A writer command configured in `WRITER_COMMAND`. It uses its own sign-in and plan. See [the writer](docs/WRITER.md).
- A desktop session for real runs. The tool drives a Chrome window you can watch. PDF printing alone is headless.

The project has been tested on Ubuntu. macOS-only and Linux-only features are described in [platform notes](docs/PLATFORMS.md); Windows is not tested.

## Quick start

### 1. Install

```bash
git clone https://github.com/ethan-br/jev-job-search
cd jev-job-search
npm install
```

### 2. Configure your keys and writer

Copy `.env.example` to `.env`. Set `OPENAI_API_KEY` and `WRITER_COMMAND` yourself by editing `.env`. Never paste a key into a chat or an agent. The API key pays only for decisions; your writer uses its own sign-in and plan. A mock writer is available for a rehearsal without writing real answers. Details are in [setup](docs/SETUP.md) and [the writer guide](docs/WRITER.md).

```bash
npx job-search doctor
```

This check is offline and free. It tells you what is missing and the next step. The optional `--probe-decisions` makes a paid call; `--probe-writer` asks the writer once.

### 3. Write your profile

Follow [docs/SETUP.md](docs/SETUP.md) to add your resume and write `data/profile.json`, drafts and your voice guide. The tool can only give truthful answers when your profile is accurate and complete.

### 4. Find jobs

```bash
npx job-search discover
```

This reads public lists and company boards, filters postings against your profile, rates the rest and writes a ranked queue. A posting that has not changed is not rated again.

### 5. Rehearse, then submit

```bash
npx job-search apply --dry --count 3
npx job-search apply --submit
```

The dry run fills and checks up to three forms, records nothing and sends nothing. Read its reports and correct your profile or settings as needed. The submit command sends forms only when ready. Without `--submit`, ready forms stay open in Chrome for your review. To fill a posting you found yourself, pass its URL or ID to `npx job-search apply <url>`; `--submit` is still required to send it.

An application counts as sent only when the page after the click is read as a confirmation with enough support. Otherwise it is recorded as **not confirmed** and waits for `npx job-search reconcile`.

## Commands

Run every command from the project folder as `npx job-search <command>`. `npx job-search --help` lists them all, and `--help` after a command lists its options. `discover` and `apply` are the workflow. The rest extend it once your profile is in place:

- **`npx job-search tailor <job id> [--cover]`** writes a one-page resume for the job from your profile and the posting, and with `--cover` a one-page cover letter, and prints where the PDFs are (`--open` opens them). Every number and every name of a tool, a place or a company in the draft is checked against your profile in code. The keywords the posting wants and your profile cannot support are listed, never stuffed in. `npx job-search apply --tailor --cover` writes and attaches them as it applies. See [A resume and a cover letter written for the job](#a-resume-and-a-cover-letter-written-for-the-job).
- **`npx job-search report --open`** opens the dashboard on your own machine. **Today** is the day in one line. **Needs you** lists everything only you can do: a question a form asked that your profile could not answer, with a box and "Save for next run"; a form waiting for a code or a sign-in; a submission that was never confirmed. **Applications** is every job with its status, your notes and the reply that came back. **Automation** is the daily run and your rules. Nothing leaves your machine.
- **`npx job-search inbox`** (in progress) reads your connected Gmail, read-only, for replies to applications you sent: received, rejected, an assessment, an interview, an offer. It looks at the sender, the subject and Gmail's own short preview, never the body. What it is not sure of waits for you under "Needs you".
- **`npx job-search accounts`** (in progress) lets the tool apply on Workday, where every employer wants its own account. The simple way: `npx job-search accounts signin <employer>` opens that employer's page, you sign in once yourself, and the tool keeps the session. Off until you turn it on. See [Jobs that want an account](#jobs-that-want-an-account).
- **`npx job-search daily`** is the daily run: a few applications a day with nobody watching, inside a standing policy you write (how many, where, which employers never) and limits meant to look like one careful person. `npx job-search daily --dry` rehearses it and `npx job-search daily --stop` asks a run that is working to stop after the application it is on. It does nothing until `data/policy.json` exists. See [docs/DAILY.md](docs/DAILY.md).
- **`npx job-search resume`** picks up the forms that wait for you. A board that emails a code, shows a robot check or needs a sign-in only you can finish leaves its form open in the tool's window. You do that one thing there, run `npx job-search resume`, and the application is recorded. **`npx job-search reconcile`** settles a form whose Submit was clicked with no confirmation seen, which is never sent twice.
- **`npx job-search status`** says where you stand in a few lines: sent today and in total, what waits for you, what is left for you and why, how fresh the queue is, and the next step.
- **`npx job-search cost`** prints what decisions have cost, as an estimate, and what the writer reported, apart. **`npx job-search doctor`** checks the setup offline.
- **`npx job-search log --open`** opens your applications in your spreadsheet program. **`npx job-search knowledge --share`** copies what your runs learned about job sites into the repo for a pull request (site names and kinds of controls, nothing about you). **`npx job-search memory`** shows what answers the tool remembers.
- The apply loop one step at a time, for when you want to look inside it: `fill`, `resolve`, `submit`, `check`, `inspect`, `set`.

Step by step instructions for each everyday job are in [docs/WORKFLOWS.md](docs/WORKFLOWS.md). Your profile, your standing answers, your drafts and your voice guide are files you edit yourself: [docs/WORKFLOWS.md](docs/WORKFLOWS.md) says how.

## File structure

```
job-search/
├── AGENTS.md                  # Rules for anyone, person or coding agent, who changes the code
├── .env.example               # Every setting. Copy it to .env (git-ignored) and fill that in yourself
├── applications/              # Your records (git-ignored)
│   ├── applied.csv            #   what was sent, newest first
│   ├── manual.csv             #   what the tool left for you, with the reason and the link
│   ├── takehome.csv           #   take-home assignments to do
│   └── all.csv                #   every job considered
├── documents/                 # Your files (git-ignored)
│   ├── resume.pdf             #   the resume you send
│   ├── transcript.pdf         #   for forms that ask for one
│   └── tailored/              #   <Company>_<Role>_<id>/ resume.pdf, cover.pdf, resume.md
├── data/                      # Your profile and the tool's working files (git-ignored, examples tracked)
│   ├── accounts.json          #   the job-board accounts you allowed (no password in it)
│   ├── policy.json            #   your standing instructions for the daily run
│   ├── profile.json           #   who you are; standing answers to recurring questions
│   ├── bank.json              #   your starting drafts for common open questions
│   ├── voice.local.md         #   how you write
│   └── queue.json, cache/, runs/   # the queue, cached answers, reports and the two usage records
├── knowledge/sites.json       # What runs have learned about job sites, shared through the repo
├── examples/writers/          # Writer wrappers, outside the core: the mock writer and the Codex CLI wrapper
├── src/
│   ├── cli.ts                 # every command
│   ├── config.ts              # every tunable number, in one place
│   ├── settings.ts            # what .env says about decisions and about the writer, read apart and checked
│   ├── decisions/             # typed questions and answers, the one backend client, the usage record
│   ├── writer/                # the writer contract, the external-command adapter, the billing gate
│   ├── run/                   # the apply loop and the daily run
│   ├── browser/               # Chrome over the DevTools protocol, no browser library
│   ├── forms/                 # reading and filling pages; three scripts that run in the page
│   ├── answers/               # what goes to the writer, the answer memory, drafts, voice
│   ├── documents/             # tailored resumes and cover letters
│   ├── jobs/, sources/        # finding and rating
│   └── knowledge/, log/       # site notes; the CSV records and the cost report
├── tests/                     # offline, on captured fixtures with no personal data
├── docs/                      # SETUP, USAGE, WORKFLOWS, ARCHITECTURE, DECISIONS, WRITER, PLATFORMS, and more
└── .github/workflows/         # CI: typecheck, tests, audit, CodeQL, a guard against personal data
```

## How `apply` works

Each job goes through the same loop on its own, and its result is printed the moment it is known:

1. **Open** the form in its own Chrome tab and read every control on the page: labels, options, which are required, which file box wants which file.
2. **Map** the page with one decision call: which of your details goes in each box, which option is true for you, which boxes stay empty. A form that has not changed keeps its mapping.
3. **Fill** with real input events, one control at a time on boards that save as you type. Dropdowns are opened and clicked; calendars are turned to the month and the day is clicked; the resume goes in the resume box and nowhere else.
4. **Write** what is left. Open questions, and the fields the decision backend was unsure of or declined, go to the writer with your facts, your drafts and your voice guide. Answers are remembered, so a form you rehearsed is not written twice.
5. **Read back** every value from the page. A box that shows something other than what it was given fails the fill and holds the form; an optional box the site refused is reported as left blank.
6. **Walk** to the next page when the form has one, and repeat.
7. **Send**, only when every wanted value is on the page and no required box is empty, and only when you asked. The page after the click must be read as a confirmation, with enough support, before the application counts.
8. **Record** the application in `applications/applied.csv`, with one sentence on what the company does and one on why you fit. What the tool could not finish is in `manual.csv` with the reason.

### What makes this workflow different

- **Decisions and sentences are split.** The decision backend makes every fixed-answer choice and returns probabilities, not text. The writer writes only the sentences. A form with no open question never calls the writer at all.
- **Nothing is trusted until it is read back.** Every value is read from the page after it is written. A wrong dropdown pick, a date a masked box mangled, or a value a site quietly dropped is caught before Submit, not after.
- **What goes on a form comes from your profile.** Work authorization is worked out in code, per country, from what your profile says; dates and education are copied from it; a written answer that names a number, a tool or a company your profile does not is refused. A signature, an NDA and a human check stop the form for you. The profile is the one place the truth can go wrong, and it is yours.
- **It learns per site.** How each board's controls take values, which sites want a sign-in, which email codes, is recorded after every form and read before the next, and shared through the repo.
- **Every record is a plain CSV** with fixed column names, at the top of the project, so you and your scripts can read it.

The longer version, with what it handles and what it leaves to you, is in [docs/USAGE.md](docs/USAGE.md).

## A resume and a cover letter written for the job

Off by default: your applications carry the resume file in your profile. Turn it on and the tool has the writer write a one-page resume for each job from your profile and the posting, and attaches that one instead.

```bash
npx job-search tailor <job id> --cover --open
npx job-search apply --count 10 --submit --tailor --cover
```

- `tailor` writes the documents for a job and shows you the PDFs. `apply --tailor` writes one per job as it goes. `apply --cover` also writes a cover letter wherever a form has a box for one, and uploads it or pastes it. Set `coverLetter` to `"when_asked"` in your profile to make that the default.
- The resume is built from your own bullets, reordered and cut for the posting, with the posting's keywords used where your profile has the same thing. The cover letter names one specific thing from the posting and ties two or three of your facts to it.
- **Nothing is invented.** Every number and every name of a tool, a place or a company in the draft is checked against your profile in code. A draft that claims something your profile does not say is sent back once with the claims named, and refused if it still does. The keywords the posting wants and your profile cannot support are listed for you, not stuffed in.
- The PDFs are rendered by the tool's own Chrome, so there is nothing to install. They live in `documents/tailored/<Company>_<Role>_<job id>/` with the resume as Markdown next to it, git-ignored.
- Documents are kept per writer: change the writer, and they are written again instead of reused.

The method follows the drafter and verifier workflow of [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (MIT), redone here in code against the profile instead of as a prompt.

## Customization

Everything about you is in data files, not in the code.

### Which files to edit manually

| File | What to change |
|---|---|
| `data/profile.json` | Your details, education, experience, projects, skills, work authorization, and `answers`: how recurring questions are answered (relocation, text messages, notice period, pay, agreements). The decision backend and the writer both follow this list |
| `data/bank.json` | Your starting draft for each common open question ("Why this company?", "Tell us about a project") |
| `data/voice.local.md` | How you write, so the answers read as yours |
| `documents/resume.pdf` | The resume the tool sends when you do not tailor one |
| `.env` | Your OpenAI API key for decisions, the decision spend limits, the writer command, and the ways of paying you accept from the writer |
| `src/config.ts` | Every tunable number in one place: the job lists, the scoring and where ranks highest, the thresholds, how many forms run at once, how fast the tool works on each site, the resume and cover letter page limits |

### Where the jobs come from, and adding a board

Jobs come from public lists on GitHub (the SimplifyJobs internship and new-grad lists among them) and from the company boards those lists point at, read through the boards' own APIs for Greenhouse, Lever and Ashby. Workday postings are read from Workday's own posting data and are kept once you allow accounts with `npx job-search accounts`; until then they are filtered out. iCIMS, Taleo, Oracle and the other boards that want an account are filtered out, and a site found behind a sign-in during a run is remembered and skipped. [docs/SOURCES.md](docs/SOURCES.md) describes each source and how to add one, and `data/imports/` takes a CSV of your own.

### Jobs that want an account

> **In progress, and not re-tested in this fork.** Two parts of the tool are off by default: applying on boards that want an account (Workday, with `npx job-search accounts`), and the Google connection (Gmail, for verification emails and for `npx job-search inbox`). Upstream reported one real Workday application taken from the sign-in to a confirmed submission, and no run of the Gmail connection against a real mailbox. Neither was run again after the decision backend and the writer were replaced. Until this note is gone, use the tool on the boards that need no account: Greenhouse, Lever, Ashby and the others listed in [docs/SOURCES.md](docs/SOURCES.md).

Every employer on Workday keeps its own accounts. The tool skips them until you set an employer up, and there are three ways, from the simplest:

```bash
npx job-search accounts signin acme
```

1. **You sign in once.** That employer's page opens in the tool's Chrome window and you sign in yourself, however it asks. The tool keeps the session and fills that employer's forms from then on. Nothing else is stored.
2. **It signs in for you.** On macOS, `npx job-search accounts password acme` opens a window for that employer's password, which goes into your Keychain. On Linux the password goes in `.env` (see [docs/PLATFORMS.md](docs/PLATFORMS.md)). The tool signs in when the session has ended. A password an employer refuses is never tried twice.
3. **It makes accounts (experimental).** `npx job-search accounts add workday` asks whether the tool may make an account where you have none, accept the account terms, and read the verification email, and shows what that allows before it saves. A rehearsal never makes one.

A robot check, a phone code, a passkey and single sign-on stop the job with the page left open for you; `npx job-search resume` carries on once you are through. `npx job-search accounts off` stops every sign-in, and `npx job-search accounts forget all` removes the stored passwords and sessions from your machine. Neither deletes an account at an employer. The password is never sent to the decision backend or to the writer. [docs/ACCOUNTS.md](docs/ACCOUNTS.md) has every step, the Gmail connection, and what has and has not been tested.

### Which jobs it keeps

The filters and the scoring are in `src/config.ts`: early-career titles only, the countries you may work in, how much a Vancouver, Canadian, remote or US posting is worth to you, and how old a posting may be (`npx job-search discover --max-age 30`). A posting that prefers another graduation date is ranked lower, not dropped: whether to apply is your decision.

### Custom resume and cover letter templates

The stock resume and cover letter are plain HTML with system fonts, printed to PDF by Chrome. To use your own design, make a folder with a `resume.html` and, if you want letters, a `cover.html`, written with these placeholders:

| Placeholder | What it prints |
|---|---|
| `{{name}}`, `{{headline}}`, `{{contact}}`, `{{summary}}`, `{{skills}}` | Your name, the role in the posting's words, your contact line, the summary written for the job, the skills joined with dots (`{{#skillList}}{{.}}{{/skillList}}` for one at a time) |
| `{{#experience}} ... {{/experience}}` | One block per job, with `{{title}}`, `{{company}}`, `{{location}}`, `{{when}}` and `{{#bullets}}{{.}}{{/bullets}}` inside |
| `{{#projects}} ... {{/projects}}` | The same, with `{{name}}`, `{{role}}`, `{{link}}`, `{{when}}`, `{{#bullets}}` |
| `{{#education}} ... {{/education}}` | `{{degree}}`, `{{field}}`, `{{minor}}`, `{{school}}`, `{{when}}` |
| Cover letter: `{{date}}`, `{{company}}`, `{{role}}`, `{{greeting}}`, `{{#paragraphs}}{{.}}{{/paragraphs}}`, `{{closing}}` | |

Then register it. The tool checks every placeholder, prints a test pair from the example profile, and refuses a template that does not render or runs long:

```bash
npx job-search templates --add ~/my-template --name mine
npx job-search templates --use mine
```

`npx job-search templates` lists what is registered and which one `npx job-search tailor` uses. The stock pair is in `src/documents/templates/default/`, the easiest starting point to copy.

### What the tool will not do

- **It will not change your facts to suit a job.** Your right to work, your education and your dates come from your profile, and code checks the answer picked for a right-to-work question against it. If the profile is wrong, the forms are wrong: that part is yours.
- **It will not add facts of its own.** The writer is given only your profile and the posting, and a tailored resume or letter is checked for numbers and names your profile does not hold. A sentence can still be worded badly; rehearse and read.
- **It will not send a form it has not checked.** Every answer must be confirmed on the page first.
- **It will not send anything unless you ask.** Sending needs `--submit`, the `submit` command, or the standing policy of the daily run.
- **It will not count an application as sent on a guess.** A page that is not clearly a confirmation leaves the application "not confirmed" for you to settle.
- **It will not sign for you.** If a form asks you to type your name to agree to a contract, the tool leaves it for you.
- **It will not choose a date for you.** If a form asks you to pick an interview or test slot, the tool leaves it for you.
- **It will not sign in or create an account unless you set that up.** Without `npx job-search accounts`, a job behind a sign-in goes on your by-hand list. With it, the tool signs in on Workday only, never retries a refused password, never makes an account in a rehearsal, and never ticks a marketing box.
- **It will not pass a "prove you are human" test for you.** That covers picture puzzles and the codes a board emails you because it suspects a robot.
- **It will not read your email** unless you connect Gmail yourself, read-only. Then it looks for two things: the email an employer sends to prove your address when an account is made, and, for `npx job-search inbox`, the sender, subject and preview of replies to your applications.
- **It will not make up references.** A job that requires them is skipped.
- **It will not write a cover letter unless you asked for one**, with `--cover` or in your profile. Without that, a job that requires one is skipped. A letter it does write is checked against your profile like the resume.
- **It will not give your GPA** unless the form cannot be sent without it, or you chose to always give it.
- **It will not pay for writing behind your back.** When the writer fails, nothing else writes in its place, and a writer that is paid in a way you did not accept is refused.
- **It will not keep going when the setup is broken.** No key, no credit, a spend limit, a writer that will not start, or billing you did not accept stops the run, and the jobs it did not get through go back to the queue.

[docs/SAFETY.md](docs/SAFETY.md) has the full list and shows where each rule lives in the code.

### Starting over

Delete `data/profile.json`, `data/bank.json` and `data/voice.local.md` and follow [docs/SETUP.md](docs/SETUP.md) again. `npx job-search memory --clear` forgets the remembered answers; `applications/` and `documents/` are yours to keep or remove.

## Costs

There are two separate bills. `OPENAI_API_KEY` pays for decisions only. The writer runs on its own sign-in and plan. A ChatGPT subscription does not cover OpenAI API calls. The tool never switches between these bills and never falls back to a paid API for writing.

Decision costs are estimates from reported tokens, at $0.10 per million uncached input tokens; cached and cache-write prices are also used where applicable. Unknown costs remain unknown, never zero. The run cap `DECISIONS_RUN_CAP_USD` defaults to $1.00 per command; `DECISIONS_BUDGET_USD` has no default. The daily policy has its own `decisionsBudgetUsd` limit. Limits include bounds for unknown attempts and are checked before every call, including retries.

`npx job-search cost` reports decisions by stage, per run and per completed application, and reports writer usage separately. Writer costs are reported only when the writer provides them; the tool does not estimate them. No performance or cost figures have been measured with this backend. After your first runs, `npx job-search cost` shows your own figures.

### How the tool keeps the cost down

- **It remembers answers.** Every answer the writer writes is kept on your computer. When you rehearse a form and then send it, the tool reuses the answers you read in the rehearsal and does not ask the writer again.
- **It reuses an answer on another company's form only when that is safe.** The writer marks an answer as reusable only if it would be true for any company. The decision backend then checks that the new question asks for the same thing. Most open questions name the company, so expect this to save a little, not a lot.
- **It forgets when you change your profile or your writer.** A remembered answer is used only while your profile, your drafts, your voice guide and the configured writer are unchanged. A corrected fact is never overruled by an old answer.
- **It does not ask the decision backend the same thing twice.** A posting that has not changed keeps its rating from the last search, and a form that has not changed keeps its field mapping.
- **It sends your facts in a way the backend can cache.** What is the same for every decision call goes first in the request, marked as cacheable, so repeats are charged at the cached price when the backend reports them as cached.
- **It stops before it overspends.** The limits are checked before every decision call, retries included.

How much each of these saves has not been measured on the new backend. To see or clear what the tool remembers, run `npx job-search memory`.

> This is an independent open-source project. It is not affiliated with, endorsed by or maintained by OpenAI, the maker of any writer you configure, or any job board. There is no token, coin or paid tier.

## Platform notes

Ubuntu is tested. macOS Keychain storage, its password dialog and `schedule install` are macOS-only. On Linux, set `JOB_SEARCH_ACCOUNTS_PASSWORD` in `.env` when needed and use cron or a systemd timer for scheduling. On Linux `.env` contains that password in plain text, so keep the file private. See [docs/PLATFORMS.md](docs/PLATFORMS.md) for details. Windows is not tested.

## Tips

- **Profile depth matters.** The writer may use only what your profile says. Add supported details and numbers to your profile after each project, course or job.
- **Keep standing answers current.** Add answers to recurring questions to your profile so they can be checked and reused.
- **Rehearse after a change.** Run `npx job-search apply --dry` and read the fill reports after changing your profile or settings.
- **Stay near your computer for early runs.** Boards may ask for a code or human check. The tool leaves the form open; complete it yourself, then run `npx job-search resume`.

## Documents

- [Setup](docs/SETUP.md)
- [Decisions](docs/DECISIONS.md)
- [Writer](docs/WRITER.md)
- [Platforms](docs/PLATFORMS.md)
- [Workflows](docs/WORKFLOWS.md)
- [Daily runs](docs/DAILY.md)
- [Accounts](docs/ACCOUNTS.md)
- [Safety](docs/SAFETY.md)
- [Sources](docs/SOURCES.md)
- [Usage](docs/USAGE.md)
- [Contributing](CONTRIBUTING.md)
- [Contributor instructions](AGENTS.md)

## Origin

This is a fork of [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search), MIT licensed, with the decision backend and the writer replaced.

## Acknowledgements

- [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (MIT) for the drafter and reviewer method behind tailored resumes and cover letters.
- [SimplifyJobs](https://github.com/SimplifyJobs) for public internship and new-graduate lists the tool reads.

## License

MIT. See [LICENSE](LICENSE).
