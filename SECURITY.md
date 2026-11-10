# Security policy

## Reporting

Use GitHub's private vulnerability reporting:
https://github.com/ethan-br/jev-job-search/security/advisories/new.
Do not open a public issue for anything that involves personal data, API
keys, or a way to make the tool submit something a user did not intend.
Expect a reply within a week.

## Scope

In scope: the CLI, the browser scripts in `src/forms/`, the way personal data and the decision key are handled.

Out of scope: the job boards and applicant tracking systems the tool
talks to, the decision backend provider and writer wrappers.
Report those to their owners.

## What the tool does with data

- Reads `data/profile.json` and the resume locally; both are git-ignored.
- Sends job text, form fields, candidate facts and page text to the decision backend for decisions. The writer receives profile facts, the voice guide, drafts, the posting and open questions. Keys and passwords go to neither. Usage records contain no content. There is no telemetry.
- Writes form values into pages in the user's own browser session.
- Records usage in `data/runs/` without content.

See `docs/SAFETY.md` for the full list of rules and the pre-publish checks.

## Supported versions

The `main` branch. There are no release branches yet.
