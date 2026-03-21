# Architecture

## Overview
Sports Copilot is a local monorepo demo composed of three runtime apps and shared contracts:

1. `apps/workers`
   - runs the deterministic replay engine
   - ingests transcript, event, social, narrative, roster, and sampled-frame fixtures
   - computes commentator state, narratives, retrieval, vision cues, session memory, and the active assist
   - syncs world-state updates to the API

2. `apps/api`
   - stores the latest shared world state
   - exposes `/world-state`, `/controls`, and `/health`
   - accepts worker updates through `/internal/state`

3. `apps/web`
   - renders the broadcast-style dashboard
   - polls world state and controls
   - posts replay/style/manual-trigger control changes

4. `packages/shared-types`
   - provides Zod-backed contracts used across worker, API, and web

## World-State Pipeline
Fixture inputs flow through the worker on each tick:

`events/transcript/social/vision_frames -> replay + agents -> world state -> API -> dashboard`

The most important agent layers are:
- replay engine
- commentator/hesitation analysis
- narrative state
- retrieval memory tiers
- assist generation and ranking
- vision cue inference from sampled frames
- session memory

## Memory Model
- `static`: roster and evergreen narrative facts
- `session`: recent events, recent commentary, surfaced assists
- `live`: fake social posts and active inferred vision cues

## Demo Guarantees
- deterministic replay and fixtures
- grounded single-card assist output
- no hard dependency on live internet on the demo path
- graceful fallback when optional social or vision fixtures are unavailable

## Productionization Path
The architecture is intentionally staged so the deterministic fixture inputs can later be swapped for:
- live sports event APIs
- live transcript streaming
- real model-backed generation and grounding
- real deployment and observability

without rewriting the whole world-state and assist pipeline.
