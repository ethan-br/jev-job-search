## What changed and why

<!-- One paragraph. What a reader of the CHANGELOG should learn. -->

## Failing case, for fixes

<!-- The form, site or input that went wrong, with personal details removed, and what the tool did. -->

## Verification

<!-- What you ran: `npm test` and `npm run check-types`, and any `apply --dry` rehearsal with the boards it touched. -->

## Checklist

- [ ] `npm test` and `npm run check-types` pass
- [ ] No personal data, keys or real resumes in the diff or fixtures
- [ ] Tunables stayed in `src/config.ts`
- [ ] Conventional Commits title: `type(scope): summary`
- [ ] Docs updated if behaviour changed (`README.md`, `docs/`, `AGENTS.md`, `CHANGELOG.md`)
