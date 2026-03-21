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
- [x] build replay engine for 1–2 minute soccer clip
- [x] replay event timeline deterministically
- [x] support play / pause / restart
- [x] emit world-state updates every tick

### Game State Agent
- [x] track score
- [x] track match clock
- [x] track possession
- [x] track recent events
- [x] track high-salience moments
- [x] expose current game-state summary

### Session Memory
- [x] store recent events in rolling session memory
- [x] store previously surfaced assists
- [x] store recent commentary context

### Tests
- [x] test replay timing
- [x] test world state transitions
- [x] test score updates
- [x] test possession/event updates

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
- [x] maintain active narratives:
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
- [x] decide whether to intervene
- [x] choose assist type
- [x] choose style mode
- [x] choose urgency

### Generator Agent
- [x] generate:
  - [x] hype line
  - [x] context line
  - [x] stat line
  - [x] transition line
  - [x] co-host toss-up
- [x] keep output under strict length target

### Grounding Agent
- [x] verify claims against retrieved context
- [x] suppress unsupported facts
- [x] attach source chips

### Ranking Agent
- [x] rank multiple candidate assists
- [x] return only top assist

### Tests
- [x] test assist length
- [x] test supported source chips
- [x] test no assist when not needed
- [x] test intervention after high-salience hesitation

---

## P5 — UI / Demo Experience

### Dashboard UI
- [x] video/replay panel
- [x] scoreboard strip
- [x] event timeline
- [x] active narrative panel
- [x] hesitation/confidence meter
- [x] active assist card
- [x] source chips
- [x] style mode indicator

### Assist Card UX
- [x] animate assist appearance
- [x] show type, text, confidence, why-now
- [x] support source chips
- [x] avoid chat-style layout

### Demo Controls
- [x] play / pause / restart
- [x] style mode switch
- [x] optional manual “force hesitation” control for demo backup

### Interactive Booth Polish
- [x] load a local replay clip into the UI
- [x] show clip timing next to fixture timing
- [x] capture booth speech with browser mic input
- [x] track live hesitation in the browser booth
- [x] gate assist reveal on live booth hesitation when mic input is active
- [x] soften the visual design for live demo usability

### Tests
- [x] e2e test dashboard render
- [x] e2e test replay controls
- [x] e2e test assist card appearance

---

## P6 — Optional Multimodal Layer

### Vision Agent
- [x] ingest sampled frames
- [x] infer coarse scene tags:
  - [x] attack
  - [x] replay
  - [x] crowd reaction
  - [x] player close-up
  - [x] coach reaction
  - [x] celebration
- [x] add vision cues to live memory

### Tests
- [x] test frame-to-tag mapping
- [x] test vision cue availability in retrieval

---

## P7 — Demo Hardening

### Demo Script
- [x] write judge demo flow
- [x] define exact event timestamps
- [x] define exact hesitation moments
- [x] define exact expected assists

### Reliability
- [x] one-command local startup
- [x] stable fixture loading
- [x] graceful fallback if optional modules fail
- [x] no hard dependency on live internet

### Handoff Docs
- [x] write DEMO_SCRIPT.md
- [x] write JUDGE_PITCH.md
- [x] write KNOWN_LIMITATIONS.md

---

## P8 — Production Hesitation Engine

### Live Signal Interpretation
- [x] add server-side booth interpretation endpoint
- [x] support OpenAI-backed hesitation/recovery interpretation with safe fallback
- [x] add server-side OpenAI audio transcription endpoint
- [x] send live booth feature snapshots from the web app
- [x] remove browser transcription fallback from the primary booth path
- [x] strengthen transcript-instability features beyond pause dominance
- [x] add explicit step-in / monitoring / weaning-off state transitions across the booth loop

### Tests
- [x] test heuristic booth interpretation fallback
- [x] test OpenAI response parsing for booth interpretation
- [x] test OpenAI transcription response parsing
- [ ] test live booth state transitions end to end

---

## P8 — Free Deployment Path

### Hosted Runtime
- [x] make API host/port configurable for cloud hosting
- [x] make worker API target configurable by environment
- [x] expose worker health endpoint for free web-service hosting

### Productized Booth UX
- [x] redesign the booth as a teleprompter-style sidekick surface
- [x] add preflight checks for clip, mic, and backend readiness
- [x] add green/yellow/red coaching states for steady, hover, and step-in behavior

### Deployment Config
- [x] add Render blueprint config
- [x] add Vercel build config
- [x] add deployment env example

### Docs
- [x] document the quickest free hosted stack
- [x] write local setup instructions in README.md

### Final QA
- [x] full test suite green
- [x] lint clean
- [x] build passes
- [x] demo run-through passes

---

## P8 — Productionization

### Practice Booth
- [x] remove fixture-driven landing copy from the main screen
- [x] make the default landing flow clip-first and mic-first
- [x] mute loaded clip audio by default to avoid contaminating booth input
- [x] keep hesitation testing usable without fake match/news overlays
- [x] show only hesitation-triggered practice assists on the landing screen

### Real Inputs
- [x] replace browser transcript-only hesitation detection with audio activity / VAD support
- [x] persist booth sessions and analytics to a real local SQLite store
- [x] migrate booth sessions and analytics to hosted Postgres when DATABASE_URL is set
- [ ] ingest a real free match/event API for live game context
- [ ] ingest real external context from free/public sources
- [ ] remove deterministic fixture dependency from the primary product path

### Production Assist Pipeline
- [ ] route assists from real live context instead of demo fixtures
- [ ] preserve grounding with source attribution against real inputs
- [ ] keep a fixture/demo mode only as an explicit fallback path

### Deployment
- [ ] create a self-serve hosted test environment
- [ ] document required free API providers and keys
- [ ] verify the production path end-to-end

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
