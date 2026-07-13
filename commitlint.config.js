// Enforces this repo's `type(scope): summary` convention (see CLAUDE.md
// "Working in this repo"). @commitlint/config-conventional's default type
// list (build/chore/ci/docs/feat/fix/perf/refactor/revert/style/test)
// already matches every type actually used across this repo's git history.
export default {
  extends: ["@commitlint/config-conventional"],
};
