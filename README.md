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
5. Set the Render API env from [`.env.deployment.example`](/Users/vallabkaranam/Desktop/sports-copilot/.env.deployment.example): `OPENAI_API_KEY`, `SUPABASE_URL`, `DATABASE_URL`, and the OpenAI model/runtime vars
6. Set the Render worker env from [`.env.deployment.example`](/Users/vallabkaranam/Desktop/sports-copilot/.env.deployment.example): `API_BASE_URL`, `SPORTMONKS_API_TOKEN`, `SPORTMONKS_FIXTURE_ID`, and the Bluesky vars

## Local Env

Create one repo-root `.env` file:

```bash
VITE_API_BASE_URL=http://localhost:3001
API_BASE_URL=http://localhost:3001
OPENAI_API_KEY=your_openai_api_key
SUPABASE_URL=https://ivynnjycdyrjbaotjzkx.supabase.co
DATABASE_URL=postgresql://postgres:your_database_password@db.ivynnjycdyrjbaotjzkx.supabase.co:5432/postgres
SPORTMONKS_API_TOKEN=your_sportmonks_token
SPORTMONKS_FIXTURE_ID=your_fixture_id
BLUESKY_SOCIAL_ENABLED=true
```

Notes:
- [`.env.example`](/Users/vallabkaranam/Desktop/sports-copilot/.env.example) is the source-of-truth template for teammates
- the full live stack expects OpenAI, Postgres, Sportmonks, and Bluesky to all be configured explicitly
- the worker now exposes a `/health` endpoint so Render can keep it as a web service
- the API now respects the host platform `PORT`
- booth session persistence now uses hosted Postgres whenever `DATABASE_URL` is present, and falls back to local SQLite only when no database is configured

## Demo Notes
- The replay is deterministic and runs from local JSON fixtures in [data/demo_match](/Users/vallabkaranam/Desktop/sports-copilot/data/demo_match).
- The current landing screen is a practice-first booth for testing hesitation on arbitrary local clips.
- The browser booth mode is local-first: clip loading is done from your machine, pause detection uses live mic activity, and transcript text now comes from the API-backed OpenAI realtime transcription path over WebRTC.
- Booth sessions and analytics now persist to hosted Postgres when `DATABASE_URL` is configured, or to local SQLite at `data/app/sports-copilot.sqlite` as a fallback.
- The live operator surface hides prematch/retrieval context by default; that context now lives in `Show Details` so it can still power later hint generation without crowding the booth.
- Live booth assists only surface when the interpreted booth state says the commentator actually needs help; stored world/retrieval context is still used to shape the assist itself.
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
