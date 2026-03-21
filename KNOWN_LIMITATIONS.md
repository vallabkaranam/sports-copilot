# Known Limitations

## Current Demo Constraints
- The core path is deterministic and fixture-driven. It does not yet use live sports APIs, live social feeds, or live ASR.
- Hesitation detection is heuristic. It uses pauses, fillers, repeated phrasing, unfinished lines, and event salience rather than a learned model.
- Vision is simulated through sampled-frame descriptions plus deterministic tag inference, not raw computer vision inference.
- The broadcast dashboard polls local APIs; it is not yet packaged as a production deployment.

## Product Gaps Before Production
- No real user microphone capture or live speech-to-text pipeline yet.
- No real model API calls for generation, ranking, or verification yet.
- No authentication or multi-user session model yet.
- Persistence is local SQLite only; there is no hosted database or user-scoped data separation yet.
- No live external sports feed ingestion or reconciliation against real providers yet.
- No deployment automation, monitoring, or runtime alerting yet.

## Reliability Notes
- Optional social and vision fixtures fail closed to empty arrays so the demo still runs.
- The worker tolerates the API coming online slightly later during startup.
- The critical demo path has no live internet dependency once dependencies are installed.

## Recommended Next Step
After the demo milestone, keep the same agent boundaries and progressively replace deterministic fixtures with:
1. live event and stats APIs
2. live speech input plus transcript streaming
3. real model-backed generation and grounding
4. hosted API and dashboard deployment
