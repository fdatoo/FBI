import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e/quantico',
  timeout: 120_000,
  fullyParallel: false, // shared FBI server
  retries: 0,
  // Warm the orchestrator's docker image cache before any tests run.
  // Without this, the first 1-2 tests on a fresh CI runner race a 2-3 min
  // image build and fail their tight assertions.
  globalSetup: './tests/e2e/quantico/global-setup.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'gleam run',
    cwd: 'src/server',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: '3100',
      DATABASE_PATH: '/tmp/fbi-e2e.db',
      RUNS_DIR: '/tmp/fbi-e2e-runs',
      SECRETS_KEY_FILE: '/tmp/fbi-e2e.key',
      WEB_DIST_DIR: `${process.cwd()}/dist/web`,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      FBI_QUANTICO_BINARY_PATH: process.env.FBI_QUANTICO_BINARY_PATH
        ?? `${process.cwd()}/dist/cli/quantico-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
    },
  },
});
