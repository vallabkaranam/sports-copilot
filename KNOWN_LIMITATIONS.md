# Known Limitations

## Current Product Constraints
- Hesitation and recovery are still hybrid heuristic systems. They use pauses, fillers, repeated phrasing, wake phrases, pace shifts, and transcript stability rather than a learned personalized model.
- Vision is still sampled and coarse. It uses tagged vision cues rather than full raw-video understanding.
- The cue system is grounded, but it is not yet a fully autonomous self-refreshing live RAG stack with dynamic online tool use for every match.
- The system can expose cue provenance, but the explainability layer is still compact and product-facing rather than a full debug trace.

## Product Gaps Before Production
- No authentication or multi-user session model yet.
- No user-specific learned hesitation profile yet.
- No Apple Health or other biometric integration yet.
- No full raw-video state tracker over the last N seconds/minutes of the match yet.
- No general-purpose dynamic fixture resolver in the main product flow yet.
- No robust user document upload plus vectorized context management product flow yet.
- Observability and admin tooling are still minimal compared with a production service.

## Reliability Notes
- Optional context sources fail closed so the booth can still operate.
- The cue path has a grounded local fallback when model-backed generation is unavailable.
- The prompt card now avoids reusing ideas the user has already taken up in recent transcript.
- The live desk remains usable even when optional model or social inputs degrade.

## Recommended Next Step
Keep the same sidekick architecture and expand it in this order:
1. dynamic fixture resolution and stronger live context refresh
2. richer rolling game-state memory
3. optional user-consented extra sensing like biometrics
4. user-uploaded context / RAG management
5. deeper explainability and orchestration traces
