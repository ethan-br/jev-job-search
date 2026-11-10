# Setup

Set up the command line tool on Ubuntu or macOS. Windows is not tested. Ubuntu 26.04 with Node 24 and Google Chrome was tested. The macOS features listed in [PLATFORMS.md](PLATFORMS.md) have not been re-tested in this fork.

## 1. Install the tools

Install Node.js 22 or newer, Google Chrome, and Git. On Ubuntu, use the Google Chrome `.deb` package; Chromium from snap or flatpak may not be able to use the browser profile. On macOS, install Google Chrome in the usual Applications location. You need a desktop session for real runs.

Clone this repository and open a terminal in its folder. Install its dependencies:

```sh
npm install
```

After each setup step, run `npx job-search doctor`. It is offline and free. It names missing or contradictory settings and tells you the next step. A setting in your shell wins over `.env`. A wrong or contradictory setting is an error doctor names, never a silent default.

## 2. Configure decisions

Copy `.env.example` to `.env` using your system's file manager or terminal. Open `.env` in a text editor. Create your own OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys), and type it into the `OPENAI_API_KEY=` line yourself. Never paste it into a chat or agent. This key pays only for decisions, such as rating jobs and mapping form fields. A ChatGPT subscription does not pay for API calls.

Set `DECISIONS_BUDGET_USD` below the prepaid balance you have available. The command limit `DECISIONS_RUN_CAP_USD` defaults to $1.00 per command. Costs are estimates from reported token use; they have not been measured against this backend yet. See [DECISIONS.md](DECISIONS.md).

Run `npx job-search doctor`.

## 3. Set up the writer

The writer is a separate program with its own sign-in and plan. It writes words; the decisions key is never given to it. The two bills do not cover each other. See [WRITER.md](WRITER.md).

For a first rehearsal without a model, set `WRITER_COMMAND` in `.env` to:

```text
["node","examples/writers/mock-writer.mjs"]
```

The mock writer produces placeholders and makes no model call. Later, after installing the Codex CLI and running `codex login` with a ChatGPT plan, you can change it to:

```text
["node","examples/writers/codex-exec.mjs"]
```

The Codex CLI wrapper was tested on Ubuntu. No other writer harness is claimed to work. `WRITER_BILLING` controls which reported billing types are accepted. Run `npx job-search doctor` after setting the writer.

## 4. Check the setup

Run `npx job-search doctor` after each step as you work. Its normal run is offline and free. The `--probe-decisions` flag makes one small paid API call using your prepaid decision balance. The `--probe-writer` flag asks your configured writer once, using that writer's own sign-in and billing. Use the probes only when you are ready for those calls.

## 5. Prepare your profile and writing files

Copy `data/profile.example.json` to `data/profile.json` and fill in your details. Add the absolute path to your resume PDF in the profile. Keep the PDF on your machine. Copy `data/voice.md` to `data/voice.local.md` and write what your own voice sounds like. Create `data/bank.json` from `data/bank.example.json`, with drafts based on your facts. Use braces for details that depend on the company. Run `npx job-search doctor` after the profile and files are ready.

### Writing your profile

Answer these questions for yourself while editing `data/profile.json`. Copy exact facts from your resume or enter what you know. Do not invent or round facts. Leave optional or demographic answers declined if you prefer.

**Who you are:** What are your legal first and last names? What name do you prefer, if different? What are your pronouns, if you want to share them? What email and phone number, including country code, should employers use? What is your full mailing address? What is your date of birth, if you want to provide it? What are your LinkedIn, GitHub, and portfolio links?

**Education:** What school, degree, field and minor should be listed? When did you start, and when will you graduate? Is the degree in progress or complete? What is your GPA and scale, if you want to provide it? Should it be included whenever asked, or only when required?

**Where you may work:** What citizenships do you hold? In which countries can you work today without sponsorship? Would you need sponsorship elsewhere? What one sentence should explain your work status?

**What you want:** Are you looking for internships, new graduate roles, or both, and in which terms? What is your earliest start date and how long can you work? Which locations do you prefer, in order? Would you relocate? Do you prefer remote work, accept it, or not want it? Can you work in an office or hybrid?

**Your experience:** Are all jobs, projects, bullets and numbers on your resume accurate? What awards, hackathons, coursework or open source work should be added? Which spoken languages do you know and at what level? Which programming languages, frameworks and tools are your skills?

**Optional self-identification:** How do you identify your gender, race or ethnicity, Hispanic or Latino status, veteran status, disability status, sexual orientation, and transgender status? Each is optional. You can decline any of them.

**Standing answers:** What pay or range should you give, if any, and is a stated rate acceptable? How did you hear about the job? Do you agree to text messages, marketing email and job alerts? May the company keep your details for future roles? Are you employed now, and what is your notice period? How should you answer questions about convictions, non-compete agreements, past work or applications at the company, relatives there, and security clearance? Should the tool still apply if a posting asks for a different graduation date or year? Which engineering areas do you prefer, in order? Which AI tools do you use and how? How many internships or jobs have you held? Can you travel for an interview or in-person test? Are you 18 or older? Would you take a drug test and background check? Do you have a transcript to attach, and where is it? What should the tool never say or answer for you?

The tool writes a cover letter only when you ask (`--cover`, or in your profile), and it never gives references. It skips a job that requires references, and a job that requires a cover letter when you have not asked for one.

## 6. Rehearse

Run a first discovery:

```sh
npx job-search discover --limit 20
```

Then rehearse three applications without sending them:

```sh
npx job-search apply --dry --count 3
```

Some job boards save a form as you type. A rehearsal may leave an unsent draft on that board. It is not an application and the employer is not told. Review the fill reports and correct your profile, voice guide or drafts before relying on the results.

Nothing is submitted without `--submit` or a standing policy. No account is made and no sign-in happens without your recorded consent. Mail is read only after you connect Gmail, and only verification mail and reply subjects. Work authorization comes from your profile, in code. Every typed value is read back. A robot check or sign-in is left for you. A form is counted as sent only when its confirmation page is read with enough support; otherwise it remains not confirmed for `npx job-search reconcile`.

## 7. What remains yours

You create and protect the API key, choose and sign in to your writer, and verify your profile, resume, voice and drafts. You decide which accounts to connect and which applications to send. Read each rehearsal report and resolve anything held for you. When a backend cannot run because the key, credit, spend limit, writer startup or billing acceptance is missing, the run stops and unfinished jobs return to the queue.

For system-specific details, including macOS Keychain support and Linux password and scheduling setup, see [PLATFORMS.md](PLATFORMS.md).
