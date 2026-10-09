import { describe, expect, it } from "vitest";

import { releaseLabel } from "~/components/MovieCard";
import type { SessionUser } from "~/context";
import { settleBackgroundTasks } from "~/lib/background.server";
import { todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { userMovies } from "~/lib/db/schema";
import Home, { loader as homeLoader } from "~/routes/home";
import List, { loader as listLoader } from "~/routes/list";

import { createMovie, createUser, mockFetch, ORIGIN, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

type Insert = typeof userMovies.$inferInsert;

let seq = 0;
/** 映画のスナップショットと、利用者の記録を1本ぶん作る。 */
async function add(
  user: SessionUser,
  tmdbId: number,
  record: Partial<Insert>,
  movie: Parameters<typeof createMovie>[0] = {},
) {
  seq += 1;
  const stamp = `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
  await createMovie({ tmdbId, title: `映画${tmdbId}`, posterPath: `/p${tmdbId}.jpg`, ...movie });
  await getDb()
    .insert(userMovies)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      tmdbId,
      status: "WANT_TO_WATCH",
      createdAt: stamp,
      updatedAt: stamp,
      ...record,
    });
}

const theater = { status: "WANT_TO_WATCH", preferredMedium: "THEATER" } as const;
const streaming = { status: "WANT_TO_WATCH", preferredMedium: "STREAMING" } as const;
const skipped = { status: "SKIPPED", preferredMedium: "NONE" } as const;
const watched = (watchedAt: string, extra: Partial<Insert> = {}) =>
  ({ status: "WATCHED", watchedAt, watchedMedium: "THEATER", ...extra }) as const;

const loadHome = (user: SessionUser) => homeLoader(routeArgs({ user }));
const loadList = (user: SessionUser, query = "") =>
  listLoader(routeArgs({ url: `${ORIGIN}/list${query}`, user }));

const renderHome = (data: Awaited<ReturnType<typeof homeLoader>>) =>
  renderRoute(Home, { path: "/", loaderData: data });
const renderList = (data: Awaited<ReturnType<typeof listLoader>>) =>
  renderRoute(List, { path: "/list", loaderData: data });

const ids = (items: { tmdbId: number }[]) => items.map((i) => i.tmdbId);
/** HTML の中の、ある区分の部分だけを取り出す。 */
const sectionOf = (html: string, id: string) =>
  new RegExp(`<section[^>]*data-section="${id}"[^>]*>(.*?)</section>`, "s").exec(html)![1];

describe("トップページ（/）", () => {
  it("3つの区分を、決めた順番で返す（AC1）", async () => {
    const user = await createUser();
    // 劇場で見たい：公開日の昇順、未定は最後。
    await add(user, 1, theater, { releaseDate: "2026-03-01" });
    await add(user, 2, theater, { releaseDate: null });
    await add(user, 3, theater, { releaseDate: "2026-01-15" });
    // サブスク待ち：登録が新しい順。
    await add(user, 11, streaming, {});
    await add(user, 12, streaming, {});
    // 最近見た：見た日が新しい順。同じ日なら、あとから記録したものが上。
    await add(user, 21, watched("2026-01-05"));
    await add(user, 22, watched("2026-01-09"));
    await add(user, 23, watched("2026-01-09"));

    const data = await loadHome(user);
    expect(ids(data.theater)).toEqual([3, 1, 2]);
    expect(ids(data.streaming)).toEqual([12, 11]);
    expect(ids(data.watched)).toEqual([23, 22, 21]);
    expect(data.hasMoreWatched).toBe(false);
    expect(data.today).toBe(todayInTokyo());
  });

  it("見送りにした映画は、どの区分にも出ない（AC2）", async () => {
    const user = await createUser();
    await add(user, 1, skipped);
    const data = await loadHome(user);
    expect([...data.theater, ...data.streaming, ...data.watched]).toEqual([]);
    expect(renderHome(data)).not.toContain("映画1");
  });

  it("TMDb を呼ばず、保存済みのスナップショットからタイトル・ポスター・公開日を出す（AC3）", async () => {
    const user = await createUser();
    await add(user, 1, theater, { title: "映画A", posterPath: "/a.jpg", releaseDate: "2026-01-10" });
    const fetchMock = mockFetch(() => new Response("呼ばれないはず", { status: 500 }));

    const data = await loadHome(user);
    await loadList(user);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(data.theater[0]).toMatchObject({
      tmdbId: 1,
      title: "映画A",
      posterPath: "/a.jpg",
      releaseDate: "2026-01-10",
    });
  });

  it("他の利用者の映画は出ない（AC4）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await add(me, 1, theater);
    await add(other, 2, theater);
    await add(other, 3, streaming);
    await add(other, 4, watched("2026-01-09"));

    const data = await loadHome(me);
    expect(ids([...data.theater, ...data.streaming, ...data.watched])).toEqual([1]);
    expect(ids((await loadList(me)).items)).toEqual([1]);
  });

  it("カードに、ポスター・タイトル・状態・きっかけの1行が出る。視聴済みには、見た日・場所・★が出る（AC5）", async () => {
    const user = await createUser();
    await add(user, 1, {
      ...theater,
      discoveryType: "THEATER_TRAILER",
      discoveryDate: "2026-01-10",
      discoveryNote: "「映画Z」の上映前",
    }, { title: "映画A", posterPath: "/a.jpg" });
    await add(user, 2, watched("2026-01-09", { watchedPlace: "映画館X", rating: 4 }), { title: "映画B" });
    await add(user, 3, watched("2026-01-08", { watchedMedium: "STREAMING" }), { title: "映画C" });

    const html = renderHome(await loadHome(user));

    const theaterHtml = sectionOf(html, "theater");
    expect(theaterHtml).toContain('href="/movies/1"');
    expect(theaterHtml).toContain('src="https://image.tmdb.org/t/p/w185/a.jpg"');
    expect(theaterHtml).toContain("映画A");
    expect(theaterHtml).toContain('data-state="theater"');
    expect(theaterHtml).toContain("劇場で見たい");
    expect(theaterHtml).toContain("2026/01/10 映画館の予告 ・ 「映画Z」の上映前");

    const watchedHtml = sectionOf(html, "watched");
    expect(watchedHtml).toContain("映画B");
    expect(watchedHtml).toContain('data-state="watched"');
    expect(watchedHtml).toContain("2026/01/09 ・ 映画館X");
    expect(watchedHtml).toContain("★★★★☆");
    // 場所を書いていない記録では、見た日だけを出す（どこで見たかは、ラベルで出す。仕様書 008）。
    // 評価がなければ★は出さない。
    expect(watchedHtml).toMatch(/<p[^>]*data-watched-line[^>]*>2026\/01\/08<\/p>/);
    expect(watchedHtml.match(/[★☆]{5}/g)).toHaveLength(1);
  });

  it("公開前の映画には「M月D日公開」、公開日が未定の映画には「公開日未定」が付く（AC6）", async () => {
    expect(releaseLabel("2026-03-05", "2026-01-10")).toBe("3月5日公開");
    expect(releaseLabel(null, "2026-01-10")).toBe("公開日未定");
    // 公開済み（今日を含む）の映画には、公開日を出す。
    expect(releaseLabel("2026-01-10", "2026-01-10")).toBe("2026/01/10 公開");
    expect(releaseLabel("2025-12-01", "2026-01-10")).toBe("2025/12/01 公開");

    const user = await createUser();
    await add(user, 1, theater, { releaseDate: "2999-03-05" });
    await add(user, 2, theater, { releaseDate: null });
    const html = sectionOf(renderHome(await loadHome(user)), "theater");
    expect(html).toContain("3月5日公開");
    expect(html).toContain("公開日未定");
  });

  it("何もない区分には、「まだありません」と「映画を探す」へのリンクが出る（AC7）", async () => {
    const user = await createUser();
    const html = renderHome(await loadHome(user));
    for (const id of ["theater", "streaming", "watched"]) {
      const section = sectionOf(html, id);
      expect(section).toContain("まだありません");
      expect(section).toContain('href="/search"');
    }
    expect(html).toContain("次に何を見る？");
  });

  it("「最近見た」は5本まで。6本以上あるときは「すべて見る」が出る（AC9）", async () => {
    const user = await createUser();
    for (let i = 1; i <= 5; i++) await add(user, i, watched(`2026-01-0${i}`));

    const five = await loadHome(user);
    expect(five.watched).toHaveLength(5);
    expect(five.hasMoreWatched).toBe(false);
    expect(renderHome(five)).not.toContain("すべて見る");

    await add(user, 6, watched("2026-01-06"));
    const six = await loadHome(user);
    expect(ids(six.watched)).toEqual([6, 5, 4, 3, 2]);
    expect(six.hasMoreWatched).toBe(true);
    const html = renderHome(six);
    expect(html).toContain("すべて見る");
    expect(html).toContain('href="/list?filter=watched"');
  });

  it("スナップショットが古くても、そのままの内容ですぐに表示し、裏で取り直す（AC10）", async () => {
    const user = await createUser();
    await add(user, 1, theater, { title: "古い情報の映画", fetchedAt: "2020-01-01T00:00:00.000Z" });
    mockFetch(() => Response.json(tmdbDetail(1, { title: "新しい情報の映画" })));

    // 画面には、保存済みの古い内容がそのまま出る（取り直しを待たない）。
    const html = renderHome(await loadHome(user));
    expect(html).toContain("古い情報の映画");

    // 応答のあと、裏で TMDb から取り直される。
    await settleBackgroundTasks();
    expect(renderHome(await loadHome(user))).toContain("新しい情報の映画");
  });

  it("裏での取り直しに失敗しても、画面はエラーにならない（AC10）", async () => {
    const user = await createUser();
    await add(user, 1, theater, { title: "古い情報の映画", fetchedAt: "2020-01-01T00:00:00.000Z" });
    mockFetch(() => new Response("error", { status: 500 }));
    expect(renderHome(await loadHome(user))).toContain("古い情報の映画");
    await settleBackgroundTasks();
    expect(renderList(await loadList(user))).toContain("古い情報の映画");
  });

  it("未ログインでは 401", async () => {
    await expect(homeLoader(routeArgs({ user: null }))).rejects.toMatchObject({ status: 401 });
    await expect(listLoader(routeArgs({ user: null }))).rejects.toMatchObject({ status: 401 });
  });
});

describe("リスト（/list）", () => {
  const seed = async () => {
    const user = await createUser();
    await add(user, 1, theater, { releaseDate: "2026-02-01" });
    await add(user, 2, theater, { releaseDate: "2026-01-01" });
    await add(user, 3, streaming);
    await add(user, 4, watched("2026-01-09"));
    await add(user, 5, skipped);
    await add(user, 6, watched("2026-01-10"));
    return user;
  };

  it("区分ごとに、条件に合う映画をすべて返す（AC8）", async () => {
    const user = await seed();
    expect(ids((await loadList(user, "?filter=theater")).items)).toEqual([2, 1]);
    expect(ids((await loadList(user, "?filter=streaming")).items)).toEqual([3]);
    expect(ids((await loadList(user, "?filter=watched")).items)).toEqual([6, 4]);
    expect(ids((await loadList(user, "?filter=skipped")).items)).toEqual([5]);
  });

  it("「すべて」は、更新が新しい順で全件を返す。不正な filter は「すべて」として扱う（AC8）", async () => {
    const user = await seed();
    const all = await loadList(user);
    expect(all.filter).toBe("all");
    expect(ids(all.items)).toEqual([6, 5, 4, 3, 2, 1]);

    const invalid = await loadList(user, "?filter=%27%20OR%201%3D1");
    expect(invalid.filter).toBe("all");
    expect(invalid.items).toHaveLength(6);
  });

  it("5本を超えても、視聴済みをすべて返す（トップページと違い、上限がない）", async () => {
    const user = await createUser();
    for (let i = 1; i <= 8; i++) await add(user, i, watched(`2026-01-0${i}`));
    expect((await loadList(user, "?filter=watched")).items).toHaveLength(8);
  });

  it("見送りにした映画を、ここで見返せる", async () => {
    const user = await seed();
    const html = renderList(await loadList(user, "?filter=skipped"));
    expect(html).toContain("映画5");
    expect(html).toContain('data-state="skipped"');
    expect(html).toContain("見送り");
    expect(html).toMatch(/aria-selected="true"[^>]*>見送り|>見送り<\/a>/);
  });

  it("選択中のタブが分かり、各タブのリンク先が正しい", async () => {
    const user = await seed();
    const html = renderList(await loadList(user, "?filter=watched"));
    const tabs = [...html.matchAll(/<a\b[^>]*role="tab"[^>]*>([^<]+)<\/a>/g)].map((m) => ({
      label: m[1],
      href: /href="([^"]+)"/.exec(m[0])![1],
      selected: m[0].includes('aria-selected="true"'),
    }));
    expect(tabs).toEqual([
      { label: "すべて", href: "/list", selected: false },
      { label: "劇場", href: "/list?filter=theater", selected: false },
      { label: "サブスク", href: "/list?filter=streaming", selected: false },
      { label: "視聴済み", href: "/list?filter=watched", selected: true },
      { label: "見送り", href: "/list?filter=skipped", selected: false },
    ]);
  });

  it("0件のときは、「まだありません」と「映画を探す」へのリンクが出る（AC7）", async () => {
    const user = await createUser();
    const html = renderList(await loadList(user, "?filter=skipped"));
    expect(html).toContain("まだありません");
    expect(html).toContain('href="/search"');
  });
});
