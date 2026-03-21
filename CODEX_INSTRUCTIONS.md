# Codex Instructions

Read this file before every milestone.

## Project
Sports Copilot is a hackathon demo: an AI soccer commentator co-pilot for a controlled El Clásico replay.

## Core rule
Optimize for a smooth, flashy, reliable demo — not production completeness.

## Always do
- work from TASKS.md in order
- build in small vertical slices
- keep the repo runnable
- run build, test, and lint after meaningful changes
- fix failures before moving on
- update TASKS.md as you complete work
- make small logical commits

## Never do
- do not skip tests
- do not add unnecessary dependencies
- do not overengineer infra
- do not replace deterministic fixtures with flaky live APIs on the critical demo path
- do not dump large chat-style text into the UI

## Product constraints
- assists must be short
- assists must be grounded
- intervene only when needed
- UI should feel premium and broadcast-oriented
- prioritize replay reliability

## If blocked
Stop only for:
- missing secret
- missing deployment credential
- true environment blocker

Otherwise continue.