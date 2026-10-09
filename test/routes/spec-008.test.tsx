import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MyRecord } from "~/components/MyRecord";
import type { SessionUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { userMovies, type WatchedMedium } from "~/lib/db/schema";
import { getUserMovie, listPlaceSuggestions } from "~/lib/db/user-movies.server";
import { todayInTokyo } from "~/lib/date";
import Home, { loader as homeLoader } from "~/routes/home";
import List, { loader as listLoader } from "~/routes/list";
import MovieDetailPage, { action, loader } from "~/routes/movie";

import {
  createMovie,
  createUser,
  formRequest,
  mockFetch,
  ORIGIN,
  routeArgs,
} from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

// 仕様書 008：「見た」の選択表示と、一覧での視聴方法の表示。

const post = (user: SessionUser, tmdbId: number, fields: Record<string, string>) =>
  action(
    routeArgs({
      request: formRequest(`/movies/${tmdbId}`, fields),
      params: { tmdbId: String(tmdbId) },
      user,
    }),
  );

/** 「自分の記録」の部品だけを、入力欄の開閉の状態を指定して描画する。 */
async function renderRecord(user: SessionUser, watchedOpen: boolean, tmdbId = 1001) {
  const db = getDb();
  const record = await getUserMovie(db, user.id, tmdbId);
  const suggestions = await listPlaceSuggestions(db, user.id);
  return renderRoute(() => (
    <MyRecord
      record={record}
      today={todayInTokyo()}
      suggestions={suggestions}
      defaultWatchedOpen={watchedOpen}
    />
  ));
}

const mediumButtons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('name="medium"'))
    .map((tag) => ({
      value: /value="([^"]+)"/.exec(tag)![1],
      pressed: tag.includes('aria-pressed="true"'),
      primary: /class="[^"]*\bbtn-primary\b/.test(tag),
    }));

/** 「見た」の入力欄（details）と、その見出し（summary）のタグを取り出す。 */
function watchedToggle(html: string) {
  const m = /<details\b[^>]*data-watched-form[^>]*>\s*(<summary\b[^>]*>)/.exec(html)!;
  return {
    open: m[0].startsWith("<details") && /<details\b[^>]*\sopen=""/.test(m[0]),
    selected: m[1].includes('data-selected="true"'),
    primary: /class="[^"]*\bbtn-primary\b/.test(m[1]),
    selectable: /class="[^"]*\bbtn-selectable\b/.test(m[1]),
  };
}

describe("「見た」を押したときの見た目（仕様書 008）", () => {
  const registered = async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    return user;
  };

  it("入力欄が閉じているときは、登録済みの区分のボタンだけが強調される（AC1）", async () => {
    const html = await renderRecord(await registered(), false);
    expect(mediumButtons(html)).toEqual([
      { value: "THEATER", pressed: true, primary: true },
      { value: "STREAMING", pressed: false, primary: false },
      { value: "NONE", pressed: false, primary: false },
    ]);
  });

  it("入力欄が開いているときは、3つのボタンのどれも強調されない（AC1）", async () => {
    const html = await renderRecord(await registered(), true);
    expect(mediumButtons(html)).toEqual([
      { value: "THEATER", pressed: false, primary: false },
      { value: "STREAMING", pressed: false, primary: false },
      { value: "NONE", pressed: false, primary: false },
    ]);
  });

  it("入力欄が開いているときだけ、「見た」が選択中の見た目になる（AC2）", async () => {
    const user = await registered();
    expect(watchedToggle(await renderRecord(user, true))).toEqual({
      open: true,
      selected: true,
      primary: true,
      selectable: true,
    });
    expect(watchedToggle(await renderRecord(user, false))).toEqual({
      open: false,
      selected: false,
      primary: false,
      // JavaScript が動かないときも、開いている間の強調が CSS で付くようにするためのクラス。
      selectable: true,
    });
  });

  it("未登録の映画でも、入力欄を開くと「見た」が選択中の見た目になる", async () => {
    const user = await createUser();
    await createMovie();
    const html = await renderRecord(user, true);
    expect(watchedToggle(html).selected).toBe(true);
    expect(mediumButtons(html).some((b) => b.pressed)).toBe(false);
  });

  it("入力欄を開いただけでは、何も記録されない（AC3）", async () => {
    const user = await registered();
    const before = await env.DB.prepare("SELECT * FROM user_movies").all();
    await renderRecord(user, true);
    const after = await env.DB.prepare("SELECT * FROM user_movies").all();
    expect(after.results).toEqual(before.results);
    expect(after.results[0]).toMatchObject({
      status: "WANT_TO_WATCH",
      preferred_medium: "THEATER",
      watched_at: null,
    });
  });

  it("入力エラーで戻ってきたときも、「見た」が選択中で、3つのボタンは強調されない（AC4）", async () => {
    const user = await registered();
    const result = (await post(user, 1001, {
      intent: "save-watched",
      watchedAt: "2999-01-01",
      watchedMedium: "THEATER",
    })) as { data: unknown };

    mockFetch(() => Response.json(tmdbDetail(1001)));
    const loaderData = await loader(routeArgs({ params: { tmdbId: "1001" }, user }));
    const html = renderRoute(MovieDetailPage, {
      path: "/movies/:tmdbId",
      url: "/movies/1001",
      loaderData,
      actionData: result.data,
    });

    expect(watchedToggle(html)).toMatchObject({ open: true, selected: true, primary: true });
    expect(mediumButtons(html).some((b) => b.pressed)).toBe(false);
    expect(html).toContain("見た日に、今日より後の日付は入力できません。");
  });

  it("視聴済みの映画の画面には、3つのボタンも「見た」の入力欄も出ない（これまでどおり）", async () => {
    const user = await registered();
    await post(user, 1001, { intent: "save-watched", watchedAt: "2026-01-10", watchedMedium: "THEATER" });
    const html = await renderRecord(user, false);
    expect(mediumButtons(html)).toEqual([]);
    expect(html).not.toContain("data-watched-form");
    expect(html).toContain('data-watched="summary"');
  });
});

describe("一覧のカードの「どこで見たか」のラベル（仕様書 008）", () => {
  let seq = 0;
  async function add(
    user: SessionUser,
    tmdbId: number,
    record: Partial<typeof userMovies.$inferInsert>,
  ) {
    seq += 1;
    const stamp = `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`;
    await createMovie({ tmdbId, title: `映画${tmdbId}` });
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
  const watched = (medium: WatchedMedium, day: number, place?: string) =>
    ({
      status: "WATCHED",
      watchedAt: `2026-01-0${day}`,
      watchedMedium: medium,
      watchedPlace: place ?? null,
    }) as const;

  /** HTML から、あるカード（映画）の部分だけを取り出す。 */
  const cardOf = (html: string, tmdbId: number) =>
    new RegExp(`<a\\b[^>]*data-card="${tmdbId}"[^>]*>(.*?)</a>`, "s").exec(html)![1];
  /** カードの中の、「どこで見たか」のラベルの文字（タグを除く）。なければ null。 */
  const badgeOf = (card: string) => {
    const m = /<span\b[^>]*data-watched-medium="([A-Z]+)"[^>]*>(.*?)<\/span>\s*(?:<span\b[^>]*data-release|<\/p>)/s.exec(card);
    return m ? { medium: m[1], text: m[2].replace(/<[^>]+>/g, "").trim() } : null;
  };

  const seed = async () => {
    const user = await createUser();
    await add(user, 1, watched("THEATER", 4, "映画館X"));
    await add(user, 2, watched("STREAMING", 3, "配信サービスA"));
    await add(user, 3, watched("RENTAL", 2));
    await add(user, 4, watched("OTHER", 1));
    await add(user, 5, { status: "WANT_TO_WATCH", preferredMedium: "THEATER" });
    await add(user, 6, { status: "WANT_TO_WATCH", preferredMedium: "STREAMING" });
    await add(user, 7, { status: "SKIPPED", preferredMedium: "NONE" });
    return user;
  };

  const renderList = async (user: SessionUser, query: string) =>
    renderRoute(List, {
      path: "/list",
      loaderData: await listLoader(routeArgs({ url: `${ORIGIN}/list${query}`, user })),
    });
  const renderHome = async (user: SessionUser) =>
    renderRoute(Home, { path: "/", loaderData: await homeLoader(routeArgs({ user })) });

  it("視聴済みのカードに、視聴方法ごとのラベルが出る（AC5）", async () => {
    const html = await renderList(await seed(), "?filter=watched");
    expect(badgeOf(cardOf(html, 1))).toEqual({ medium: "THEATER", text: "🎬劇場" });
    expect(badgeOf(cardOf(html, 2))).toEqual({ medium: "STREAMING", text: "📺サブスク" });
    expect(badgeOf(cardOf(html, 3))).toEqual({ medium: "RENTAL", text: "💿レンタル・購入" });
    expect(badgeOf(cardOf(html, 4))).toEqual({ medium: "OTHER", text: "📍その他" });
  });

  it("ラベルは、「視聴済み」のラベルのすぐ右に並ぶ", async () => {
    const card = cardOf(await renderList(await seed(), "?filter=watched"), 1);
    const state = card.indexOf('data-state="watched"');
    const medium = card.indexOf("data-watched-medium=");
    const line = card.indexOf("data-watched-line");
    expect(state).toBeGreaterThan(-1);
    expect(medium).toBeGreaterThan(state);
    expect(line).toBeGreaterThan(medium);
  });

  it("視聴済みでないカードには、ラベルが出ない（AC6）", async () => {
    const html = await renderList(await seed(), "");
    for (const id of [5, 6, 7]) {
      expect(cardOf(html, id)).not.toContain("data-watched-medium");
    }
  });

  it("下の行は「見た日 ・ 場所」。場所が未入力なら見た日だけで、視聴方法の文言を重ねて出さない（AC7）", async () => {
    const html = await renderList(await seed(), "?filter=watched");
    const lineOf = (id: number) =>
      /<p[^>]*data-watched-line[^>]*>(.*?)<\/p>/s.exec(cardOf(html, id))![1];
    expect(lineOf(1)).toBe("2026/01/04 ・ 映画館X");
    expect(lineOf(2)).toBe("2026/01/03 ・ 配信サービスA");
    expect(lineOf(3)).toBe("2026/01/02");
    expect(lineOf(4)).toBe("2026/01/01");
    expect(lineOf(3)).not.toContain("レンタル");
  });

  it("トップページの「最近見た」、リストの「視聴済み」「すべて」の3か所で、同じラベルが出る（AC8）", async () => {
    const user = await seed();
    const pages = [
      await renderHome(user),
      await renderList(user, "?filter=watched"),
      await renderList(user, ""),
    ];
    for (const html of pages) {
      expect(badgeOf(cardOf(html, 1))).toEqual({ medium: "THEATER", text: "🎬劇場" });
      expect(badgeOf(cardOf(html, 2))).toEqual({ medium: "STREAMING", text: "📺サブスク" });
    }
    // トップページの「劇場で見たい」「サブスク待ち」のカードには出ない。
    expect(cardOf(pages[0], 5)).not.toContain("data-watched-medium");
    expect(cardOf(pages[0], 6)).not.toContain("data-watched-medium");
  });
});
