# senior-dev smoke checklist

Run after every install/update, in a THROWAWAY repo (scratchpad), with the
plugin installed and Claude Code restarted.

Setup: `mkdir -p <scratch>/sd-smoke && cd <scratch>/sd-smoke && git init && git commit --allow-empty -m init`

1. [ ] New Claude session in the throwaway repo -> bootstrap context mentions
       senior-dev:conductor. In a non-git dir -> no mention.
2. [ ] /senior-dev:status -> "no active session".
3. [ ] /senior-dev:start add a hello script (quick-fix lane expected) ->
       state file created, .git/info/exclude contains .senior-dev/.
4. [ ] During implement with no tests-green: `git commit` -> BLOCKED with
       tests-green message. After state-cli tests-green -> commit passes.
5. [ ] `git push` before review/verify/docs -> BLOCKED listing blockers.
6. [ ] Claim "all done" with open items -> stop gate returns checklist once;
       identical second stop -> allowed through.
7. [ ] /senior-dev:bypass testing the escape hatch -> next push allowed,
       bypass visible in /senior-dev:status.
8. [ ] Codex absent/unauthed simulation (or real /codex:review) -> verdict
       recorded via state-cli review; cycle 4 refused by CLI.
9. [ ] /senior-dev:finish -> sweep evidence printed, state archived to
       .senior-dev/history/, /senior-dev:status -> "no active session".
10. [ ] Delete throwaway repo. Zero leftovers on the machine.
