# Judge Pitch

Sports Copilot, branded in-product as AndOne, is an adaptive sidekick for live commentary, not an auto-commentator.

## The Problem
Commentators, hosts, and other live speakers do not need an AI writing every line for them. They need a system that:
- notices when delivery is slipping
- understands what is happening right now
- gives one small nudge at the right moment
- gets out of the way as soon as the human is back in rhythm

## Why This Fits Track 3
This is a Sidekick, not a replacement workflow:
- it adapts to the speaker's current state
- it anticipates hesitation before the moment fully falls apart
- it respects autonomy by staying quiet when the speaker is doing fine
- it explains why the cue appeared instead of acting like magic

## What Makes This Different
AndOne runs like a small orchestrated sidekick system with specialist agents/modules:
- signal agents track pauses, fillers, repeated starts, wake phrases, and recovery
- a context agent keeps a rolling live knowledge state fresh
- a cue agent turns the current moment into one grounded line
- a grounding layer attaches sources and prevents unsupported output
- a review agent turns saved booth traces into post-session coaching

The system blends:
- transcript and hesitation signals
- live match facts
- recent events
- social pulse
- pre-match setup
- session memory
- sampled visual cues

Then it does the important human-centered part: it decides whether the speaker actually needs help.

## What Judges Should Notice
- The UI is broadcaster-facing, not chat-facing.
- The prompt only appears when hesitation is active.
- The prompt weans off when confidence returns.
- The cue is grounded in current context instead of generic filler.
- The `Why this cue` reveal makes the grounding legible without cluttering the main cue.
- The product is clearly assistive: one line, one moment, one nudge.

## Why It Matters
This is the shape of a real human-centered sidekick:
- assistive, not replacing the speaker
- adaptive, not one-size-fits-all
- context-aware across messy streams
- transparent enough to trust
- extensible into more live inputs without changing the core interaction model
