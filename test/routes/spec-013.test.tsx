import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { userMovies } from "~/lib/db/schema";
import { getUserMovie, listPlaceSuggestions } from "~/lib/db/user-movies.server";
import { todayInTokyo } from "~/lib/date";
import Home, { loader as homeLoader } from "~/routes/home";
import MovieDetailPage, { action as movieAction, loader as movieLoader } from "~/routes/movie";
import TrailerHuntPage, { action, loader } from "~/routes/trailers";
import { loader as videoLoader } from "~/routes/trailers.video";
import { MyRecord } from "~/components/MyRecord";

import { createMovie, createUser, formRequest, mockFetch, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail, tmdbList, tmdbMovie } from "../helpers/tmdb-fixtures";

// 仕様書 013：予告で見た映画を探す。見た映画は 1001（「映画A」）、見た日は 2026-10-04、映画館は「映画館X」。

const VISIT = 1001;

async function seedVisit(user: SessionUser, extra: Partial<typeof userMovies.$inferInsert> = {}) {
  await createMovie({ tmdbId: VISIT, title: "映画A" });
  await getDb().insert(userMovies).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tmdbId: VISIT,
    status: "WATCHED",
    watchedAt: "2026-10-04",
    watchedMedium: "THEATER",
    watchedPlace: "映画館X",
    trailerCount: 3,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...extra,
  });
}

const postMovie = (user: SessionUser, tmdbId: number, fields: Record<string, string>) =>
  movieAction(routeArgs({ request: formRequest(`/movies/${tmdbId}`, fields), params: { tmdbId: String(tmdbId) }, user }));
const postHunt = (user: SessionUser, fields: Record<string, string>, visit = VISIT) =>
  action(routeArgs({ request: formRequest(`/trailers/${visit}`, fields), params: { tmdbId: String(visit) }, user }));
const loadHunt = (user: SessionUser, visit = VISIT) =>
  loader(routeArgs({ params: { tmdbId: String(visit) }, user }));

const unwrap = (r: unknown) => {
  const w = r as { type?: string; data?: unknown; init?: ResponseInit | null };
  return w?.type === "DataWithResponseInit" ? { status: w.init?.status ?? 200, body: w.data as Record<string, unknown> } : { status: 200, body: r as Record<string, unknown> };
};

/** 候補の discover と、詳細（登録のときのスナップショット）を返す。呼ばれた URL を記録する。 */
function mockCandidates(candidates: unknown[], options: { fail?: boolean } = {}) {
  const calls: URL[] = [];
  mockFetch((url) => {
    calls.push(url);
    if (options.fail) return new Response("error", { status: 500 });
    const detail = /\/3\/movie\/(\d+)$/.exec(url.pathname);
    if (detail) return Response.json(tmdbDetail(Number(detail[1])));
    return Response.json(tmdbList(Number(url.searchParams.get("page")) === 1 ? candidates : []));
  });
  return calls;
}

const row = (userId: string, tmdbId: number) =>
  env.DB.prepare("SELECT * FROM user_movies WHERE user_id = ? AND tmdb_id = ?").bind(userId, tmdbId).first<Record<string, string | number | null>>();

describe("見た記録の「気になった予告」（仕様書 013 AC1）", () => {
  const watched = (extra: Record<string, string>) => ({ intent: "save-watched", watchedAt: "2026-10-04", watchedMedium: "THEATER", ...extra });

  it.each<[Record<string, string>, number | null]>([
    [{ trailerChoice: "" }, null],
    [{ trailerChoice: "0" }, 0],
    [{ trailerChoice: "3" }, 3],
    [{ trailerChoice: "many", trailerMany: "4" }, 4],
    [{ trailerChoice: "many", trailerMany: "12" }, 12],
    [{ trailerChoice: "many", trailerMany: "20" }, 20],
  ])("劇場で見たとき %j → %s として保存する", async (fields, expected) => {
    const user = await createUser();
    await createMovie();
    const { status } = unwrap(await postMovie(user, 1001, watched(fields)));
    expect(status).toBe(200);
    expect((await row(user.id, 1001))!.trailer_count).toBe(expected);
  });

  it.each<Record<string, string>>([
    { trailerChoice: "many", trailerMany: "3" },
    { trailerChoice: "many", trailerMany: "21" },
    { trailerChoice: "many", trailerMany: "4.5" },
    { trailerChoice: "many", trailerMany: "" },
    { trailerChoice: "5" },
  ])("範囲外・整数でない値 %j は 400", async (fields) => {
    const user = await createUser();
    await createMovie();
    const { status, body } = unwrap(await postMovie(user, 1001, watched(fields)));
    expect(status).toBe(400);
    expect(body.errors).toHaveProperty("trailerCount");
  });

  it("劇場以外で保存したときは、送られても NULL にする", async () => {
    const user = await createUser();
    await createMovie();
    await postMovie(user, 1001, watched({ trailerChoice: "2" }));
    await postMovie(user, 1001, watched({ watchedMedium: "STREAMING", trailerChoice: "2" }));
    expect((await row(user.id, 1001))!.trailer_count).toBeNull();
  });

  async function renderRecord(user: SessionUser, watchedMedium: string, defaultWatchedOpen = true) {
    const db = getDb();
    const record = await getUserMovie(db, user.id, 1001);
    const suggestions = await listPlaceSuggestions(db, user.id);
    return renderRoute(() => (
      <MyRecord record={record} today={todayInTokyo()} suggestions={suggestions} defaultWatchedOpen={defaultWatchedOpen} />
    ));
  }

  it("フォームの選択肢は、視聴方法が劇場のときだけ出る。4本以上の保存済みの値は数字の入力欄に入る", async () => {
    const user = await createUser();
    await createMovie();
    await postMovie(user, 1001, { intent: "set-medium", medium: "THEATER" });
    const theaterForm = await renderRecord(user, "THEATER");
    expect(theaterForm).toContain("data-trailer-count");
    expect(theaterForm).toContain("4本以上");
    expect(theaterForm).not.toContain('name="trailerMany"'); // 「4本以上」を選ぶまでは出ない

    await postMovie(user, 1001, { intent: "set-medium", medium: "STREAMING" });
    expect(await renderRecord(user, "STREAMING")).not.toContain("data-trailer-count");

    // 視聴済みで、4本以上（12本）を保存済みの映画の編集フォーム。
    await postMovie(user, 1001, watched({ trailerChoice: "many", trailerMany: "12" }));
    mockFetch(() => Response.json(tmdbDetail(1001)));
    const loaderData = await movieLoader(routeArgs({ params: { tmdbId: "1001" }, user }));
    const html = renderRoute(MovieDetailPage, { path: "/movies/:tmdbId", url: "/movies/1001", loaderData });
    expect(html).toMatch(/<input[^>]*name="trailerMany"[^>]*value="12"|<input[^>]*value="12"[^>]*name="trailerMany"/);
    expect(html).toMatch(/<input[^>]*value="many"[^>]*checked=""|<input[^>]*checked=""[^>]*value="many"/);
  });
});

describe("トップページの「予告を探す」（仕様書 013 AC2・AC7）", () => {
  it("探し終わっていない予告探しを、見た日の新しい順に返す。他の利用者・本数0・劇場以外・終了済みは返さない", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    const add = async (user: SessionUser, tmdbId: number, extra: Partial<typeof userMovies.$inferInsert>) => {
      await env.DB.prepare("INSERT OR IGNORE INTO movies (tmdb_id, title, fetched_at) VALUES (?, ?, 'x')").bind(tmdbId, `映画${tmdbId}`).run();
      await getDb().insert(userMovies).values({
        id: crypto.randomUUID(), userId: user.id, tmdbId, status: "WATCHED", watchedMedium: "THEATER",
        watchedAt: "2026-10-01", trailerCount: 2, createdAt: "x", updatedAt: "x", ...extra,
      });
    };
    await add(me, 1, { watchedAt: "2026-10-01" });
    await add(me, 2, { watchedAt: "2026-10-10", watchedPlace: "映画館Y" });
    await add(me, 3, { trailerCount: 0 });
    await add(me, 4, { watchedMedium: "STREAMING" });
    await add(me, 5, { trailerHuntClosedAt: "2026-10-11T00:00:00.000Z" });
    await add(me, 6, { trailerCount: null });
    await add(other, 7, {});

    const data = await homeLoader(routeArgs({ user: me }));
    expect(data.hunts.map((h) => h.tmdbId)).toEqual([2, 1]);

    const html = renderRoute(Home, { path: "/", loaderData: data });
    const section = /<section[^>]*data-section="hunts"[^>]*>(.*?)<\/section>/s.exec(html)![1];
    expect(section).toContain("予告を探す");
    expect(section).toContain("10月10日 映画館Y 「映画2」の上映前");
    expect(section).toContain("気になった予告 2本中 あと2本");
    expect(section).toContain('href="/trailers/2"');
  });

  it("見つけた本数が本数に達したら出なくなる", async () => {
    const me = await createUser();
    await seedVisit(me, { trailerCount: 1 });
    mockCandidates([tmdbMovie(10)]);
    await postHunt(me, { intent: "match", candidate: "10", medium: "THEATER" });
    expect((await homeLoader(routeArgs({ user: me }))).hunts).toEqual([]);
  });

  it("「探すのを終える」で、本数に達していなくても出なくなる（AC7）", async () => {
    const me = await createUser();
    await seedVisit(me);
    expect(unwrap(await postHunt(me, { intent: "close" })).body).toEqual({ ok: true });
    expect((await homeLoader(routeArgs({ user: me }))).hunts).toEqual([]);
    const data = await loadHunt(me);
    expect(data.hunt.closed).toBe(true);
    expect(renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data })).toContain("探すのを終えました");
  });
});

describe("「予告を探す」画面（仕様書 013）", () => {
  it("見た日の1か月前〜半年後に日本で公開（予定）の映画を注目度順に3ページ取得し、見た映画などを除いて最大20本を返す（AC3）", async () => {
    const me = await createUser();
    await seedVisit(me);
    const calls = mockCandidates([tmdbMovie(VISIT), ...Array.from({ length: 25 }, (_, i) => tmdbMovie(100 + i))]);

    const data = await loadHunt(me);

    const discover = calls.filter((u) => u.pathname === "/3/discover/movie");
    expect(discover.map((u) => u.searchParams.get("page")).sort()).toEqual(["1", "2", "3"]);
    expect(discover[0].searchParams.get("region")).toBe("JP");
    expect(discover[0].searchParams.get("with_release_type")).toBe("2|3");
    expect(discover[0].searchParams.get("release_date.gte")).toBe("2026-09-04");
    expect(discover[0].searchParams.get("release_date.lte")).toBe("2027-04-05");
    expect(discover[0].searchParams.get("sort_by")).toBe("popularity.desc");
    expect(data.candidates).toHaveLength(20);
    expect(data.candidates.some((c) => c.tmdbId === VISIT)).toBe(false);
  });

  it("予告探しの対象でない記録（本数なし・劇場以外・他の利用者）は 404（AC3）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await seedVisit(other);
    await expect(loadHunt(me)).rejects.toMatchObject({ init: { status: 404 } });
    await expect(loader(routeArgs({ params: { tmdbId: "abc" }, user: me }))).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("予告は /trailers/video/:id で1回取得する。予告がなければ null（AC4）", async () => {
    const me = await createUser();
    const calls: URL[] = [];
    mockFetch((url) => {
      calls.push(url);
      const id = url.pathname.split("/")[3];
      return Response.json({
        results: id === "10" ? [{ key: "abc", name: "本予告", site: "YouTube", type: "Trailer", official: true, iso_639_1: "ja" }] : [],
      });
    });
    expect(await videoLoader(routeArgs({ params: { id: "10" }, user: me }))).toEqual({ trailer: { key: "abc", name: "本予告", language: "ja" }, error: null });
    expect(calls[0].pathname).toBe("/3/movie/10/videos");
    expect(calls[0].searchParams.get("include_video_language")).toBe("ja,en,null");
    expect(await videoLoader(routeArgs({ params: { id: "11" }, user: me }))).toEqual({ trailer: null, error: null });
  });

  it("「これだった」で、区分を付けて登録し、きっかけを自動で入れ、見つけた予告に並ぶ（AC5・AC8）", async () => {
    const me = await createUser();
    await seedVisit(me);
    mockCandidates([tmdbMovie(10), tmdbMovie(11)]);

    expect(unwrap(await postHunt(me, { intent: "match", candidate: "10", medium: "STREAMING" })).body).toEqual({ ok: true });

    expect(await row(me.id, 10)).toMatchObject({
      status: "WANT_TO_WATCH",
      preferred_medium: "STREAMING",
      discovery_type: "THEATER_TRAILER",
      discovery_date: "2026-10-04",
      discovery_place: "映画館X",
      discovery_note: "「映画A」の上映前",
    });
    const data = await loadHunt(me);
    expect(data.matched.map((m) => m.tmdbId)).toEqual([10]);
    expect(data.candidates.map((c) => c.tmdbId)).toEqual([11]);
    expect(data.hunt.found).toBe(1);
    const html = renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data });
    expect(html).toContain("見つけた予告");
    expect(html).toContain("気になった予告 3本中 あと2本");
  });

  it("すでにリストにある映画は、登録の状態を変えず、きっかけが空のときだけ入れる（AC5）", async () => {
    const me = await createUser();
    await seedVisit(me);
    await createMovie({ tmdbId: 10 });
    await createMovie({ tmdbId: 11 });
    await postMovie(me, 10, { intent: "set-medium", medium: "THEATER" });
    await postMovie(me, 11, { intent: "set-medium", medium: "STREAMING" });
    await postMovie(me, 11, { intent: "save-discovery", type: "SNS", note: "友人の投稿" });
    mockCandidates([tmdbMovie(10), tmdbMovie(11)]);

    await postHunt(me, { intent: "match", candidate: "10" }); // 区分なしでよい
    await postHunt(me, { intent: "match", candidate: "11", medium: "NONE" });

    expect(await row(me.id, 10)).toMatchObject({ preferred_medium: "THEATER", discovery_type: "THEATER_TRAILER", discovery_note: "「映画A」の上映前" });
    expect(await row(me.id, 11)).toMatchObject({ preferred_medium: "STREAMING", discovery_type: "SNS", discovery_note: "友人の投稿" });
    expect((await loadHunt(me)).matched).toHaveLength(2);
  });

  it("リストにない映画を、区分なしで「これだった」にすると 400", async () => {
    const me = await createUser();
    await seedVisit(me);
    mockCandidates([tmdbMovie(10)]);
    expect(unwrap(await postHunt(me, { intent: "match", candidate: "10" })).status).toBe(400);
    expect(await row(me.id, 10)).toBeNull();
  });

  it("「違う」で候補から消え、「戻す」で戻る（AC6）", async () => {
    const me = await createUser();
    await seedVisit(me);
    mockCandidates([tmdbMovie(10), tmdbMovie(11), tmdbMovie(12)]);
    await postHunt(me, { intent: "reject", candidate: "10" });
    await postHunt(me, { intent: "reject", candidate: "11" });

    let data = await loadHunt(me);
    expect(data.candidates.map((c) => c.tmdbId)).toEqual([12]);
    expect(data.rejectedCount).toBe(2);
    expect(renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data })).toContain("「違う」にした2本を戻す");

    await postHunt(me, { intent: "restore-rejects" });
    data = await loadHunt(me);
    expect(data.candidates.map((c) => c.tmdbId)).toEqual([10, 11, 12]);
    expect(data.rejectedCount).toBe(0);
  });

  it("他の利用者の予告探しは操作できない", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await seedVisit(other);
    await expect(postHunt(me, { intent: "close" })).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("見た記録を取り消すと、その予告探しの記録も消える", async () => {
    const me = await createUser();
    await seedVisit(me, { preferredMedium: "THEATER" });
    mockCandidates([tmdbMovie(10)]);
    await postHunt(me, { intent: "reject", candidate: "10" });
    await postMovie(me, VISIT, { intent: "unwatch" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM trailer_finds").first<{ n: number }>())!.n).toBe(0);
    expect(await row(me.id, VISIT)).toMatchObject({ trailer_count: null, status: "WANT_TO_WATCH" });
  });

  it("TMDb が応答しないときは、案内を出し 500 にならない（AC9）", async () => {
    const me = await createUser();
    await seedVisit(me);
    mockCandidates([], { fail: true });
    const data = await loadHunt(me);
    expect(data.error).toContain("映画情報を取得できませんでした");
    expect(renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data })).toContain('role="alert"');
  });
});
