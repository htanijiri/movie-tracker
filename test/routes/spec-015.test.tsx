import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { trailerChats, trailerFinds, userMovies } from "~/lib/db/schema";
import { listOpenTrailerHunts } from "~/lib/trailers.server";
import MovieDetailPage, { loader as movieLoader } from "~/routes/movie";
import TrailerHuntPage, { action, loader } from "~/routes/trailers";

import { catchThrown, createMovie, createUser, formRequest, mockFetch, ORIGIN, routeArgs, statusOf } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail, tmdbList } from "../helpers/tmdb-fixtures";

// 仕様書 015：終えた予告探しをもう一度探す。
// 見た映画は 1001（「映画A」）、気になった予告は3本、探すのを終えた日時は CLOSED_AT。

const VISIT = 1001;
const CLOSED_AT = "2026-10-05T00:00:00.000Z";

async function seedVisit(user: SessionUser, extra: Partial<typeof userMovies.$inferInsert> = {}) {
  await createMovie({ tmdbId: VISIT, title: "映画A" });
  await getDb().insert(userMovies).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tmdbId: VISIT,
    status: "WATCHED",
    watchedAt: "2026-10-04",
    watchedMedium: "THEATER",
    trailerCount: 3,
    trailerHuntClosedAt: CLOSED_AT,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...extra,
  });
}

async function addFind(user: SessionUser, candidate: number, result: "match" | "reject") {
  await createMovie({ tmdbId: candidate, title: `映画${candidate}` });
  await getDb().insert(trailerFinds).values({
    id: crypto.randomUUID(),
    userId: user.id,
    visitTmdbId: VISIT,
    candidateTmdbId: candidate,
    result,
    createdAt: "2026-10-04T12:00:00.000Z",
  });
}

/** TMDb（詳細と候補の一覧）と Anthropic への通信を差し替える。 */
function mockServices() {
  mockFetch(async (url) => {
    if (url.hostname === "api.anthropic.com") {
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_test",
            name: "show_candidates",
            input: { message: "どんな場面でしたか？", candidates: [] },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    if (url.pathname === `/3/movie/${VISIT}`) return Response.json(tmdbDetail(VISIT, { title: "映画A" }));
    return Response.json(tmdbList([]));
  });
}

const post = (user: SessionUser, fields: Record<string, string>, visit = VISIT) =>
  action(routeArgs({ request: formRequest(`/trailers/${visit}`, fields), params: { tmdbId: String(visit) }, user }));
const load = (user: SessionUser) => loader(routeArgs({ params: { tmdbId: String(VISIT) }, user }));
const renderHunt = (loaderData: Awaited<ReturnType<typeof loader>>) =>
  renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData });

const unwrap = (r: unknown) => {
  const w = r as { type?: string; data?: unknown; init?: ResponseInit | null };
  return w?.type === "DataWithResponseInit"
    ? { status: w.init?.status ?? 200, body: w.data as Record<string, unknown> }
    : { status: 200, body: r as Record<string, unknown> };
};

const closedAtOf = async (userId: string) =>
  (await env.DB.prepare("SELECT trailer_hunt_closed_at AS c FROM user_movies WHERE user_id = ? AND tmdb_id = ?")
    .bind(userId, VISIT)
    .first<{ c: string | null }>())!.c;

describe("映画の詳細画面の「予告を探す」の入り口（仕様書 015 AC1）", () => {
  const renderMovie = async (user: SessionUser) => {
    const loaderData = await movieLoader(
      routeArgs({ url: `${ORIGIN}/movies/${VISIT}`, params: { tmdbId: String(VISIT) }, user }),
    );
    return {
      loaderData,
      html: renderRoute(MovieDetailPage, { path: "/movies/:tmdbId", url: `/movies/${VISIT}`, loaderData }),
    };
  };

  it("終えた予告探しへのリンクを、進み具合つきで出す", async () => {
    const user = await createUser();
    await seedVisit(user);
    await addFind(user, 2001, "match");
    mockServices();

    const { loaderData, html } = await renderMovie(user);

    expect(loaderData.hunt).toMatchObject({ tmdbId: VISIT, closed: true, reopenable: true, found: 1 });
    expect(html).toContain("data-hunt-link");
    expect(html).toContain(`href="/trailers/${VISIT}"`);
    expect(html).toContain("探すのを終えました（3本中 1本）");
  });

  it("探している途中・すべて見つけた予告探しにも、それぞれの進み具合で出す", async () => {
    const user = await createUser();
    await seedVisit(user, { trailerHuntClosedAt: null });
    mockServices();
    expect((await renderMovie(user)).html).toContain("気になった予告 3本中 あと3本");

    await env.DB.prepare("UPDATE user_movies SET trailer_count = 1 WHERE user_id = ?").bind(user.id).run();
    await addFind(user, 2001, "match");
    expect((await renderMovie(user)).html).toContain("気になった予告 1本をすべて見つけました");
  });

  it.each([
    ["劇場以外で見た", { watchedMedium: "STREAMING" as const }],
    ["本数が0", { trailerCount: 0 }],
    ["本数が未入力", { trailerCount: null }],
    ["見ていない", { status: "WANT_TO_WATCH" as const, watchedAt: null, watchedMedium: null }],
  ])("%s映画には出さない", async (_, extra) => {
    const user = await createUser();
    await seedVisit(user, extra);
    mockServices();

    const { loaderData, html } = await renderMovie(user);

    expect(loaderData.hunt).toBeNull();
    expect(html).not.toContain("data-hunt-link");
  });

  it("リストにない映画には出さない", async () => {
    mockServices();
    const { loaderData, html } = await renderMovie(await createUser());
    expect(loaderData.hunt).toBeNull();
    expect(html).not.toContain("data-hunt-link");
  });
});

describe("「もう一度探す」（仕様書 015 AC2〜AC4）", () => {
  it("終えた予告探しにだけ「もう一度探す」を出す（AC2）", async () => {
    const user = await createUser();
    await seedVisit(user);
    mockServices();
    const html = renderHunt(await load(user));
    expect(html).toContain("data-reopen");
    expect(html).toContain("もう一度探す");
    expect(html).not.toContain('id="ai-message"');
  });

  it("探している途中・すべて見つけた予告探しには出さない（AC2）", async () => {
    const user = await createUser();
    await seedVisit(user, { trailerHuntClosedAt: null });
    mockServices();
    expect(renderHunt(await load(user))).not.toContain("data-reopen");

    await env.DB.prepare("UPDATE user_movies SET trailer_count = 1, trailer_hunt_closed_at = ? WHERE user_id = ?")
      .bind(CLOSED_AT, user.id)
      .run();
    await addFind(user, 2001, "match");
    const data = await load(user);
    expect(data.hunt.reopenable).toBe(false);
    expect(renderHunt(data)).not.toContain("data-reopen");
  });

  it("開き直すと、トップページの一覧に戻り、AI に相談でき、それまでの記録は残る（AC3）", async () => {
    const user = await createUser();
    await seedVisit(user);
    await addFind(user, 2001, "match");
    await addFind(user, 2002, "reject");
    await getDb().insert(trailerChats).values({
      id: crypto.randomUUID(),
      userId: user.id,
      visitTmdbId: VISIT,
      role: "user",
      content: "前に書いたこと",
      candidates: null,
      createdAt: "2026-10-04T13:00:00.000Z",
    });
    mockServices();
    expect(await listOpenTrailerHunts(getDb(), user.id)).toHaveLength(0);

    const res = unwrap(await post(user, { intent: "reopen" }));

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await closedAtOf(user.id)).toBeNull();
    expect((await listOpenTrailerHunts(getDb(), user.id)).map((h) => h.tmdbId)).toEqual([VISIT]);

    const data = await load(user);
    expect(data.hunt).toMatchObject({ closed: false, reopenable: false, found: 1 });
    expect(data.matched.map((m) => m.tmdbId)).toEqual([2001]);
    expect(data.rejectedCount).toBe(1);
    expect(data.ai.chats.map((c) => c.content)).toEqual(["前に書いたこと"]);
    const html = renderHunt(data);
    expect(html).toContain('id="ai-message"');
    expect(html).not.toContain("data-reopen");

    expect(unwrap(await post(user, { intent: "ask", message: "洋画のアクションだった" }))).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("すべて見つけた・探している途中の予告探しは、開き直せない（AC4）", async () => {
    const user = await createUser();
    await seedVisit(user, { trailerCount: 1 });
    await addFind(user, 2001, "match");
    mockServices();

    const allFound = unwrap(await post(user, { intent: "reopen" }));
    expect(allFound.status).toBe(400);
    expect(await closedAtOf(user.id)).toBe(CLOSED_AT);

    const other = await createUser();
    await getDb().insert(userMovies).values({
      id: crypto.randomUUID(),
      userId: other.id,
      tmdbId: VISIT,
      status: "WATCHED",
      watchedAt: "2026-10-04",
      watchedMedium: "THEATER",
      trailerCount: 3,
      trailerHuntClosedAt: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(unwrap(await post(other, { intent: "reopen" })).status).toBe(400);
  });

  it("ほかの利用者の予告探しは開き直せない（AC4）", async () => {
    const owner = await createUser();
    await seedVisit(owner);
    mockServices();

    const stranger = await createUser();
    const thrown = await catchThrown(() => post(stranger, { intent: "reopen" }));
    expect(statusOf(thrown)).toBe(404);
    expect(await closedAtOf(owner.id)).toBe(CLOSED_AT);
  });
});
