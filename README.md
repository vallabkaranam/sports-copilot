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

## One-Command Startup
```bash
npm run demo
```

That command starts:
- `apps/api` on `http://localhost:3001`
- `apps/workers` replay loop pointed at the local fixtures
- `apps/web` on `http://localhost:5173`

Open the web URL Vite prints, then use the practice booth to:
- load a local replay clip
- start the broadcast
- speak over the clip to test hesitation tracking
- leave pauses, use fillers, or restart phrases to trigger assists

## Quick Free Deployment
- `Vercel` for [apps/web](/Users/vallabkaranam/Desktop/sports-copilot/apps/web)
- `Render` free web service for [apps/api](/Users/vallabkaranam/Desktop/sports-copilot/apps/api)
- `Render` free web service for [apps/workers](/Users/vallabkaranam/Desktop/sports-copilot/apps/workers)

Deployment files already in the repo:
- [vercel.json](/Users/vallabkaranam/Desktop/sports-copilot/vercel.json)
- [render.yaml](/Users/vallabkaranam/Desktop/sports-copilot/render.yaml)
- [.env.deployment.example](/Users/vallabkaranam/Desktop/sports-copilot/.env.deployment.example)

Recommended hosted setup:
1. Create the `sports-copilot-api` service from [render.yaml](/Users/vallabkaranam/Desktop/sports-copilot/render.yaml)
2. Create the `sports-copilot-worker` service from [render.yaml](/Users/vallabkaranam/Desktop/sports-copilot/render.yaml)
3. Set `API_BASE_URL` on the worker to your Render API URL, for example `https://sports-copilot-api.onrender.com`
4. Deploy the repo to Vercel with `VITE_API_BASE_URL` set to that same Render API URL
5. Set `OPENAI_API_KEY` on the Render API service if you want server-side hesitation interpretation enabled

## Local Env

Create `.env.local` in the repo root for server-side secrets:

```bash
OPENAI_API_KEY=your_openai_api_key
```

Notes:
- the worker now exposes a `/health` endpoint so Render can keep it as a web service
- the API now respects the host platform `PORT`
- booth session persistence is still local SQLite, so on free hosted platforms it should be treated as ephemeral until we move it to Postgres

## Demo Notes
- The replay is deterministic and runs from local JSON fixtures in [data/demo_match](/Users/vallabkaranam/Desktop/sports-copilot/data/demo_match).
- The current landing screen is a practice-first booth for testing hesitation on arbitrary local clips.
- The browser booth mode is local-first: clip loading is done from your machine, pause detection uses live mic activity, and transcript text uses in-browser speech recognition when available.
- Booth sessions and analytics are now persisted locally in SQLite at `data/app/sports-copilot.sqlite`.
- Chrome or Edge currently give the best microphone support for the live booth flow.
- Deterministic fixtures still exist in the repo for the original demo path, but the next work phase is replacing the primary path with real free-input integrations.

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
