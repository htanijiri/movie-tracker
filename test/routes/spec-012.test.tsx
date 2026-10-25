import { describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { userMovies } from "~/lib/db/schema";
import {
  buildTasteProfile,
  recordWeight,
  scoreCandidates,
  type TasteRecord,
} from "~/lib/recommend.server";
import { TMDB_ERROR_MESSAGE } from "~/lib/site";
import Search, { loader } from "~/routes/search";

import { createMovie, createUser, mockFetch, ORIGIN, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail, tmdbList, tmdbMovie } from "../helpers/tmdb-fixtures";

// 仕様書 012：映画のおすすめ。ジャンル ID は TMDb のもの（878=SF、27=ホラー、18=ドラマ、35=コメディ）。

const SF = 878;
const HORROR = 27;
const DRAMA = 18;
const COMEDY = 35;

const record = (over: Partial<TasteRecord>): TasteRecord => ({
  tmdbId: 1,
  title: "映画",
  status: "WATCHED",
  preferredMedium: null,
  rating: null,
  genreIds: [],
  ...over,
});

describe("好みの計算（仕様書 012）", () => {
  it("記録ごとの重み：★5=+2 … ★1=−2、★なし=+0.5、見たい=+1、見送り=−1（AC3）", () => {
    expect(recordWeight({ status: "WATCHED", preferredMedium: null, rating: 5 })).toBe(2);
    expect(recordWeight({ status: "WATCHED", preferredMedium: null, rating: 4 })).toBe(1);
    expect(recordWeight({ status: "WATCHED", preferredMedium: null, rating: 3 })).toBe(0);
    expect(recordWeight({ status: "WATCHED", preferredMedium: null, rating: 2 })).toBe(-1);
    expect(recordWeight({ status: "WATCHED", preferredMedium: null, rating: 1 })).toBe(-2);
    expect(recordWeight({ status: "WATCHED", preferredMedium: null, rating: null })).toBe(0.5);
    expect(recordWeight({ status: "WANT_TO_WATCH", preferredMedium: "THEATER", rating: null })).toBe(1);
    expect(recordWeight({ status: "WANT_TO_WATCH", preferredMedium: "STREAMING", rating: null })).toBe(1);
    expect(recordWeight({ status: "SKIPPED", preferredMedium: "NONE", rating: null })).toBe(-1);
  });

  it("ジャンルごとに重みを足し合わせ、★4以上で最も★の高い映画を理由用に覚える", () => {
    const profile = buildTasteProfile([
      record({ tmdbId: 1, title: "映画A", rating: 5, genreIds: [SF, DRAMA] }),
      record({ tmdbId: 2, title: "映画B", rating: 4, genreIds: [SF] }),
      record({ tmdbId: 3, title: "映画C", status: "SKIPPED", preferredMedium: "NONE", genreIds: [HORROR] }),
      record({ tmdbId: 4, title: "映画D", rating: 3, genreIds: [COMEDY] }), // 重み0は手がかりにしない
      record({ tmdbId: 5, title: "映画E", rating: 5, genreIds: null }), // ジャンル不明も手がかりにしない
    ]);
    expect(profile.signals).toBe(3);
    expect(profile.genres.get(SF)).toEqual({ weight: 3, best: { title: "映画A", rating: 5 } });
    expect(profile.genres.get(DRAMA)).toEqual({ weight: 2, best: { title: "映画A", rating: 5 } });
    expect(profile.genres.get(HORROR)).toEqual({ weight: -1, best: null });
    expect(profile.genres.has(COMEDY)).toBe(false);
  });

  const profile = buildTasteProfile([
    record({ tmdbId: 1, title: "映画A", rating: 5, genreIds: [SF] }),
    record({ tmdbId: 2, title: "映画B", rating: 4, genreIds: [DRAMA] }),
    record({ tmdbId: 3, title: "映画C", status: "SKIPPED", preferredMedium: "NONE", genreIds: [HORROR] }),
  ]);
  const candidate = (tmdbId: number, genreIds: number[], popularity = 10) => ({
    tmdbId,
    title: `候補${tmdbId}`,
    originalTitle: null,
    releaseDate: null,
    posterPath: null,
    genreIds,
    popularity,
  });

  it("好きなジャンルの作品が上、苦手なジャンルの作品が下になる（AC3）", () => {
    const ranked = scoreCandidates(
      [candidate(10, [HORROR], 99), candidate(11, [COMEDY], 50), candidate(12, [SF], 1), candidate(13, [DRAMA], 1)],
      profile,
      new Map(),
      new Set(),
    );
    expect(ranked.map((r) => r.tmdbId)).toEqual([12, 13, 11, 10]);
  });

  it("ジャンルが多い作品が有利になりすぎない（ジャンル数の平方根で割る）", () => {
    const ranked = scoreCandidates(
      [candidate(10, [SF, COMEDY, HORROR, 99, 36]), candidate(11, [SF])],
      profile,
      new Map(),
      new Set(),
    );
    expect(ranked[0].tmdbId).toBe(11);
  });

  it("関連作品に含まれる候補は加点し、理由を「「映画A」（★5）の関連作品」にする（AC4・AC5）", () => {
    // 関連作品の加点（+2）は、★4の映画と同じジャンル（+1）より大きい。
    const ranked = scoreCandidates(
      [candidate(10, [DRAMA]), candidate(11, [COMEDY])],
      profile,
      new Map([[11, [{ title: "映画A", rating: 5 }]]]),
      new Set(),
    );
    expect(ranked[0]).toMatchObject({ tmdbId: 11, reason: "「映画A」（★5）の関連作品" });
  });

  it("理由は、関連作品 → 同じジャンルの★の高い映画の順。根拠がなければ出さない（AC5）", () => {
    const ranked = scoreCandidates(
      [candidate(10, [SF, DRAMA]), candidate(11, [DRAMA]), candidate(12, [COMEDY]), candidate(13, [HORROR])],
      profile,
      new Map(),
      new Set(),
    );
    const reasons = Object.fromEntries(ranked.map((r) => [r.tmdbId, r.reason]));
    expect(reasons[10]).toBe("★5の「映画A」と同じ「SF」");
    expect(reasons[11]).toBe("★4の「映画B」と同じ「ドラマ」");
    expect(reasons[12]).toBeNull();
    expect(reasons[13]).toBeNull();
  });

  it("自分のリストにある映画と、重複した候補は除く（AC6）", () => {
    const ranked = scoreCandidates(
      [candidate(10, [SF]), candidate(10, [SF]), candidate(1, [SF])],
      profile,
      new Map(),
      new Set([1]),
    );
    expect(ranked.map((r) => r.tmdbId)).toEqual([10]);
  });
});

describe("おすすめの画面（/search?tab=recommend）", () => {
  type Insert = typeof userMovies.$inferInsert;
  async function add(user: SessionUser, tmdbId: number, rec: Partial<Insert>, genreIds: number[] | null = [SF]) {
    await createMovie({ tmdbId, title: `映画${tmdbId}`, genreIds });
    await getDb().insert(userMovies).values({
      id: crypto.randomUUID(),
      userId: user.id,
      tmdbId,
      status: "WATCHED",
      watchedAt: "2026-01-01",
      watchedMedium: "THEATER",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...rec,
    });
  }

  /** TMDb の応答を、エンドポイントごとに返す。呼ばれた URL を記録する。 */
  function mockTmdb(options: {
    candidates?: unknown[];
    related?: Record<number, unknown[]>;
    fail?: boolean;
  } = {}) {
    const calls: URL[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (options.fail) return new Response("error", { status: 500 });
      const related = /\/3\/movie\/(\d+)\/recommendations$/.exec(url.pathname);
      if (related) return Response.json(tmdbList(options.related?.[Number(related[1])] ?? []));
      const detail = /\/3\/movie\/(\d+)$/.exec(url.pathname);
      if (detail) return Response.json(tmdbDetail(Number(detail[1]), { genres: [{ id: HORROR, name: "ホラー" }] }));
      return Response.json(tmdbList(options.candidates ?? [], { page: Number(url.searchParams.get("page")), totalPages: 5 }));
    });
    return calls;
  }

  const load = (user: SessionUser, query: string) =>
    loader(routeArgs({ url: `${ORIGIN}/search?tab=recommend${query}`, user }));

  async function seedTaste(user: SessionUser) {
    await add(user, 1, { rating: 5 }, [SF]);
    await add(user, 2, { rating: 4 }, [DRAMA]);
    await add(user, 3, { status: "SKIPPED", preferredMedium: "NONE", watchedAt: null, watchedMedium: null }, [HORROR]);
  }

  it("タブに「おすすめ」が出る。既定は「劇場で公開中」「すべて」。不正な値は既定値にする（AC1）", async () => {
    const user = await createUser();
    mockTmdb();
    const data = await load(user, "&source=xxx&lang=yyy");
    expect(data.recommend).toMatchObject({ source: "theater", lang: "all" });
    const html = renderRoute(Search, { path: "/search", loaderData: data });
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>おすすめ/);
    expect(html).toContain("劇場で公開中");
    expect(html).toContain("配信中");
    expect(html).toContain("邦画");
    expect(html).toContain("洋画");
  });

  it("劇場で公開中は now_playing を3ページ、配信中は日本の見放題・無料の discover を3ページ取得する（AC2）", async () => {
    const user = await createUser();
    let calls = mockTmdb();
    await load(user, "");
    expect(calls.filter((u) => u.pathname === "/3/movie/now_playing").map((u) => u.searchParams.get("page")).sort()).toEqual(["1", "2", "3"]);
    expect(calls.every((u) => u.searchParams.get("region") === "JP" || u.pathname !== "/3/movie/now_playing")).toBe(true);

    calls = mockTmdb();
    await load(user, "&source=streaming&lang=ja");
    const discover = calls.filter((u) => u.pathname === "/3/discover/movie");
    expect(discover).toHaveLength(3);
    expect(discover[0].searchParams.get("watch_region")).toBe("JP");
    expect(discover[0].searchParams.get("with_watch_monetization_types")).toBe("flatrate|free|ads");
    expect(discover[0].searchParams.get("vote_count.gte")).toBe("30");
    expect(discover[0].searchParams.get("with_original_language")).toBe("ja");
  });

  it("邦画・洋画の絞り込みは、原語で絞る（AC2）", async () => {
    const user = await createUser();
    const candidates = [
      tmdbMovie(10, { original_language: "ja", genre_ids: [SF] }),
      tmdbMovie(11, { original_language: "en", genre_ids: [SF] }),
    ];
    mockTmdb({ candidates });
    expect((await load(user, "&lang=ja")).results.map((r) => r.tmdbId)).toEqual([10]);
    mockTmdb({ candidates });
    expect((await load(user, "&lang=foreign")).results.map((r) => r.tmdbId)).toEqual([11]);
  });

  it("好みに合う順に並び、理由が出る。自分のリストにある映画は出ない（AC3〜AC6）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await seedTaste(me);
    await add(other, 20, { rating: 5 }, [HORROR]); // 他の利用者の記録は影響しない
    const calls = mockTmdb({
      candidates: [
        tmdbMovie(20, { genre_ids: [HORROR], popularity: 90 }),
        tmdbMovie(21, { genre_ids: [COMEDY], popularity: 80 }),
        tmdbMovie(22, { genre_ids: [SF], popularity: 10 }),
        tmdbMovie(1, { genre_ids: [SF], popularity: 99 }), // 自分のリストにある
      ],
      related: { 2: [tmdbMovie(21)] },
    });

    const data = await load(me, "");
    expect(data.recommend?.coldStart).toBe(false);
    // 22（★5の映画と同じSF：+2）と 21（関連作品：+2）は同点で、人気の高い 21 が先。苦手なホラーの 20 は最後。
    expect(data.results.map((r) => r.tmdbId)).toEqual([21, 22, 20]);
    expect(data.results.map((r) => r.reason)).toEqual([
      "「映画2」（★4）の関連作品",
      "★5の「映画1」と同じ「SF」",
      null,
    ]);
    // 関連作品は、★4以上の見た映画（★の高い順に3本まで）について取得する。
    expect(calls.filter((u) => u.pathname.endsWith("/recommendations")).map((u) => u.pathname).sort()).toEqual([
      "/3/movie/1/recommendations",
      "/3/movie/2/recommendations",
    ]);

    const html = renderRoute(Search, { path: "/search", loaderData: data });
    expect(html).toContain("★5の「映画1」と同じ「SF」");
    expect(html).toContain("好みに合いそうな順");
    expect(html).not.toContain("もっと見る");
  });

  it("手がかりが3本未満なら人気順に並べ、案内を出す（AC7）", async () => {
    const user = await createUser();
    await add(user, 1, { rating: 5 }, [SF]);
    await add(user, 2, { rating: 3 }, [DRAMA]); // ★3 は手がかりにならない
    mockTmdb({
      candidates: [
        tmdbMovie(10, { genre_ids: [SF], popularity: 5 }),
        tmdbMovie(11, { genre_ids: [HORROR], popularity: 50 }),
      ],
    });
    const data = await load(user, "");
    expect(data.recommend?.coldStart).toBe(true);
    expect(data.results.map((r) => r.tmdbId)).toEqual([11, 10]);
    expect(renderRoute(Search, { path: "/search", loaderData: data })).toContain("記録が増えると好みに合わせて並びます");
  });

  it("結果は20本まで。TMDb の呼び出しは10回以内（候補3＋関連作品3＋ジャンルの補完4）（AC8）", async () => {
    const user = await createUser();
    for (let id = 1; id <= 4; id++) await add(user, id, { rating: 5 }, [SF]);
    for (let id = 5; id <= 10; id++) await add(user, id, { rating: 4 }, null); // ジャンル不明
    const calls = mockTmdb({
      candidates: Array.from({ length: 30 }, (_, i) => tmdbMovie(100 + i, { genre_ids: [SF] })),
    });
    const data = await load(user, "");
    expect(data.results).toHaveLength(20);
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(calls.filter((u) => /\/3\/movie\/\d+$/.test(u.pathname))).toHaveLength(4);
  });

  it("ジャンルの分からない記録は、詳細を取得して補い、保存する", async () => {
    const user = await createUser();
    await add(user, 1, { rating: 5 }, null);
    mockTmdb();
    await load(user, "");
    const row = await getDb().query.movies.findFirst({ where: (m, { eq }) => eq(m.tmdbId, 1) });
    expect(row?.genreIds).toEqual([HORROR]);
  });

  it("TMDb が応答しないときは、案内を出し、500 にならない（AC9）", async () => {
    const user = await createUser();
    await seedTaste(user);
    mockTmdb({ fail: true });
    const data = await load(user, "&source=streaming");
    expect(data.error).toBe(TMDB_ERROR_MESSAGE);
    expect(data.results).toEqual([]);
    expect(renderRoute(Search, { path: "/search", loaderData: data })).toContain(TMDB_ERROR_MESSAGE);
  });
});
