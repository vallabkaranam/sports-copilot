# Sports Copilot

Sports Copilot, branded in-product as AndOne, is a broadcaster-facing AI sidekick for live commentary. It watches the evolving moment, senses hesitation and recovery, keeps a rolling context stack fresh, and surfaces one short grounded prompt only when it is useful.

## Stability & Runtime Requirements
- **Node.js**: `v20.x` or later.
- **Current mode**: sidekick-first booth with real cue generation, hesitation sensing, session persistence, and review flows.
- **Demo reliability**: replay and worker loops still keep the demo stable even when optional live sources are thin.

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
- leave pauses, use fillers, restart phrases, or use the wake phrase to trigger assists

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
5. Set the Render API env from [`.env.deployment.example`](/Users/vallabkaranam/Desktop/sports-copilot/.env.deployment.example): `OPENAI_API_KEY`, `DATABASE_URL`, and the OpenAI model/runtime vars
6. Set the Render worker env from [`.env.deployment.example`](/Users/vallabkaranam/Desktop/sports-copilot/.env.deployment.example): `API_BASE_URL`, `SPORTMONKS_API_TOKEN`, `BLUESKY_SOCIAL_ENABLED`, `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`, and `BLUESKY_SERVICE_URL`

## Local Env

Create one repo-root `.env` file:

```bash
VITE_API_BASE_URL=http://localhost:3001
API_BASE_URL=http://localhost:3001
OPENAI_API_KEY=your_openai_api_key
DATABASE_URL=postgresql://postgres.your_project_ref:your_database_password@your_supabase_pooler_host:5432/postgres
SPORTMONKS_API_TOKEN=your_sportmonks_token
BLUESKY_SOCIAL_ENABLED=false
BLUESKY_IDENTIFIER=your_bluesky_handle
BLUESKY_APP_PASSWORD=your_bluesky_app_password
BLUESKY_SERVICE_URL=https://bsky.social
AND_ONE_PRESET_BARCA_PATH=/absolute/path/to/custom-barca-preset.mp4
AND_ONE_PRESET_RANGERS_PATH=/absolute/path/to/custom-rangers-preset.mp4
```

Notes:
- [`.env.example`](/Users/vallabkaranam/Desktop/sports-copilot/.env.example) is the source-of-truth template for teammates
- the full live stack expects OpenAI, Postgres, and Sportmonks to be configured explicitly
- `OPENAI_API_KEY` and `DATABASE_URL` belong to the API service
- `SPORTMONKS_API_TOKEN` should also be available to the API if you want dynamic fixture resolution from the live feed
- repo-backed preset clips now live in [data/preset_feeds](/Users/vallabkaranam/Desktop/sports-copilot/data/preset_feeds) and work out of the box
- `AND_ONE_PRESET_BARCA_PATH` and `AND_ONE_PRESET_RANGERS_PATH` are optional API overrides if you want to point the preset channels at different files
- `API_BASE_URL`, `SPORTMONKS_*`, and all `BLUESKY_*` vars belong to the worker service
- the API now fails fast on startup if `OPENAI_API_KEY` or `DATABASE_URL` are missing
- the API now also fails fast if the `DATABASE_URL` hostname does not resolve, with a specific hint when the host looks like a stale Supabase DB hostname
- the worker now fails fast on startup if `API_BASE_URL` or `SPORTMONKS_API_TOKEN` are missing
- fixture selection now comes from the live feed resolver writing `activeFixtureId` into the shared controls state
- the repo-root `.env` is now loaded for both workspace dev servers and built runtime entrypoints
- Bluesky social ingest is now explicit opt-in through `BLUESKY_SOCIAL_ENABLED=true`; leave it off until you have a working live source strategy
- the worker now exposes a `/health` endpoint so Render can keep it as a web service
- the API now respects the host platform `PORT`
- booth session persistence is expected to use hosted Postgres via `DATABASE_URL` on the live stack
- use the current Supabase session pooler connection string from the dashboard for hosted deploys; avoid the direct `db.<project-ref>.supabase.co` host on platforms that do not support the IPv6 path cleanly

## What The System Is
- a quiet sidekick, not an auto-commentator
- an orchestrated system with specialist signal, context, cue, grounding, and review layers
- a live desk experience designed to stay out of the way until confidence drops

## Demo Notes
- The replay is deterministic and runs from local JSON fixtures in [data/demo_match](/Users/vallabkaranam/Desktop/sports-copilot/data/demo_match).
- The current landing screen is a practice-first booth for testing hesitation on arbitrary local clips.
- The browser booth mode is local-first: clip loading is done from your machine, pause detection uses live mic activity, and transcript text comes from the API-backed OpenAI transcription path.
- Booth sessions and analytics on the app path persist to Postgres through `DATABASE_URL`.
- Live booth assists only surface when the booth state says the commentator actually needs help.
- Cue generation can blend pre-match context, live match facts, recent events, social pulse, context bundle items, transcript thread, and sampled vision cues.
- The prompt card now includes a compact `Why this cue` reveal so the demo can show grounding without overwhelming the main cue.
- Chrome or Edge currently give the best microphone support for the live booth flow.
- Deterministic fixtures still exist for demo reliability, but the product framing is now a live adaptive sidekick rather than a fixed replay dashboard.
- Use [DEMO_VALIDATION.md](/Users/farzaann1/Desktop/sports-copilot/DEMO_VALIDATION.md) for the manual runtime pass that checks hesitation surfacing, cue topic changes, and degraded behavior in the live app.

## Verification
```bash
npm run build
npm run test
npm run lint
```

The test suite includes:
- worker unit tests for replay, hesitation, retrieval, assist generation, vision, and session memory
- web tests for hesitation surfacing, cue grounding behavior, transcript-sensitive cue changes, and live desk behavior
- deterministic demo validation artifacts for the key judge moments

## Repo Layout
- `apps/api`: Fastify orchestration server, persistence, and model-backed interpretation / cue / review endpoints
- `apps/workers`: replay loop, context-refresh layers, and world-state updates
- `apps/web`: Vite/React live desk and archive UI
- `packages/shared-types`: shared Zod contracts across services
- `data/demo_match`: deterministic match, transcript, social, and vision fixtures

## Related Docs
- [DEMO_SCRIPT.md](/Users/vallabkaranam/Desktop/sports-copilot/DEMO_SCRIPT.md)
- [JUDGE_PITCH.md](/Users/vallabkaranam/Desktop/sports-copilot/JUDGE_PITCH.md)
- [KNOWN_LIMITATIONS.md](/Users/vallabkaranam/Desktop/sports-copilot/KNOWN_LIMITATIONS.md)
- [ARCHITECTURE.md](/Users/vallabkaranam/Desktop/sports-copilot/ARCHITECTURE.md)
- [DEMO_VALIDATION.md](/Users/farzaann1/Desktop/sports-copilot/DEMO_VALIDATION.md)
