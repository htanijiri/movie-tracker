import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { getDb } from "~/lib/db/client.server";
import { refreshStaleSnapshots } from "~/lib/db/movies.server";
import { userMovies } from "~/lib/db/schema";

import { createMovie, createUser, mockFetch } from "../helpers/app";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

// TMDb の利用条件（データを6か月を超えて保持しない）を守るための、古い情報の整理。
describe("古くなったスナップショットの整理", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z");
  const FRESH = "2026-05-20T00:00:00.000Z"; // 12日前
  const STALE = "2026-04-01T00:00:00.000Z"; // 61日前

  const register = async (userId: string, tmdbId: number) =>
    getDb().insert(userMovies).values({
      id: crypto.randomUUID(),
      userId,
      tmdbId,
      status: "WANT_TO_WATCH",
      preferredMedium: "STREAMING",
      createdAt: FRESH,
      updatedAt: FRESH,
    });

  const snapshots = async () =>
    (
      await env.DB.prepare("SELECT tmdb_id, title, fetched_at FROM movies ORDER BY tmdb_id").all<{
        tmdb_id: number;
        title: string;
        fetched_at: string;
      }>()
    ).results;

  it("誰のリストにも入っていない古い情報は消す。新しい情報は消さない", async () => {
    await createMovie({ tmdbId: 1, fetchedAt: STALE });
    await createMovie({ tmdbId: 2, fetchedAt: FRESH });
    const fetchMock = mockFetch(() => Response.json(tmdbDetail(1)));

    expect(await refreshStaleSnapshots(getDb(), NOW)).toBe(0);

    expect((await snapshots()).map((m) => m.tmdb_id)).toEqual([2]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("リストに入っている映画の古い情報は、TMDb から取り直す", async () => {
    const user = await createUser();
    await createMovie({ tmdbId: 1, title: "古いタイトル", fetchedAt: STALE });
    await register(user.id, 1);
    mockFetch(() => Response.json(tmdbDetail(1, { title: "新しいタイトル" })));

    expect(await refreshStaleSnapshots(getDb(), NOW)).toBe(1);

    const [movie] = await snapshots();
    expect(movie.title).toBe("新しいタイトル");
    expect(movie.fetched_at > STALE).toBe(true);
  });

  it("新しい情報は取り直さない", async () => {
    const user = await createUser();
    await createMovie({ tmdbId: 1, fetchedAt: FRESH });
    await register(user.id, 1);
    const fetchMock = mockFetch(() => Response.json(tmdbDetail(1)));
    expect(await refreshStaleSnapshots(getDb(), NOW)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("1回に取り直すのは、古い順に3本まで", async () => {
    const user = await createUser();
    for (let id = 1; id <= 5; id++) {
      await createMovie({ tmdbId: id, fetchedAt: `2026-03-0${6 - id}T00:00:00.000Z` });
      await register(user.id, id);
    }
    const called: number[] = [];
    mockFetch((url) => {
      const id = Number(url.pathname.split("/").pop());
      called.push(id);
      return Response.json(tmdbDetail(id));
    });

    expect(await refreshStaleSnapshots(getDb(), NOW)).toBe(3);
    // 取得した日時が古いもの（ID の大きいもの）から。
    expect(called).toEqual([5, 4, 3]);
  });

  it("TMDb から消えた映画は、行を残したまま確認した日時だけ更新し、ほかの映画の取り直しを続ける", async () => {
    const user = await createUser();
    await createMovie({ tmdbId: 1, title: "消えた映画", fetchedAt: "2026-03-01T00:00:00.000Z" });
    await createMovie({ tmdbId: 2, title: "古いタイトル", fetchedAt: "2026-03-02T00:00:00.000Z" });
    await register(user.id, 1);
    await register(user.id, 2);
    mockFetch((url) =>
      url.pathname.endsWith("/1")
        ? Response.json({ status_code: 34 }, { status: 404 })
        : Response.json(tmdbDetail(2, { title: "新しいタイトル" })),
    );

    expect(await refreshStaleSnapshots(getDb(), NOW)).toBe(1);

    const [gone, other] = await snapshots();
    expect(gone).toMatchObject({ title: "消えた映画", fetched_at: NOW.toISOString() });
    expect(other.title).toBe("新しいタイトル");
  });

  it("TMDb が応答できないときは、そこでやめる。情報は消さない", async () => {
    const user = await createUser();
    for (const id of [1, 2]) {
      await createMovie({ tmdbId: id, fetchedAt: STALE });
      await register(user.id, id);
    }
    const fetchMock = mockFetch(() => new Response("error", { status: 503 }));

    expect(await refreshStaleSnapshots(getDb(), NOW)).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await snapshots()).toHaveLength(2);
  });
});
