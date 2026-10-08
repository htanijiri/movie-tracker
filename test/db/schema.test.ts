import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("データベースの構造", () => {
  it("マイグレーションを適用すると、3つのテーブルができる", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["movies", "user_movies", "users"]));
  });

  it("同じ利用者が同じ映画を2行持てない", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, google_sub, email, created_at) VALUES ('u1', 's1', 'a@example.com', '2026-01-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO movies (tmdb_id, title, fetched_at) VALUES (1, '映画A', '2026-01-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO user_movies (id, user_id, tmdb_id, status, created_at, updated_at) VALUES ('m1', 'u1', 1, 'WANT_TO_WATCH', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ),
    ]);
    await expect(
      env.DB.prepare(
        "INSERT INTO user_movies (id, user_id, tmdb_id, status, created_at, updated_at) VALUES ('m2', 'u1', 1, 'SKIPPED', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("定義にない状態や、範囲外の評価は保存できない", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, google_sub, email, created_at) VALUES ('u1', 's1', 'a@example.com', '2026-01-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO movies (tmdb_id, title, fetched_at) VALUES (1, '映画A', '2026-01-01T00:00:00.000Z')",
      ),
    ]);
    await expect(
      env.DB.prepare(
        "INSERT INTO user_movies (id, user_id, tmdb_id, status, created_at, updated_at) VALUES ('m1', 'u1', 1, 'UNKNOWN', 'x', 'x')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO user_movies (id, user_id, tmdb_id, status, rating, created_at, updated_at) VALUES ('m1', 'u1', 1, 'WATCHED', 6, 'x', 'x')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});
