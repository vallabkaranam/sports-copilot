# Sports Copilot

Sports Copilot is a broadcaster-facing AI soccer commentator sidekick for a controlled El Clásico replay. It tracks replay state, commentary hesitation, evolving narratives, retrieval context, and visual cues, then surfaces one short grounded assist only when it is useful.

## Stability & Runtime Requirements
- **Node.js**: `v20.x` or later.
- **Core environment**: deterministic local fixtures, no live internet required on the demo path.
- **Current mode**: polished demo-first build with a premium dashboard and test-backed replay logic.

## Local Setup
```bash
npm install
npm run build
npm run test
npm run lint
```

## One-Command Demo Startup
```bash
npm run demo
```

That command starts:
- `apps/api` on `http://localhost:3001`
- `apps/workers` replay loop pointed at the local fixtures
- `apps/web` on `http://localhost:5173`

Open `http://localhost:5173`, then use the control desk to:
- play, pause, and restart the replay
- switch between `analyst` and `hype`
- trigger the manual `force hesitation` backup if needed

## Demo Notes
- The replay is deterministic and runs from local JSON fixtures in [data/demo_match](/Users/vallabkaranam/Desktop/sports-copilot/data/demo_match).
- The dashboard is intentionally broadcast-oriented, not chat-oriented.
- Source chips, hesitation state, narrative stack, recent events, and vision cues all update from the shared world state.

## Verification
```bash
npm run build
npm run test
npm run lint
```

The test suite includes:
- worker unit tests for replay, hesitation, retrieval, assist generation, vision, and session memory
- a deterministic demo run-through test for the key judge moments
- web tests for dashboard render, controls, and assist card appearance

## Repo Layout
- `apps/api`: Fastify orchestration server and control endpoints
- `apps/workers`: replay engine, agents, and demo fixture orchestration
- `apps/web`: Vite/React broadcast dashboard
- `packages/shared-types`: shared Zod contracts across services
- `data/demo_match`: deterministic match, transcript, social, and vision fixtures

## Related Docs
- [DEMO_SCRIPT.md](/Users/vallabkaranam/Desktop/sports-copilot/DEMO_SCRIPT.md)
- [JUDGE_PITCH.md](/Users/vallabkaranam/Desktop/sports-copilot/JUDGE_PITCH.md)
- [KNOWN_LIMITATIONS.md](/Users/vallabkaranam/Desktop/sports-copilot/KNOWN_LIMITATIONS.md)
- [ARCHITECTURE.md](/Users/vallabkaranam/Desktop/sports-copilot/ARCHITECTURE.md)
