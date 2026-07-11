<!--
  Keep PRs scoped to one logical change. For anything beyond a small fix, please
  link the issue where the approach was discussed (see CONTRIBUTING.md).
-->

## What & why

<!-- What does this change, and why? Link the issue it addresses. -->

Closes #

## Checklist

- [ ] `bun run check` passes (the full CI gate — format, lint, typecheck, tests, build for both root and admin-ui)
- [ ] New/changed DB schema is a **new, appended** `src/db/migrations.ts` entry, tested against a fresh DB — never an edit to an existing one
- [ ] Docs updated if user-facing behavior, config, or API changed (English **and** the `docs/es/` mirror)
- [ ] Commit messages follow the `type(scope): summary` convention
- [ ] Screenshots included for any admin-UI visual change
- [ ] New translatable demo-fixture strings have a `*Key` field + entries in `scripts/seed-demo-i18n.py` and `scripts/translate-demo-i18n.py`
