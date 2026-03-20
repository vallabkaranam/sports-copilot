# Sports Copilot Spec

## Product Name
Sports Copilot

## One-Line Description
An AI sports commentator co-pilot that watches a live soccer match, understands evolving context from multiple messy inputs, detects commentator hesitation, and surfaces short, timely, grounded assistive commentary.

## Hackathon Goal
Build a flashy, demoable, agentic sidekick system for live sports broadcasting that fits the “AI sidekick” concept extremely well:
- assistive, not replacing the human
- context-aware
- live and adaptive
- grounded in evolving information
- multimodal
- subtle and timely

## Demo Scenario
We will build a controlled demo around a short 1–2 minute El Clásico soccer replay clip.

Preferred setting:
- FC Barcelona vs Real Madrid
- short clip with at least:
  - buildup
  - dangerous chance or major moment
  - brief hesitation opportunity for the commentator
  - enough context for rivalry / player / momentum commentary

This replay will behave like a live feed for demo purposes.

## Core User Story
As a live sports commentator, I want an AI sidekick that:
- listens to what I am saying
- tracks what is happening in the match
- ingests supporting context from stats, prior narratives, and live/social context
- detects when I am hesitating or losing momentum
- offers one short, relevant, stylistically appropriate assist
- stays quiet when I do not need help

## Primary Value Proposition
This is not just “AI that writes commentary.”
This is a live sidekick that:
1. fuses multiple messy streams into one evolving world model,
2. understands when the human needs help,
3. intervenes minimally and intelligently.

## Inputs
The system should be designed to support the following inputs:

### 1. Commentator Audio / Transcript
- live speech from main commentator
- timestamps
- pauses
- filler words
- hesitations
- repeated phrasing

### 2. Co-Host Audio / Transcript
- identify when co-host is speaking
- suppress interventions when unnecessary
- allow toss-up suggestions if useful

### 3. Match Event Feed
- game clock
- score
- possession
- pass / shot / foul / save / goal events
- substitutions
- cards
- stoppages
- momentum shifts

### 4. Static Soccer Knowledge
- player names
- team rosters
- rivalry facts
- historical context
- player bios
- team form
- prior match information

### 5. Live / Session Context
- events that have occurred in this broadcast
- current narrative arcs
- recent talking points
- session memory of what has already been said

### 6. Social / External Signals
- simulated live tweets
- trending reactions
- headlines
- crowd / sentiment style signals
- optional external updates

### 7. Visual Match Input
- sampled frames from the clip
- coarse scene understanding:
  - attack building
  - close-up on player
  - replay
  - crowd reaction
  - coach reaction
  - celebration
  - set piece
  - stoppage

## Outputs
The AI should output only one compact assist at a time.

Supported output types:
- Hype line
- Context line
- Stat line
- Narrative line
- Transition line
- Co-host toss-up question
- No intervention

## Output Constraints
- max 1–2 lines
- should feel broadcaster-friendly
- should be timely
- should be grounded in sources
- should match style mode
- should not overwhelm the user
- should never hallucinate unsupported facts

## Core System Behavior
The system should continuously:
1. ingest multi-source inputs,
2. update a shared world state,
3. track commentator state,
4. detect hesitation or intervention opportunities,
5. retrieve relevant context from evolving memory,
6. generate multiple candidate assists,
7. rank them,
8. display only the single best assist.

## Required Agents
The architecture should include these logical agents/modules:

### 1. Transcript Agent
Responsibilities:
- consume commentator transcript
- track pause timing
- detect filler words
- detect repeated phrases
- emit structured speech state

### 2. Co-Host Agent
Responsibilities:
- detect co-host speaking state
- avoid unnecessary interruption
- create co-host follow-up suggestions when useful

### 3. Game State Agent
Responsibilities:
- maintain current score, clock, possession, major events
- track recent sequence of play
- identify high-salience moments

### 4. Vision Agent
Responsibilities:
- analyze sampled frames
- infer coarse visual context
- add visual cues into world state

### 5. Live Feed Agent
Responsibilities:
- ingest social/trending/headline style inputs
- normalize noisy external signals
- add relevant facts to live memory

### 6. Narrative Agent
Responsibilities:
- maintain storylines such as:
  - rivalry
  - momentum swings
  - comeback pressure
  - player spotlight
  - redemption arc
  - defensive collapse
- update current narrative stack

### 7. Hesitation Agent
Responsibilities:
- compute hesitation score
- detect silence after high-salience event
- detect loss of momentum
- decide when help may be useful

### 8. Retrieval Agent
Responsibilities:
- retrieve context from three memory tiers:
  - static memory
  - session memory
  - live memory
- prioritize freshness and relevance

### 9. Supervisor Agent
Responsibilities:
- decide whether to intervene
- choose assist type
- choose urgency
- choose style mode
- route generation requests

### 10. Generator Agent
Responsibilities:
- produce final assist text
- adapt to selected style
- remain concise and useful

### 11. Grounding / Verification Agent
Responsibilities:
- verify supported claims
- attach source chips
- suppress risky unsupported outputs

### 12. Ranking Agent
Responsibilities:
- rank candidate assists
- return only the top one to UI

## Memory Model
The system should use three memory tiers:

### Static Memory
Contains:
- rosters
- player bios
- rivalry history
- historical facts
- evergreen team context

### Session Memory
Contains:
- what has already been said in this commentary session
- recent events from the current clip
- ongoing narratives
- recent assist history

### Live Memory
Contains:
- current match events
- latest frame-derived cues
- social/trending signals
- live contextual updates

## Retrieval Priority
Default retrieval order:
1. Live memory
2. Session memory
3. Static memory

The system should prefer what is freshest and most relevant to the current moment.

## Hesitation Detection Rules (MVP)
The initial MVP can use heuristic hesitation detection:
- silence threshold after high-salience event
- repeated filler words
- unfinished phrase
- repeated phrase patterns
- low speaking momentum
- co-host not currently talking

## Demo UI Requirements
The frontend should feel premium and broadcast-oriented, not like a chatbot.

Required UI elements:
- video/replay panel
- live scoreboard strip
- event timeline
- narrative panel
- hesitation/confidence meter
- active assist card
- source chips
- style mode indicator

## Assist Card Requirements
Each assist card should include:
- assist type
- short assist text
- confidence score
- source chips
- why-now reason

## Style Modes
Support at least two styles:
- Hype mode
- Analyst mode

Optional future style modes:
- calm play-by-play
- dramatic call
- co-host prompt mode

## Demo Flow
The judge demo should show:

### Moment 1
Replay begins, system tracks live state.

### Moment 2
A notable attacking moment develops.
World state and narrative update.

### Moment 3
Commentator hesitates after a key moment.
System surfaces a short assist.

### Moment 4
The assist uses evolving context:
- player fact
- rivalry context
- recent momentum
- optional social or visual cue

### Moment 5
Style mode changes or narrative updates.
System shows that it adapts.

## Non-Negotiables
- Assistive, not replacing the commentator
- Only intervene when needed
- Keep outputs short
- Keep claims grounded
- Make the UI sexy and demoable
- Optimize for reliability over fragile real-time dependencies
- Demo should work using deterministic local data

## What We Are NOT Building
- full production live broadcast infrastructure
- fully autonomous commentary replacement
- custom model training from scratch
- multiple sports for MVP
- perfect computer vision
- brittle dependency on live internet feeds during demo

## Technical Priorities
1. reliable replay/demo
2. live world state updates
3. hesitation detection
4. grounded assist generation
5. clean UI
6. agentic orchestration
7. optional multimodal enrichments

## Success Criteria
The project succeeds if:
- the demo clearly shows multi-stream ingestion
- the system maintains a live evolving world model
- the system detects hesitation at the right moment
- the system surfaces one concise, useful, grounded assist
- the UI feels polished and premium
- the judges understand why this is an AI sidekick, not just a chatbot