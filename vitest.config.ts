import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    globalSetup: ['test/helpers/global-setup.ts'],
    // Orakel und Golden-Tests wurden mit TZ=Europe/Berlin aufgezeichnet (JS-Date-Parsing nutzt die Prozess-Zeitzone)
    env: { TZ: 'Europe/Berlin' },
  },
});
