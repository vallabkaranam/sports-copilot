# Sports Copilot Tasks

## Project Goal
Build a hackathon-ready AI soccer commentator co-pilot for a controlled El Clásico replay demo.

## Principles
- prioritize demo reliability over production complexity
- keep the system runnable at all times
- use deterministic local data for the core path
- keep assists short and grounded
- ship in vertical slices
- test every major feature

---

## P0 — Foundation

### Repo / Workspace
- [x] set up monorepo package structure
- [x] initialize root package.json
- [x] configure workspace support
- [x] initialize tsconfig base
- [x] add linting + formatting
- [x] add test runner
- [x] add basic scripts:
  - [x] dev
  - [x] build
  - [x] test
  - [x] lint

### Shared Contracts
- [x] define shared types for:
  - [x] GameEvent
  - [x] WorldState
  - [x] CommentatorState
  - [x] NarrativeState
  - [x] AssistCard
  - [x] SourceChip
  - [x] StyleMode
- [x] export shared schemas for frontend + backend use

### Demo Data
- [x] create deterministic demo match fixture
- [x] populate:
  - [x] events.json
  - [x] roster.json
  - [x] narratives.json
  - [x] fake_social.json
  - [x] transcript_seed.json

### App Scaffolding
- [x] scaffold web app
- [x] scaffold api service
- [x] scaffold worker service
- [x] add shared UI package
- [x] add shared prompts package

---

## P1 — Replay + World State

### Replay Engine
- [ ] build replay engine for 1–2 minute soccer clip
- [ ] replay event timeline deterministically
- [ ] support play / pause / restart
- [ ] emit world-state updates every tick

### Game State Agent
- [ ] track score
- [ ] track match clock
- [ ] track possession
- [ ] track recent events
- [ ] track high-salience moments
- [ ] expose current game-state summary

### Session Memory
- [ ] store recent events in rolling session memory
- [ ] store previously surfaced assists
- [ ] store recent commentary context

### Tests
- [ ] test replay timing
- [ ] test world state transitions
- [ ] test score updates
- [ ] test possession/event updates

---

## P2 — Transcript + Hesitation

### Transcript Agent
- [x] ingest transcript input stream
- [x] track timestamps
- [x] detect pauses
- [x] detect fillers
- [x] detect repeated phrase patterns

### Co-Host Agent
- [x] model co-host speaking state
- [x] suppress assist if co-host is actively speaking
- [x] allow toss-up prompt generation

### Hesitation Agent
- [x] compute hesitation score
- [x] trigger on silence after high-salience event
- [x] trigger on repeated fillers
- [x] trigger on unfinished phrase
- [x] expose hesitation reason

### Tests
- [x] test silence threshold trigger
- [x] test filler-based trigger
- [x] test co-host suppression
- [x] test hesitation score bounds

---

## P3 — Retrieval + Evolving RAG

### Memory Tiers
- [x] implement static memory
- [x] implement session memory
- [x] implement live memory

### Retrieval Agent
- [x] rank sources by relevance
- [x] prefer live > session > static
- [x] return supporting facts for assist generation
- [x] attach source metadata

### Narrative Agent
- [ ] maintain active narratives:
  - [x] rivalry
  - [x] momentum shift
  - [x] player spotlight
  - [x] comeback pressure
  - [x] defensive lapse
- [x] surface top narrative to world state

### Live Feed Agent
- [x] ingest fake_social.json
- [x] normalize “live” external updates
- [x] add relevant signals to live memory

### Tests
- [x] test retrieval priority
- [x] test narrative updates
- [x] test source attribution presence

---

## P4 — Assist Generation

### Supervisor Agent
- [ ] decide whether to intervene
- [ ] choose assist type
- [ ] choose style mode
- [ ] choose urgency

### Generator Agent
- [ ] generate:
  - [ ] hype line
  - [ ] context line
  - [ ] stat line
  - [ ] transition line
  - [ ] co-host toss-up
- [ ] keep output under strict length target

### Grounding Agent
- [ ] verify claims against retrieved context
- [ ] suppress unsupported facts
- [ ] attach source chips

### Ranking Agent
- [ ] rank multiple candidate assists
- [ ] return only top assist

### Tests
- [ ] test assist length
- [ ] test supported source chips
- [ ] test no assist when not needed
- [ ] test intervention after high-salience hesitation

---

## P5 — UI / Demo Experience

### Dashboard UI
- [ ] video/replay panel
- [ ] scoreboard strip
- [ ] event timeline
- [ ] active narrative panel
- [ ] hesitation/confidence meter
- [ ] active assist card
- [ ] source chips
- [ ] style mode indicator

### Assist Card UX
- [ ] animate assist appearance
- [ ] show type, text, confidence, why-now
- [ ] support source chips
- [ ] avoid chat-style layout

### Demo Controls
- [ ] play / pause / restart
- [ ] style mode switch
- [ ] optional manual “force hesitation” control for demo backup

### Tests
- [ ] e2e test dashboard render
- [ ] e2e test replay controls
- [ ] e2e test assist card appearance

---

## P6 — Optional Multimodal Layer

### Vision Agent
- [ ] ingest sampled frames
- [ ] infer coarse scene tags:
  - [ ] attack
  - [ ] replay
  - [ ] crowd reaction
  - [ ] player close-up
  - [ ] coach reaction
  - [ ] celebration
- [ ] add vision cues to live memory

### Tests
- [ ] test frame-to-tag mapping
- [ ] test vision cue availability in retrieval

---

## P7 — Demo Hardening

### Demo Script
- [ ] write judge demo flow
- [ ] define exact event timestamps
- [ ] define exact hesitation moments
- [ ] define exact expected assists

### Reliability
- [ ] one-command local startup
- [ ] stable fixture loading
- [ ] graceful fallback if optional modules fail
- [ ] no hard dependency on live internet

### Handoff Docs
- [ ] write DEMO_SCRIPT.md
- [ ] write JUDGE_PITCH.md
- [ ] write KNOWN_LIMITATIONS.md
- [ ] write local setup instructions in README.md

### Final QA
- [ ] full test suite green
- [ ] lint clean
- [ ] build passes
- [ ] demo run-through passes

---

## Suggested Build Order
1. shared types
2. replay engine
3. world state
4. transcript + hesitation
5. assist generation
6. retrieval + narratives
7. UI polish
8. optional vision
9. demo hardening

## Definition of Done
- one polished local demo works end-to-end
- replay updates the world state live
- hesitation causes one useful assist to appear
- assist is grounded and short
- UI looks premium
- tests pass
