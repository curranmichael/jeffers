/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Keep the config minimal and let Vitest use its defaults,
// hopefully picking up tsconfig.test.json automatically.
export default defineConfig(async () => {
  const { default: tsconfigPaths } = await import('vite-tsconfig-paths');
  
  return {
    plugins: [
      react(),
      tsconfigPaths(),
    ],
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./test-setup/electron-mocks.ts'],
      // Remove explicit tsconfig references here
      // Let Vitest discover tsconfig.test.json
      testTimeout: 900000, // 15 minutes default timeout
      hookTimeout: 30000, // 30 seconds for hooks
      include: ['**/*.test.{ts,tsx}'],
      exclude: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '.storybook/**'],
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error', // Only show errors in tests by default
      },
    },
    // Remove esbuild override
  };
});
