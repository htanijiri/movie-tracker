import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";

import { settleBackgroundTasks } from "~/lib/background.server";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

const testEnv = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  // テストどうしが影響しないよう、毎回すべての行を消す（子テーブルから順に）。
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM user_movies"),
    testEnv.DB.prepare("DELETE FROM movies"),
    testEnv.DB.prepare("DELETE FROM users"),
  ]);

  // テストから外部（TMDb、Google）に実際に通信しないようにする。
  // 通信が必要なテストは、test/helpers の mockFetch で応答を用意する。
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      throw new Error(`テストから外部に通信しようとしました: ${url}`);
    }),
  );
});

afterEach(async () => {
  // 応答のあとに続けている処理が、通信の差し替えを外す前に終わるのを待つ
  // （差し替えを外したあとに動くと、外部に実際に通信してしまうため）。
  await settleBackgroundTasks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
