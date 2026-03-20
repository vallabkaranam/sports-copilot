import { defineConfig } from 'vitest/config';
import { webcrypto } from 'node:crypto';

// Polyfill for Node 16 compatibility with Vitest/Vite
if (!global.crypto) {
  (global as any).crypto = webcrypto;
}


export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
