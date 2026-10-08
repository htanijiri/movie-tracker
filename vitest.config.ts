import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テストは Workers のランタイム（workerd）の中で動かし、miniflare 上の実物の D1 を使う。
// 秘密情報はここで固定のダミー値を渡すので、.dev.vars がなくても全テストが通る。
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TMDB_ACCESS_TOKEN: "test-tmdb-token",
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            ALLOWED_EMAILS: "owner@example.com",
            SESSION_SECRET: "test-session-secret-0123456789abcdefghijklmnop",
          },
        },
      }),
    ],
    resolve: {
      tsconfigPaths: true,
    },
    test: {
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
