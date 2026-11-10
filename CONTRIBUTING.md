# Contributing

Thanks for looking. This project is small and opinionated; the fastest way
to help is a focused pull request with a test.

## Setup

```bash
git clone https://github.com/ethan-br/jev-job-search && cd jev-job-search
npm install
npm test
```

Node 22 (`.nvmrc`). Tests run offline with mock decisions and the mock writer. No build step; everything runs through `tsx`.

## Where things go

- A new job board: `src/sources/`, then call it from `collectJobs` in
  `src/discover.ts`. Add a fixture under `tests/fixtures/` and a parser
  test. `docs/SOURCES.md` explains the contract.
- A new kind of form control: `src/forms/dumpFields.js` (capture it, and
  name its `widget`), `src/forms/fillFields.js` or `src/forms/pageHelpers.js`
  (set it and read it back), `src/browser/fill.ts` (the way it is written),
  `src/forms/mapForm.ts` (ask the decision backend about it). `npx job-search knowledge
  --trouble` lists the controls nobody has taught the tool yet.
- What your own runs learned about sites: `npx job-search knowledge
  --share`, then commit `knowledge/sites.json`. It holds site names and
  kinds of controls, and nothing about you.
- A form that was filled wrongly: rehearse it with
  `npx job-search apply --dry <id>`, fix the cause, and rehearse again.
  `AWJ_TRACE=1` prints step timings and the page's own saves.
- A new thing the decision backend should decide: write the question with criteria that are
  definitions, add it next to its siblings, and document it in
  `docs/DECISIONS.md`.
- A writer wrapper: add it under `examples/writers/`. Call it supported only after running it end to end.
- Any threshold, weight, timeout or URL: `src/config.ts` only.

## Rules

- Never commit personal data, keys, or real resumes. CI fails if the
  ignored files show up or a key pattern appears.
- Every external payload goes through a zod schema.
- Prose has no em dashes. Commits are Conventional Commits
  (`feat(forms): handle button groups`). No AI attribution trailers.
- Keep dependencies at two runtime packages unless there is a strong
  reason.

## How we write

The README and the docs are written for a reader who has never seen the
project. We follow the plain language principles of ISO 24495-1:2023: the
reader can find what they need, understand it, and use it.

- Start with what the reader needs most. Put background last.
- Use headings that say what the section is for.
- Address the reader as "you". Use the active voice.
- Keep sentences short, with one idea each.
- Use everyday words. Explain a term the first time you use it, then use
  the same term every time.
- Use a list for steps and a table for comparisons.
- Give real numbers, say when they were measured, and say what they leave
  out.

## Before you push

```bash
npm run check-types && npm test && npm audit --omit=dev
```

## Code of conduct

Be decent. See `CODE_OF_CONDUCT.md`.
