# CLAUDE.md: TABot

Rules for anyone, human or agent, changing this repository.

## WHAT THIS REPO IS

TABot (Teacher's Assistant) is one static web page, free and open source (MIT). A
math teacher opens it in a browser, pastes their own API key, enters an answer
key, photographs their students' exit slips a few at a time, and gets one
spreadsheet back. No backend, no server, no relay, no browser extension, nothing
to install.

Providers: Groq, the free default; Claude, optional, on the teacher's own API key
with the browser-access header. Ollama Cloud stays out until Ollama allows direct
browser calls.

A provider a teacher can pick must have terms saying inputs are not used for
training and not human-reviewed for product improvement.

## API KEYS

- A key lives in the browser's localStorage only.
- A key is sent only to the provider it belongs to.
- A key is never logged and never appears in a URL.

## NO ANALYTICS, NO TELEMETRY

No analytics or telemetry of any kind.

## PERMISSIONS

No system permission is ever requested without announcing it first and waiting
for the maintainer's answer. Screen recording, audio capture, accessibility
control, cross-app automation and full disk access are never requested, for any
reason, in this repo. A permission prompt not agreed in advance is a halt, not a
step.

The page may hold a screen wake lock while a class is processing, and releases
it when processing ends.

## STUDENT DATA

No real student data in the repo, ever. Test fixtures are synthetic slips.
Student work never leaves the teacher's device (phone or computer) except to the
provider the teacher chose.

## NOTHING BUT TABOT IN THIS REPO

This repository is public. No file, commit message, pull request, review or
comment in it carries the maintainers' business or internal records: no in-house
vocabulary, no references to other private repositories or their rules, no real
names, no paths from a maintainer's machine, no private links. Write only what
TABot and its contributors need.

## HOW CHANGES LAND

Every change is a pull request to main, and main accepts changes only through a
pull request. A maintainer merges.
