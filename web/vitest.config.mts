import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { include: ['src/**/*.test.{ts,tsx}'], env: { JWT_SECRET: 'x'.repeat(40), SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x' } },
});
