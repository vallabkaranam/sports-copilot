# Sports Copilot

An AI sports commentator sidekick.

## Stability & Runtime Requirements
- **Node.js**: `v20.x` or later (required).
- **Core Environment**: This repository targets Node 20+ features.
- **Node 16 Support**: A temporary `polyfill.cjs` is provided for backward compatibility where `crypto.webcrypto` is required.

## Quick Start
```bash
npm install
npm run build
npm run test
npm run lint
```

## Architecture
- `apps/api`: Fastify-based orchestration server.
- `apps/workers`: Replay engine and agent workers.
- `apps/web`: Vite/React-based broadcast dashboard.
- `packages/shared-types`: Shared Zod contracts.
