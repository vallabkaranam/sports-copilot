# Demo Validation

This guide is the runtime validation pass for the two live booth engines:
- hesitation detection
- cue / hint generation

Use it to classify each behavior as:
- `working as intended`
- `working but degraded`
- `not working`

## Preconditions

Start the app:

```bash
npm run demo
```

Open the web app on the Vite URL and confirm:
- the Barca preset feed is visible or selectable
- the microphone can be enabled
- `Go live` is clickable once the preset is loaded

Optional:
- set `OPENAI_API_KEY` if you want to validate model-generated cue replacement

## Test Matrix

### 1. Startup and session entry

Verify:
- the Barca preset feed loads automatically or can be selected manually
- `Go live` becomes clickable with the preset loaded
- microphone enable works without blocking session start
- the session enters a live state with transcript or mic activity visible

Pass if:
- you can start a live session without uploading a separate clip
- no blocking error prevents the booth from entering live mode

Record:
- status: Passed
- notes: Able to start live session without uploading a seperate clip.

### 2. Hesitation surfacing

Verify:
- after a deliberate pause, the cue card appears immediately
- the cue card does not wait silently for the model response
- if a model cue arrives later, it can refine or replace the fallback

Pass if:
- every clear hesitation produces a visible card within roughly one pause window
- there is no dead-air state where a hesitation is detected but no card appears

Record:
- status:
- notes:

### 3. Transcript-sensitive cue behavior

Run these three speaking scripts in order. Pause after each line and inspect the next cue.

1. Social angle:
   `Fans are really reacting to that save...`
2. Stats angle:
   `The numbers tell you Barcelona have more possession...`
3. Live-play angle:
   `That save changes the whole sequence...`

Pass if:
- the social line produces a socially framed cue
- the stats line produces a stat-led cue
- the play/save line produces a live-moment cue
- the cue does not keep repeating the same fan-reaction framing across all three

Record:
- social:
- stats:
- live play:

### 4. Degraded-path behavior

Test these degraded cases:
- missing or invalid `OPENAI_API_KEY`
- backend temporarily unavailable
- sparse retrieval or sparse social data

Pass if:
- hesitation still produces a local fallback cue
- the session remains usable
- failures degrade gracefully instead of hiding the cue card

Record:
- no key:
- backend degraded:
- sparse data:

### 5. Data-source grounding

Check whether cue inputs can come from:
- pre-match context
- live match facts
- social posts
- recent events

Verify by:
- reading the visible cue text
- opening browser DevTools -> `Network`
- filtering for `/booth/generate-cue`
- comparing the request payload and response

Pass if:
- the top `retrieval.supportingFacts` change with the current transcript
- the facts are not always social-first
- when data is sparse, the fallback path still produces a grounded cue

Record:
- status:
- notes:

## Manual App Pass

Run one live pass in the app:
- start with the preset feed
- go live
- run the three topic scripts
- after each pause, record:
  - did hesitation surface
  - what cue type appeared
  - did it feel topic-matched
  - did it look fallback-driven or model-like

Recommended result table:

| Scenario | Cue surfaced | Cue type matched topic | Felt fallback or model | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Startup |  |  |  |  |  |
| Hesitation surfacing |  |  |  |  |  |
| Social script |  |  |  |  |  |
| Stats script |  |  |  |  |  |
| Live-play script |  |  |  |  |  |
| No OpenAI key |  |  |  |  |  |
| Sparse data |  |  |  |  |  |

## DevTools Pass

Open browser DevTools and inspect the live cue path:
- filter for `/booth/generate-cue`
- for each request, compare:
  - current transcript or query
  - top `supportingFacts`
  - returned cue text

Use failures to classify the problem layer:
- `startup`
- `hesitation surfacing`
- `fact ranking`
- `model response`
- `UI replacement`

## Acceptance Checklist

A validation cycle is successful if all of these are true:
- preset feed can start a live session
- every deliberate hesitation shows a cue card
- cue topic changes between social, stats, and live-play prompts
- missing model or backend support still leaves a visible fallback cue
- model request facts track the current transcript instead of reusing one static fact set

## Current Assumptions

- this guide targets the current `main`-derived cue pipeline, which uses `/booth/generate-cue`
- the Barca preset feed is the primary demo path for this pass
- visible runtime behavior is the source of truth for success, not unit tests alone
- if a case fails, classify it by the failing layer before changing code
