import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    globalSetup: ['test/helpers/global-setup.ts'],
    // Oracles and golden tests were recorded with TZ=Europe/Berlin (JS date parsing uses the process time zone)
    env: { TZ: 'Europe/Berlin' },
  },
});
