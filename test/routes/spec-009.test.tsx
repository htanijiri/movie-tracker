import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { movieProviders, userMovies } from "~/lib/db/schema";
import { refreshStaleSnapshots } from "~/lib/db/movies.server";
import {
  addedProviders,
  CHECK_LIMIT,
  runStreamingCheck,
  toStreamingProviders,
} from "~/lib/streaming.server";
import Home, { action as homeAction, loader as homeLoader } from "~/routes/home";
import List, { loader as listLoader } from "~/routes/list";

import wranglerConfig from "../../wrangler.jsonc?raw";
import { createMovie, createUser, formRequest, mockFetch, ORIGIN, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

// 仕様書 009：配信開始チェック。

const NOW = new Date("2026-10-25T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type Insert = typeof userMovies.$inferInsert;
const theater = { status: "WANT_TO_WATCH", preferredMedium: "THEATER" } as const;
const streaming = { status: "WANT_TO_WATCH", preferredMedium: "STREAMING" } as const;

async function add(user: SessionUser, tmdbId: number, record: Partial<Insert>) {
  const existing = await env.DB.prepare("SELECT 1 FROM movies WHERE tmdb_id = ?").bind(tmdbId).first();
  if (!existing) await createMovie({ tmdbId, title: `映画${tmdbId}` });
  await getDb()
    .insert(userMovies)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      tmdbId,
      status: "WANT_TO_WATCH",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...record,
    });
}

const provider = (id: number, name: string) => ({ provider_id: id, provider_name: name, logo_path: `/${id}.jpg`, display_priority: id });

/** /movie/{id}/watch/providers の応答を、映画ごとに決めて返す。呼ばれた映画の ID を記録する。 */
function mockProviders(byMovie: Record<number, Record<string, unknown> | "404" | "500">) {
  const called: number[] = [];
  const mock = mockFetch((url) => {
    const m = /\/3\/movie\/(\d+)(\/watch\/providers)?$/.exec(url.pathname);
    if (!m) throw new Error(`想定外の呼び出し: ${url.pathname}`);
    const id = Number(m[1]);
    if (!m[2]) return Response.json(tmdbDetail(id)); // ジャンルの補完のための詳細
    called.push(id);
    const jp = byMovie[id];
    if (jp === "404") return Response.json({ status_code: 34 }, { status: 404 });
    if (jp === "500") return new Response("error", { status: 500 });
    return Response.json({ id, results: jp ? { JP: jp } : {} });
  });
  return { called, mock };
}

const notices = async () =>
  (
    await env.DB.prepare(
      "SELECT user_id, tmdb_id, provider_id, provider_name, dismissed_at FROM streaming_notices ORDER BY user_id, tmdb_id, provider_id",
    ).all<Record<string, string | number | null>>()
  ).results;

const saved = async (tmdbId: number) =>
  env.DB.prepare("SELECT providers, checked_at FROM movie_providers WHERE tmdb_id = ?")
    .bind(tmdbId)
    .first<{ providers: string; checked_at: string }>();

describe("配信状況の差分（仕様書 009）", () => {
  it("見放題と無料（広告付きを含む）だけを取り出す。レンタル・購入は含めない", () => {
    expect(
      toStreamingProviders({
        link: null,
        flatrate: [{ id: 8, name: "Netflix", logoPath: null }],
        rentOrBuy: [{ id: 10, name: "Amazon Video", logoPath: null }],
        free: [{ id: 300, name: "無料配信", logoPath: null }],
      }),
    ).toEqual([
      { id: 8, name: "Netflix", logoPath: null, type: "flatrate" },
      { id: 300, name: "無料配信", logoPath: null, type: "free" },
    ]);
    expect(toStreamingProviders(null)).toEqual([]);
  });

  it("前回より増えたサービスだけを返す。前回の記録がなければ何も返さない", () => {
    const a = { id: 1, name: "A", logoPath: null, type: "flatrate" as const };
    const b = { id: 2, name: "B", logoPath: null, type: "flatrate" as const };
    expect(addedProviders([a], [a, b])).toEqual([b]);
    expect(addedProviders([a, b], [a])).toEqual([]);
    expect(addedProviders(null, [a, b])).toEqual([]);
    expect(addedProviders([], [a])).toEqual([a]);
  });
});

describe("定期実行の配信開始チェック（仕様書 009）", () => {
  it("「サブスク待ち」「劇場で見たい」の映画だけを確かめる（AC1）", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    await add(user, 2, theater);
    await add(user, 3, { status: "WATCHED", watchedAt: "2026-01-01", watchedMedium: "THEATER" });
    await add(user, 4, { status: "SKIPPED", preferredMedium: "NONE" });
    const { called } = mockProviders({});

    const result = await runStreamingCheck(getDb(), NOW);

    expect(called.sort()).toEqual([1, 2]);
    expect(result.checked).toBe(2);
  });

  it("1回に確かめるのは30本まで。前回の確認が古い順で、20時間以内に確認した映画は飛ばす（AC2）", async () => {
    const user = await createUser();
    for (let id = 1; id <= 40; id++) await add(user, id, streaming);
    // 1〜5 は 1 時間前に確認済み（飛ばす）。6〜10 は 30 時間前（古い順で先頭）。
    for (let id = 1; id <= 10; id++) {
      await getDb().insert(movieProviders).values({
        tmdbId: id,
        providers: [],
        checkedAt: new Date(NOW.getTime() - (id <= 5 ? 1 : 30 + id) * HOUR).toISOString(),
      });
    }
    const { called } = mockProviders({});

    await runStreamingCheck(getDb(), NOW);

    expect(called).toHaveLength(CHECK_LIMIT);
    expect(CHECK_LIMIT).toBe(30);
    expect(called.some((id) => id <= 5)).toBe(false);
    // 未確認の映画（11〜40）が先、その次に古い確認の映画。
    expect(called.slice(0, 30).every((id) => id >= 11)).toBe(true);
  });

  it("初めて確かめた映画では、お知らせを作らず、配信状況だけを保存する（AC3）", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    mockProviders({ 1: { flatrate: [provider(8, "Netflix")] } });

    await runStreamingCheck(getDb(), NOW);

    expect(await notices()).toEqual([]);
    const row = await saved(1);
    expect(JSON.parse(row!.providers)).toEqual([{ id: 8, name: "Netflix", logoPath: "/8.jpg", type: "flatrate" }]);
    expect(row!.checked_at).toBe(NOW.toISOString());
  });

  it("見放題・無料のサービスが増えたら、対象の状態で登録している利用者全員にお知らせを作る（AC4）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    const watched = await createUser({ email: "watched@example.com" });
    await add(me, 1, streaming);
    await add(other, 1, theater);
    await add(watched, 1, { status: "WATCHED", watchedAt: "2026-01-01", watchedMedium: "THEATER" });
    await getDb().insert(movieProviders).values({ tmdbId: 1, providers: [], checkedAt: "2026-10-01T00:00:00.000Z" });
    mockProviders({ 1: { flatrate: [provider(8, "Netflix")], ads: [provider(300, "無料配信")], rent: [provider(10, "Amazon Video")] } });

    const result = await runStreamingCheck(getDb(), NOW);

    const rows = await notices();
    expect(rows.map((r) => [r.user_id, r.provider_name])).toEqual(
      expect.arrayContaining([
        [me.id, "Netflix"],
        [me.id, "無料配信"],
        [other.id, "Netflix"],
        [other.id, "無料配信"],
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.user_id === watched.id)).toBe(false);
    expect(rows.some((r) => r.provider_name === "Amazon Video")).toBe(false);
    expect(result.notices).toBe(4);
  });

  it("レンタル・購入だけが増えた場合と、サービスが減った場合は、お知らせを作らない（AC4）", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    await add(user, 2, streaming);
    await getDb().insert(movieProviders).values([
      { tmdbId: 1, providers: [], checkedAt: "2026-10-01T00:00:00.000Z" },
      { tmdbId: 2, providers: [{ id: 8, name: "Netflix", logoPath: null, type: "flatrate" }], checkedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    mockProviders({ 1: { rent: [provider(10, "Amazon Video")], buy: [provider(2, "Apple TV")] }, 2: {} });

    await runStreamingCheck(getDb(), NOW);

    expect(await notices()).toEqual([]);
    expect(JSON.parse((await saved(2))!.providers)).toEqual([]);
  });

  it("同じ映画・同じサービスのお知らせは1つだけ。確認済みのものは、配信が再開したら出し直す（AC5）", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    const netflix = { flatrate: [provider(8, "Netflix")] };
    await getDb().insert(movieProviders).values({ tmdbId: 1, providers: [], checkedAt: "2026-10-01T00:00:00.000Z" });

    mockProviders({ 1: netflix });
    await runStreamingCheck(getDb(), NOW);
    expect(await notices()).toHaveLength(1);

    // 配信が終わって、また始まった（未確認のまま）→ 増やさない。
    mockProviders({ 1: {} });
    await runStreamingCheck(getDb(), new Date(NOW.getTime() + 24 * HOUR));
    mockProviders({ 1: netflix });
    await runStreamingCheck(getDb(), new Date(NOW.getTime() + 48 * HOUR));
    let rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0].dismissed_at).toBeNull();

    // 確認したあとで、また終わって始まった → 出し直す。
    await env.DB.prepare("UPDATE streaming_notices SET dismissed_at = '2026-10-28T00:00:00.000Z'").run();
    mockProviders({ 1: {} });
    await runStreamingCheck(getDb(), new Date(NOW.getTime() + 72 * HOUR));
    mockProviders({ 1: netflix });
    await runStreamingCheck(getDb(), new Date(NOW.getTime() + 96 * HOUR));
    rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0].dismissed_at).toBeNull();
  });

  it("TMDb が応答しない映画があっても、ほかの映画は確かめる。404 は確認済みとして扱う（AC6）", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    await add(user, 2, streaming);
    await add(user, 3, streaming);
    await getDb().insert(movieProviders).values({ tmdbId: 2, providers: [{ id: 8, name: "Netflix", logoPath: null, type: "flatrate" }], checkedAt: "2026-10-01T00:00:00.000Z" });
    mockProviders({ 1: "500", 2: "404", 3: { flatrate: [provider(8, "Netflix")] } });

    const result = await runStreamingCheck(getDb(), NOW);

    expect(result).toMatchObject({ checked: 2, failed: 1 });
    expect(await saved(1)).toBeNull(); // 失敗した映画は、次の実行でまた確かめる
    const gone = await saved(2);
    expect(gone!.checked_at).toBe(NOW.toISOString());
    expect(JSON.parse(gone!.providers)).toHaveLength(1); // 前回の配信状況のまま
    expect(await saved(3)).not.toBeNull();
  });

  it("ジャンルの分からない、リストの映画の詳細を補う（仕様書 012 のため）", async () => {
    const user = await createUser();
    await add(user, 1, { status: "WATCHED", watchedAt: "2026-01-01", watchedMedium: "THEATER", rating: 5 });
    mockProviders({});
    const result = await runStreamingCheck(getDb(), NOW);
    expect(result.genresFilled).toBe(1);
    const row = await env.DB.prepare("SELECT genre_ids FROM movies WHERE tmdb_id = 1").first<{ genre_ids: string }>();
    expect(JSON.parse(row!.genre_ids)).toEqual([1, 2]);
  });

  it("定期実行が wrangler.jsonc に設定されている（AC10）", () => {
    expect(wranglerConfig).toMatch(/"triggers":\s*{\s*"crons":\s*\["0 \*\/4 \* \* \*"\]/);
  });
});

describe("トップページのお知らせ（仕様書 009）", () => {
  async function seedNotice(user: SessionUser, tmdbId: number, record: Partial<Insert>, providerName = "Netflix", detectedAt = "2026-10-24T00:00:00.000Z") {
    await add(user, tmdbId, record);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO streaming_notices (id, user_id, tmdb_id, provider_id, provider_name, detected_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, user.id, tmdbId, providerName.length, providerName, detectedAt).run();
    return id;
  }

  it("確認していないお知らせを新しい順に返す。視聴済み・見送り・他の利用者のものは返さない（AC7）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await seedNotice(me, 1, streaming, "Netflix", "2026-10-20T00:00:00.000Z");
    await seedNotice(me, 2, theater, "U-NEXT", "2026-10-24T00:00:00.000Z");
    await seedNotice(me, 3, { status: "WATCHED", watchedAt: "2026-01-01", watchedMedium: "STREAMING" });
    await seedNotice(me, 4, { status: "SKIPPED", preferredMedium: "NONE" });
    await seedNotice(other, 5, streaming);
    const dismissed = await seedNotice(me, 6, streaming);
    await env.DB.prepare("UPDATE streaming_notices SET dismissed_at = 'x' WHERE id = ?").bind(dismissed).run();

    const data = await homeLoader(routeArgs({ user: me }));
    expect(data.notices.map((n) => [n.tmdbId, n.providerName])).toEqual([
      [2, "U-NEXT"],
      [1, "Netflix"],
    ]);

    const html = renderRoute(Home, { path: "/", loaderData: data });
    const section = /<section[^>]*data-section="notices"[^>]*>(.*?)<\/section>/s.exec(html)![1];
    expect(section).toContain("配信が始まりました");
    expect(section).toContain("映画2");
    expect(section).toContain("U-NEXT");
    expect(section).toContain("（10月24日確認）");
    expect(section).toContain('href="/movies/2"');
    expect(section).toContain("確認した");
    // お知らせはトップページのいちばん上（区分より前）。
    expect(html.indexOf('data-section="notices"')).toBeLessThan(html.indexOf('data-section="theater"'));
  });

  it("リストから消した映画のお知らせは返さない（AC7）", async () => {
    const me = await createUser();
    await seedNotice(me, 1, streaming);
    await env.DB.prepare("DELETE FROM user_movies").run();
    expect((await homeLoader(routeArgs({ user: me }))).notices).toEqual([]);
  });

  it("お知らせがないときは、お知らせの欄を出さない", async () => {
    const me = await createUser();
    const html = renderRoute(Home, { path: "/", loaderData: await homeLoader(routeArgs({ user: me })) });
    expect(html).not.toContain('data-section="notices"');
  });

  it("「確認した」でお知らせが消える。他の利用者のお知らせは消せない（AC8）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    const mine = await seedNotice(me, 1, streaming);
    const theirs = await seedNotice(other, 2, streaming);

    const dismiss = (user: SessionUser, noticeId: string) =>
      homeAction(routeArgs({ request: formRequest("/", { intent: "dismiss-notice", noticeId }), user }));

    expect((await dismiss(me, theirs)) as unknown).toMatchObject({ init: { status: 404 } });
    expect((await dismiss(me, mine)) as unknown).toMatchObject({ data: { ok: true } });
    expect((await homeLoader(routeArgs({ user: me }))).notices).toEqual([]);
    expect((await homeLoader(routeArgs({ user: other }))).notices).toHaveLength(1);

    expect((await homeAction(routeArgs({ request: formRequest("/", { intent: "other" }), user: me }))) as unknown).toMatchObject({ init: { status: 400 } });
  });
});

describe("カードの「配信中」（仕様書 009）", () => {
  it("サブスク待ち・劇場で見たいのカードに、配信中のサービス名を3つまで出す。視聴済み・見送りには出さない（AC9）", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    await add(user, 2, theater);
    await add(user, 3, streaming);
    await add(user, 4, { status: "WATCHED", watchedAt: "2026-01-01", watchedMedium: "STREAMING" });
    await add(user, 5, { status: "SKIPPED", preferredMedium: "NONE" });
    const p = (id: number, name: string) => ({ id, name, logoPath: null, type: "flatrate" as const });
    const four = [p(1, "A"), p(2, "B"), p(3, "C"), p(4, "D")];
    await getDb().insert(movieProviders).values([
      { tmdbId: 1, providers: [p(8, "Netflix")], checkedAt: NOW.toISOString() },
      { tmdbId: 2, providers: four, checkedAt: NOW.toISOString() },
      { tmdbId: 3, providers: [], checkedAt: NOW.toISOString() },
      { tmdbId: 4, providers: [p(8, "Netflix")], checkedAt: NOW.toISOString() },
      { tmdbId: 5, providers: [p(8, "Netflix")], checkedAt: NOW.toISOString() },
    ]);

    const html = renderRoute(List, {
      path: "/list",
      loaderData: await listLoader(routeArgs({ url: `${ORIGIN}/list`, user })),
    });
    const cardOf = (id: number) => new RegExp(`<a\\b[^>]*data-card="${id}"[^>]*>(.*?)</a>`, "s").exec(html)![1];
    const lineOf = (id: number) => /<p[^>]*data-streaming-now[^>]*>(.*?)<\/p>/s.exec(cardOf(id))?.[1].replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "");

    expect(lineOf(1)).toBe("📺 配信中：Netflix");
    expect(lineOf(2)).toBe("📺 配信中：A、B、C ほか");
    expect(lineOf(3)).toBeUndefined();
    expect(lineOf(4)).toBeUndefined();
    expect(lineOf(5)).toBeUndefined();
  });

  it("まだ確認していない映画には出さない", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    const html = renderRoute(Home, { path: "/", loaderData: await homeLoader(routeArgs({ user })) });
    expect(html).not.toContain("data-streaming-now");
  });
});

describe("古い配信状況の整理（仕様書 009）", () => {
  it("確認から30日を超えた配信状況は消す", async () => {
    const user = await createUser();
    await add(user, 1, streaming);
    await add(user, 2, streaming);
    await getDb().insert(movieProviders).values([
      { tmdbId: 1, providers: [], checkedAt: "2026-09-01T00:00:00.000Z" },
      { tmdbId: 2, providers: [], checkedAt: "2026-10-20T00:00:00.000Z" },
    ]);
    mockFetch(() => Response.json(tmdbDetail(1)));
    await refreshStaleSnapshots(getDb(), NOW);
    expect(await saved(1)).toBeNull();
    expect(await saved(2)).not.toBeNull();
  });
});
