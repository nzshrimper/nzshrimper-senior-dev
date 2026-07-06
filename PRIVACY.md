# Privacy Policy

**Plugin:** senior-dev (a Claude Code plugin)
**Publisher:** Foundry Studio (Chris Bennett)
**Last updated:** 2026-07-07

## The short version

senior-dev collects nothing, sends nothing, and stores nothing off your
machine. It runs entirely locally, inside your own Claude Code environment.

## What the plugin does with data

Everything senior-dev touches stays on your computer:

- **Session state.** It reads and writes `.senior-dev/state.json` and
  `.senior-dev/skills.json` in the repository you are working in, and archives
  closed sessions to `.senior-dev/history/`. These are plain local files.
- **Your session transcript.** The stop gate reads the local Claude Code
  transcript file to check whether a turn claims completion. It reads it in
  place; it never copies or transmits it.
- **Local commands.** It runs local `git` and `node` commands (the state CLI)
  and reads your working tree. Nothing is uploaded.

## What it does not do

- No telemetry, analytics, tracking, or usage reporting.
- No network requests of its own. It does not phone home or contact any server.
- No collection of personal data, code, credentials, or environment variables.

## Third-party tools you invoke

senior-dev can suggest running tools you have installed separately — for
example a read-only Codex review, or a `find-skills` search of the public
skills directory. Those tools run under their own terms and privacy policies;
senior-dev does not send them anything beyond the actions you choose to take.

## Changes

Any change to this policy will be committed to this repository with a new
"Last updated" date.

## Contact

Questions about privacy: nzshrimper@gmail.com — https://foundrystudio.app
