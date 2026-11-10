# The writer: the program that writes

Everything this tool writes in words comes from one place: a program you choose, called the
writer. It writes the answers to open questions on a form, the two notes in your tracking sheet,
and tailored resumes and cover letters. Decisions (which box, which option, which page) are a
different thing with a different bill: see `docs/DECISIONS.md`.

The tool knows nothing about which program, which model or which company is behind the writer. It
starts the program, hands it one JSON request, reads one JSON response, and checks the response
against its own schema before using a word of it.

## What has been tested, and what has not

| Writer | Status |
|---|---|
| `examples/writers/mock-writer.mjs` | Tested by the test suite on every run. It calls no model |
| `examples/writers/codex-exec.mjs` with the Codex CLI 0.167.0, signed in with a ChatGPT plan, on Ubuntu | Tested end to end with made-up candidate data: a form answer, a tailored resume and cover letter, a timeout and a cancel |
| Any other harness, CLI or model | **Not tested. No compatibility is claimed.** You can write a wrapper for it from the contract below |

There is no built-in writer and no fallback. When `WRITER_COMMAND` is not set, or the program
cannot be started, or it fails, the call fails and says why. The tool never reaches for another
program or for a paid API in its place.

## Configuring it

Three settings in `.env` (or in your shell, which wins over `.env`):

```
WRITER_COMMAND=["node","examples/writers/codex-exec.mjs"]
WRITER_ENV=
WRITER_BILLING=subscription,free
```

- **`WRITER_COMMAND`** is a JSON array: the program first, then its arguments. No shell reads it,
  so nothing in it is expanded, split or interpreted. A value that is not a JSON array of strings
  is an error, not a guess.
- **`WRITER_ENV`** names extra environment variables the writer may see, separated by commas. It
  is usually empty. See "What the writer can see" below.
- **`WRITER_BILLING`** lists the ways of paying you accept: `subscription`, `metered`, `free`,
  `unknown`. The default is `subscription,free`.

`npx job-search doctor` checks these offline. `npx job-search doctor --probe-writer` asks the
writer for one short reply, on the writer's own sign-in and plan.

## Billing: who pays for writing

The writer says, in every response, how that call is paid for. The tool compares it with
`WRITER_BILLING` **before** it looks at the output:

- `subscription`: covered by a plan you already pay for.
- `free`: no model was called (the mock writer).
- `metered`: charged per use, for example an API key.
- `unknown`: the writer cannot tell.

A response whose billing is not on your list is refused, its output is thrown away, and the run
stops, because every later call would be paid the same way. With the default list, a writer that
turns out to be metered or cannot say how it is paid never writes anything for you. Nothing
changes how you are billed without you changing a setting.

What this cannot do: it trusts what the writer reports. The Codex wrapper reads the sign-in from
Codex itself before each call. A wrapper you write must report honestly.

Your `OPENAI_API_KEY` pays for decisions only. It is never given to the writer, and listing it in
`WRITER_ENV` is refused. A ChatGPT subscription does not cover OpenAI API calls, and an API key is
not a subscription: the two are separate bills, and this tool keeps them separate.

`npx job-search cost` reports the writer apart from decisions: calls per task, how many were on a
subscription, free, metered or unknown, the tokens and cost the writer reported, and how many
calls reported no tokens or no cost. A cost that was not reported is shown as unknown, never as
zero. The tool has no price list for any writer and never estimates one.

## What the writer can see

The writer is started with a short allow-list of environment variables: `PATH`, `HOME`, the
language and time zone, proxy and certificate settings, and what a program needs to reach the
screen. No key and no password is on that list (`CHILD_ENV` in `src/config.ts`).

- The writer finds its own sign-in the way it always does, usually in a folder under `HOME`.
- A variable you name in `WRITER_ENV` is passed as well. That is the only way a credential in your
  environment reaches the writer, and you have to write its name down to make it happen.
- `OPENAI_API_KEY` and every `JOB_SEARCH_*` secret are never passed, even when named.

What the writer is sent: your profile facts, your voice guide, your drafts, the posting, and the
open questions. It is the one place your profile text leaves your machine for a model, so choose a
writer you trust with it. It is never sent a password, a key, or your browser's cookies.

## How a call runs

- The program is started directly, with its arguments as an array, in the project folder.
- The request goes to its standard input. Its standard output must be exactly one JSON response.
  Standard error is for diagnostics: the last lines are shown, with anything that looks like a
  secret removed, when the call fails.
- Each call has a time limit (3 minutes, or 7 for a resume). When it passes, or the run is
  cancelled, the writer and everything it started are told to stop, and are ended by force two
  seconds later if they have not. A writer never outlives the command that started it.
- Output over 2 MB ends the call.
- A non-zero exit code, output that is not JSON, or a response that does not fit the contract is
  an error. The output is never quoted in the error.

| What went wrong | Kind | What the run does |
|---|---|---|
| `WRITER_COMMAND` missing or wrong | `config` | Stops. Jobs go back to the queue |
| The program cannot be started | `spawn` | Stops |
| It exited with an error | `exit` | Stops |
| Its billing is not accepted | `billing` | Stops |
| It took too long | `timeout` | This job is left for you. The run goes on |
| Its output is not a valid response | `malformed` | This job is left for you |
| Its output does not fit what was asked | `invalid_output` | This job is left for you |
| The call was cancelled | `cancelled` | Nothing is used |

## What is done with the output

Nothing the writer returns is trusted as it comes:

- It is parsed against the application's own schema. Anything else is `invalid_output`.
- An answer for a box that was not asked about is dropped.
- A tailored resume is checked claim by claim against your profile. A company, title, tool or
  number your profile does not support is sent back once to be removed, and if it is still there
  the documents are not used and your own resume is sent.
- Answers about work authorization, sponsorship and agreements are checked against your profile
  by code before they are typed, whoever wrote them.
- Every value typed into a form is read back from the page and compared.

## Cached writing

Answers the writer gave are remembered (`data/memory.json`) and tailored documents are kept. Each
is stored under a fingerprint of: the writer's identity (the command and `WRITER_ENV`), the kind of
task, the prompt version, the schema version, and your profile, drafts and voice guide. Change any
of them and the old writing is not reused. Text from one writer is never served as another's.

## The contract: `job-search.writer/v1`

The request, on standard input:

```json
{
  "contract": "job-search.writer/v1",
  "task": { "kind": "form_answers", "id": "unique-per-call", "jobId": "abc123", "promptVersion": 1, "schemaVersion": 1 },
  "system": "The standing instructions: the rules and the candidate.",
  "input": "What this call is about: the job and the open questions.",
  "output": { "format": "json", "schema": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } },
  "timeoutMs": 180000,
  "settings": { "effort": "low" }
}
```

- `task.kind` is `form_answers`, `tracking_notes`, `tailored_documents` or `probe`.
- `output.schema` is a JSON Schema for the one value wanted. Schemas stay inside what strict
  structured-output modes take: every property required, no additional properties, a nullable type
  where a value may be absent, no length or pattern keywords.
- `settings.effort` is `low`, `medium` or `high`. A hint: map it to your harness or ignore it.

The response, on standard output:

```json
{
  "contract": "job-search.writer/v1",
  "output": { "the": "value asked for" },
  "writer": { "name": "my-wrapper", "version": "1.0", "model": null },
  "billing": "subscription",
  "usage": { "inputTokens": 1200, "cachedInputTokens": null, "outputTokens": 240 },
  "costUsd": null
}
```

- `writer.version` and `writer.model` are `null` when the wrapper does not know them.
- `usage` is `null`, or has `null` inside, wherever a count is not known. Unknown is never zero.
- `costUsd` is `null` unless the harness reported a cost.

Exit with 0 after printing the response, and with any other code on failure, with a short reason on
standard error.

## The mock writer

```
WRITER_COMMAND=["node","examples/writers/mock-writer.mjs"]
```

It calls no model and costs nothing. It returns the smallest value that fits the schema it is
given: empty text, empty lists. Use it for a first rehearsal, to see the whole pipeline run without
any writing. Its answers are placeholders, so a rehearsal with it leaves open questions open.
**Never submit with it.** Its other flags make it fail in chosen ways for the tests.

## The Codex wrapper

```
WRITER_COMMAND=["node","examples/writers/codex-exec.mjs"]
WRITER_COMMAND=["node","examples/writers/codex-exec.mjs","--model","<name>"]
```

It needs the Codex CLI on your `PATH` and `codex login` done once with a ChatGPT plan. The wrapper
is outside `src/`: the core does not import it and does not know it exists.

What it does on every call:

1. Runs `codex login status`. Only "Logged in using ChatGPT" is accepted, and the response then
   says `subscription`. With an API-key sign-in, or one it cannot read, it exits without calling a
   model.
2. Takes `OPENAI_API_KEY` and `CODEX_API_KEY` out of the environment it gives Codex, so a key in
   your environment cannot switch the call to per-token billing.
3. Runs `codex exec` headless in an empty temporary folder, with a read-only sandbox, without your
   Codex config, rules, MCP servers, web search, apps, plugins, browser or image tools, and with the
   output schema enforced by Codex.
4. Removes the temporary folder, and stops Codex if it is told to stop.

`--allow-metered` lets an API-key sign-in through and reports it as `metered`. The tool still
refuses it unless you also add `metered` to `WRITER_BILLING`. Two settings, both yours, both on
purpose.

Limits you should know:

- Codex has no mode with every tool switched off. In its read-only sandbox the model could still
  run a command that only reads files it can reach.
- Codex does not say which model its default is, so `model` is `null` unless you pass `--model`.
- Codex reports tokens and no cost, so `costUsd` is always `null`. On a plan there is no per-call
  charge to report, but each call does count towards your plan's usage limits, and this tool
  cannot see those limits.
- It was tested with one version of the CLI on one system. A newer CLI may rename a flag: the
  wrapper passes `--strict-config`, so it fails loudly instead of running with a setting ignored.

## Writing your own wrapper

A wrapper is a small program: read the request from standard input, call your harness in its
headless mode with `system` and `input` and the schema, print the response, exit. Use
`examples/writers/codex-exec.mjs` as the pattern and `examples/writers/mock-writer.mjs` as the
smallest working example. Things to get right:

- Report `billing` from what the harness says about its sign-in, never from a guess. When you
  cannot tell, say `unknown`.
- Remove from the harness's environment any key that could change who pays.
- Stop the harness when you receive `SIGTERM`, and clean up what you created.
- Give the harness no tools it does not need. Writing needs none.
- Print nothing but the response on standard output.

Then test it: `npx job-search doctor --probe-writer`, and a rehearsal with `apply --dry`.
