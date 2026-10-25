import { describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { userMovies } from "~/lib/db/schema";
import Home, { loader as homeLoader } from "~/routes/home";
import List, { loader as listLoader } from "~/routes/list";
import MovieDetailPage, { loader as movieLoader } from "~/routes/movie";

import { createMovie, createUser, mockFetch, ORIGIN, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

// 仕様書 010（公開◯週目・そろそろ上映終了かも）と 011（近日公開）の表示の場所。

/** 今日（日本時間）から n 日ずらした日付。 */
function shift(days: number): string {
  const d = new Date(`${todayInTokyo()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function add(user: SessionUser, tmdbId: number, record: Partial<typeof userMovies.$inferInsert>, releaseDate: string | null) {
  await createMovie({ tmdbId, title: `映画${tmdbId}`, releaseDate });
  await getDb().insert(userMovies).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tmdbId,
    status: "WANT_TO_WATCH",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...record,
  });
}
const theater = { status: "WANT_TO_WATCH", preferredMedium: "THEATER" } as const;

const cardOf = (html: string, id: number) =>
  new RegExp(`<a\\b[^>]*data-card="${id}"[^>]*>(.*?)</a>`, "s").exec(html)![1];
const releaseOf = (card: string) => {
  const m = /<span\b([^>]*data-release[^>]*)>(.*?)<\/span>/s.exec(card);
  return m ? { text: m[2], warning: m[1].includes('data-release-warning="true"') } : null;
};

describe("カードの公開日の表示（仕様書 010・011）", () => {
  it("劇場で見たいのカードに、公開◯週目・そろそろ上映終了かも・明日公開が出る（010 AC2・AC4、011 AC3）", async () => {
    const user = await createUser();
    await add(user, 1, theater, shift(-10)); // 公開2週目
    await add(user, 2, theater, shift(-28)); // そろそろ上映終了かも
    await add(user, 3, theater, shift(-27)); // 4週目（まだ注意は出ない）
    await add(user, 4, theater, shift(1)); // 明日公開

    for (const html of [
      renderRoute(Home, { path: "/", loaderData: await homeLoader(routeArgs({ user })) }),
      renderRoute(List, { path: "/list", loaderData: await listLoader(routeArgs({ url: `${ORIGIN}/list?filter=theater`, user })) }),
    ]) {
      expect(releaseOf(cardOf(html, 1))).toEqual({ text: "公開2週目", warning: false });
      expect(releaseOf(cardOf(html, 2))).toEqual({ text: "公開5週目・そろそろ上映終了かも", warning: true });
      expect(releaseOf(cardOf(html, 3))).toEqual({ text: "公開4週目", warning: false });
      expect(releaseOf(cardOf(html, 4))).toEqual({ text: "明日公開", warning: false });
    }
  });

  it("サブスク待ち・視聴済み・見送りのカードには出さない（010 AC4）", async () => {
    const user = await createUser();
    await add(user, 1, { status: "WANT_TO_WATCH", preferredMedium: "STREAMING" }, shift(-30));
    await add(user, 2, { status: "WATCHED", watchedAt: "2026-01-01", watchedMedium: "THEATER" }, shift(-30));
    await add(user, 3, { status: "SKIPPED", preferredMedium: "NONE" }, shift(-30));
    const html = renderRoute(List, { path: "/list", loaderData: await listLoader(routeArgs({ url: `${ORIGIN}/list`, user })) });
    for (const id of [1, 2, 3]) expect(releaseOf(cardOf(html, id))).toBeNull();
  });
});

describe("詳細画面の公開日の表示（仕様書 010・011）", () => {
  async function detailHtml(user: SessionUser, releaseDate: string) {
    mockFetch(() => Response.json(tmdbDetail(1, { release_date: releaseDate })));
    const loaderData = await movieLoader(routeArgs({ params: { tmdbId: "1" }, user }));
    return renderRoute(MovieDetailPage, { path: "/movies/:tmdbId", url: "/movies/1", loaderData });
  }

  it("記録が「劇場で見たい」の映画にだけ出る（010 AC5、011 AC3）", async () => {
    const user = await createUser();
    await add(user, 1, theater, null);
    const showing = await detailHtml(user, shift(-30));
    expect(releaseOf(showing)).toEqual({ text: "公開5週目・そろそろ上映終了かも", warning: true });

    const upcoming = await detailHtml(user, shift(1));
    expect(releaseOf(upcoming)).toEqual({ text: "明日公開", warning: false });
  });

  it("未登録・サブスク待ちの映画には出ない（2016年の映画に「公開500週目」と出さない）", async () => {
    const user = await createUser();
    expect(releaseOf(await detailHtml(user, "2016-07-29"))).toBeNull();
    await getDb().insert(userMovies).values({
      id: crypto.randomUUID(), userId: user.id, tmdbId: 1, status: "WANT_TO_WATCH", preferredMedium: "STREAMING",
      createdAt: "x", updatedAt: "x",
    });
    expect(releaseOf(await detailHtml(user, "2016-07-29"))).toBeNull();
  });
});
