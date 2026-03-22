# Architecture

## Overview
Sports Copilot is a monorepo sidekick system composed of three runtime apps and shared contracts:

1. `apps/workers`
   - runs the replay and live-context update loops
   - ingests transcript, event, social, narrative, roster, and sampled-frame inputs
   - computes world-state updates, retrieval context, vision cues, and session memory
   - syncs world-state updates to the API

2. `apps/api`
   - stores the latest shared world state
   - exposes `/world-state`, `/controls`, and `/health`
   - accepts worker updates through `/internal/state`
   - runs the model-backed interpretation, cue, transcription, and review paths

3. `apps/web`
   - renders the broadcaster-facing live desk and session archive
   - polls world state and controls
   - captures browser mic input
   - runs local hesitation/recovery sensing
   - requests grounded cue generation and displays compact provenance

4. `packages/shared-types`
   - provides Zod-backed contracts used across worker, API, and web

## Orchestrated Sidekick Model
The system is best understood as an orchestrator plus specialist agents/modules:

- `Signal agents`
  - pause
  - filler
  - wake phrase
  - repetition
  - pace / WPM
  - recovery
- `Context agent`
  - live match facts
  - recent events
  - social pulse
  - pre-match setup
  - session memory
  - sampled visual cues
- `Cue agent`
  - generates one grounded recovery line
- `Grounding layer`
  - attaches sources and explainability
- `Review agent`
  - turns saved booth traces into post-session coaching

This is deliberately not a chat agent. The orchestrator's job is to decide whether to intervene at all.

## World-State Pipeline
Inputs flow through the worker and browser booth loop into a shared world model:

`events/transcript/social/vision -> context + signal agents -> world state -> API -> live desk`

The browser booth then layers on:

`mic activity + transcript + hesitation/recovery sensing -> interpret -> generate cue -> render one prompt`

## Memory Model
- `static`: roster and evergreen narrative facts
- `session`: recent events, recent commentary, surfaced assists
- `live`: recent match facts, social pulse, active inferred vision cues

## Current Live Grounding Inputs
The cue stack can currently blend:
- pre-match context
- live match stats
- recent events
- social pulse
- context bundle items
- session transcript thread
- sampled vision cues

The prompt card can also expose a compact `Why this cue` trace with source chips and recent live context.

## Demo Guarantees
- grounded single-card assist output
- one compact prompt at a time
- recovery-aware weaning instead of permanent takeover
- graceful degradation when optional inputs are missing
- replay-driven reliability for demo conditions

## What Is Still Heuristic
- hesitation sensing is still a hybrid heuristic system, not a learned user model
- vision input is still sampled and tagged, not full raw-video understanding
- live fixture resolution and broader external context refresh are still early-stage
- health / biometric inputs are not yet integrated

## Productionization Path
The architecture is intentionally staged so the current inputs can later be expanded into:
- dynamic fixture resolution
- richer live sports APIs
- stronger rolling game-state memory
- optional biometric or device-consented speaker-state signals
- stronger multimodal scene tracking
- hosted observability and runtime traces

without rewriting the core sidekick interaction model.
