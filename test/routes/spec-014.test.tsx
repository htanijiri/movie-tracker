import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { trailerChats, trailerFinds, userMovies } from "~/lib/db/schema";
import {
  AI_ERROR_MESSAGE,
  AI_LIMIT_MESSAGE,
  AI_REFUSAL_MESSAGE,
  countAiRepliesToday,
  DAILY_AI_REPLIES,
} from "~/lib/trailer-chats.server";
import { action as movieAction } from "~/routes/movie";
import TrailerHuntPage, { action, loader } from "~/routes/trailers";

import { catchThrown, createMovie, createUser, formRequest, mockFetch, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbList, tmdbMovie } from "../helpers/tmdb-fixtures";

// 仕様書 014：AI に相談して予告を探す。Anthropic の API と TMDb は fetch の差し替えでモックする。
// 見た映画は 1001（「映画A」）、見た日は 2026-10-04、映画館は「映画館X」、感想は「とても良かった感想」。

const VISIT = 1001;
const PLACE = "映画館X";
const REVIEW = "とても良かった感想";

async function seedVisit(user: SessionUser, extra: Partial<typeof userMovies.$inferInsert> = {}) {
  await createMovie({ tmdbId: VISIT, title: "映画A" });
  await insertVisitRecord(user, extra);
}

async function insertVisitRecord(user: SessionUser, extra: Partial<typeof userMovies.$inferInsert> = {}) {
  await getDb().insert(userMovies).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tmdbId: VISIT,
    status: "WATCHED",
    watchedAt: "2026-10-04",
    watchedMedium: "THEATER",
    watchedPlace: PLACE,
    rating: 5,
    review: REVIEW,
    trailerCount: 2,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...extra,
  });
}

const ask = (user: SessionUser, message: string, visit = VISIT) =>
  action(
    routeArgs({
      request: formRequest(`/trailers/${visit}`, { intent: "ask", message }),
      params: { tmdbId: String(visit) },
      user,
    }),
  );
const post = (user: SessionUser, fields: Record<string, string>) =>
  action(routeArgs({ request: formRequest(`/trailers/${VISIT}`, fields), params: { tmdbId: String(VISIT) }, user }));
const load = (user: SessionUser) => loader(routeArgs({ params: { tmdbId: String(VISIT) }, user }));

const unwrap = (r: unknown) => {
  const w = r as { type?: string; data?: unknown; init?: ResponseInit | null };
  return w?.type === "DataWithResponseInit"
    ? { status: w.init?.status ?? 200, body: w.data as Record<string, unknown> }
    : { status: 200, body: r as Record<string, unknown> };
};

type ToolInput = {
  message: string;
  candidates: { tmdb_id: number; title: string; original_title: string; year: number; reason: string }[];
};

function aiMessage(input: ToolInput | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [
      { type: "text", text: "調べてみます。" },
      ...(input ? [{ type: "tool_use", id: "toolu_test", name: "show_candidates", input }] : []),
    ],
    stop_reason: input ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    },
    ...overrides,
  };
}

type AiHandler = (body: Record<string, unknown>) => Response | Promise<Response>;

/**
 * Anthropic と TMDb への通信を差し替える。TMDb の候補は 2001〜2003（2002 は原題つき）。
 * タイトル検索は、`searchResults` に登録したタイトルだけ見つかる。
 */
function mockServices(
  aiHandler: AiHandler,
  { searchResults = {} as Record<string, unknown[]>, tmdbFail = false } = {},
) {
  const aiBodies: Record<string, unknown>[] = [];
  const searches: URL[] = [];
  mockFetch(async (url, request) => {
    if (url.hostname === "api.anthropic.com") {
      const body = (await request.json()) as Record<string, unknown>;
      aiBodies.push(body);
      return aiHandler(body);
    }
    if (tmdbFail) return new Response("error", { status: 500 });
    if (url.pathname === "/3/search/movie") {
      searches.push(url);
      return Response.json(tmdbList(searchResults[url.searchParams.get("query") ?? ""] ?? []));
    }
    const page = Number(url.searchParams.get("page"));
    return Response.json(
      tmdbList(
        page === 1
          ? [tmdbMovie(2001), tmdbMovie(2002, { original_title: "Movie Two" }), tmdbMovie(2003), tmdbMovie(VISIT)]
          : [],
      ),
    );
  });
  return { aiBodies, searches };
}

const chatRows = (userId: string) =>
  env.DB.prepare("SELECT role, content, candidates FROM trailer_chats WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<{ role: string; content: string; candidates: string | null }>()
    .then((r) => r.results);

describe("「見た」の保存から「予告を探す」へ（仕様書 014 AC1）", () => {
  const postWatched = (user: SessionUser, extra: Record<string, string>) =>
    movieAction(
      routeArgs({
        request: formRequest(`/movies/${VISIT}`, {
          intent: "save-watched",
          watchedAt: "2026-10-04",
          watchedMedium: "THEATER",
          ...extra,
        }),
        params: { tmdbId: String(VISIT) },
        user,
      }),
    );

  it("劇場で「気になった予告」を1本以上にして保存すると、「予告を探す」へリダイレクトする", async () => {
    const user = await createUser();
    await createMovie();
    const thrown = await catchThrown(() => postWatched(user, { trailerChoice: "2" }));
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe(`/trailers/${VISIT}`);
  });

  it.each<Record<string, string>>([
    { trailerChoice: "" },
    { trailerChoice: "0" },
    { watchedMedium: "STREAMING", trailerChoice: "2" },
  ])("本数0・未選択・劇場以外 %j はリダイレクトしない", async (extra) => {
    const user = await createUser();
    await createMovie();
    expect(unwrap(await postWatched(user, extra)).status).toBe(200);
  });

  it("探し終えた予告探しは、保存し直してもリダイレクトしない", async () => {
    const user = await createUser();
    await seedVisit(user, { trailerHuntClosedAt: "2026-10-05T00:00:00.000Z" });
    expect(unwrap(await postWatched(user, { trailerChoice: "2" })).status).toBe(200);
  });
});

describe("AI に送る内容（仕様書 014 AC2）", () => {
  it("Sonnet 5.5 と Web 検索（最大5回）で呼び、見た映画・候補・「違う」・会話だけを送る。映画館・★・感想・メールアドレスは送らない", async () => {
    const user = await createUser();
    await seedVisit(user);
    await createMovie({ tmdbId: 2003, title: "映画2003" });
    await getDb().insert(trailerFinds).values({
      id: crypto.randomUUID(),
      userId: user.id,
      visitTmdbId: VISIT,
      candidateTmdbId: 2003,
      result: "reject",
      createdAt: "2026-10-05T00:00:00.000Z",
    });
    const { aiBodies } = mockServices(() => Response.json(aiMessage({ message: "どんな場面でしたか？", candidates: [] })));

    await ask(user, "洋画のアクションだった");
    await ask(user, "カーチェイスがあった");

    expect(aiBodies).toHaveLength(2);
    const body = aiBodies[1];
    expect(body.model).toBe("claude-sonnet-5-5");
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toContainEqual(expect.objectContaining({ type: "web_search_20260209", max_uses: 5 }));
    expect(tools).toContainEqual(expect.objectContaining({ name: "show_candidates", strict: true }));
    expect(body.tool_choice).toBeUndefined(); // Sonnet 5.5 では強制指定が 400 になる

    const system = JSON.stringify(body.system);
    expect(system).toContain("「映画A」（見た日：2026-10-04）");
    expect(system).toContain("2001｜映画2001｜Movie 2001｜2026-01-10");
    expect(system).not.toContain(`${VISIT}｜`); // 見た映画そのものは候補に入れない

    const messages = body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0].content).toContain("洋画のアクションだった");
    expect(messages[1].content).toBe("どんな場面でしたか？");
    expect(messages[2].content).toContain("「映画2003」");
    expect(messages[2].content).toContain("カーチェイスがあった");

    const all = JSON.stringify(aiBodies);
    expect(all).not.toContain(PLACE);
    expect(all).not.toContain(REVIEW);
    expect(all).not.toContain("owner@example.com");
    expect(all).not.toMatch(/rating|★/);
  });
});

describe("会話と候補のカード（仕様書 014 AC3・AC4・AC8）", () => {
  it("返答と候補を保存して表示する。一覧にない作品はタイトルと公開年で特定し、特定できない作品はカードにしない", async () => {
    const user = await createUser();
    await seedVisit(user);
    const { searches } = mockServices(
      () =>
        Response.json(
          aiMessage({
            message: "この3本のどれかだと思います。",
            candidates: [
              { tmdb_id: 2002, title: "映画2002", original_title: "Movie Two", year: 2026, reason: "カーチェイスの予告が公開されている" },
              { tmdb_id: 0, title: "映画X", original_title: "Movie X", year: 2027, reason: "来春公開の洋画アクション" },
              { tmdb_id: 0, title: "存在しない映画", original_title: "", year: 0, reason: "念のため" },
              { tmdb_id: VISIT, title: "映画A", original_title: "", year: 0, reason: "見た映画（除く）" },
            ],
          }),
        ),
      { searchResults: { 映画X: [tmdbMovie(3001, { title: "映画X", release_date: "2027-03-01" })] } },
    );

    const result = await ask(user, "洋画のアクションで、カーチェイスがあった");
    expect(unwrap(result).body).toEqual({ ok: true });

    // 一覧にない「映画X」は公開年つきで検索し、「存在しない映画」は見つからない。
    expect(searches.map((u) => [u.searchParams.get("query"), u.searchParams.get("year")])).toEqual(
      expect.arrayContaining([
        ["映画X", "2027"],
        ["存在しない映画", null],
      ]),
    );

    const rows = await chatRows(user.id);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(JSON.parse(rows[1].candidates!)).toEqual([
      { tmdbId: 2002, reason: "カーチェイスの予告が公開されている" },
      { tmdbId: 3001, reason: "来春公開の洋画アクション" },
    ]);

    const data = await load(user);
    expect(data.ai.chats).toHaveLength(2);
    expect(data.ai.chats[1].content).toBe("この3本のどれかだと思います。");
    expect(data.ai.chats[1].candidates.map((c) => [c.tmdbId, c.title, c.reason])).toEqual([
      [2002, "映画2002", "カーチェイスの予告が公開されている"],
      [3001, "映画X", "来春公開の洋画アクション"],
    ]);

    const html = renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data });
    expect(html).toContain("AI に相談");
    expect(html).toContain("この3本のどれかだと思います。");
    expect(html).toContain("来春公開の洋画アクション");
    expect(html).toContain(`今日はあと${DAILY_AI_REPLIES - 1}回使えます`);

    // 「違う」にした候補・「これだった」にした候補は、AI の候補からも消える。
    await post(user, { intent: "reject", candidate: "2002" });
    await post(user, { intent: "match", candidate: "3001", medium: "THEATER" });
    const after = await load(user);
    expect(after.ai.chats[1].candidates).toEqual([]);
    expect(after.matched.map((m) => m.tmdbId)).toEqual([3001]);
  });

  it("会話は予告探しごとに保存され、見た記録の取り消し・リストからの削除で消える。他の利用者には見えない", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await seedVisit(me);
    mockServices(() => Response.json(aiMessage({ message: "候補です。", candidates: [] })));
    await ask(me, "アニメだった");

    // 他の利用者は、自分の見た記録がないので開けない（404）。
    const thrown = await catchThrown(() => load(other));
    expect((thrown as { init?: ResponseInit }).init?.status).toBe(404);
    expect(await chatRows(other.id)).toEqual([]);

    expect(await chatRows(me.id)).toHaveLength(2);
    await movieAction(
      routeArgs({ request: formRequest(`/movies/${VISIT}`, { intent: "unwatch" }), params: { tmdbId: String(VISIT) }, user: me }),
    );
    expect(await chatRows(me.id)).toEqual([]);

    // リストから消したときも消える。
    await env.DB.prepare("DELETE FROM user_movies WHERE user_id = ?").bind(me.id).run();
    await insertVisitRecord(me);
    await ask(me, "アニメだった");
    expect(await chatRows(me.id)).toHaveLength(2);
    await movieAction(
      routeArgs({ request: formRequest(`/movies/${VISIT}`, { intent: "remove" }), params: { tmdbId: String(VISIT) }, user: me }),
    );
    expect(await chatRows(me.id)).toEqual([]);
  });

  it("AI の候補が100本を超えても表示できる（D1 の値の上限を超えないよう分けて読む）", async () => {
    const user = await createUser();
    await seedVisit(user);
    const ids = Array.from({ length: 120 }, (_, i) => 5000 + i);
    for (const id of ids) await createMovie({ tmdbId: id, title: `映画${id}` });
    await getDb().insert(trailerChats).values({
      id: crypto.randomUUID(),
      userId: user.id,
      visitTmdbId: VISIT,
      role: "assistant",
      content: "たくさん",
      candidates: ids.map((tmdbId) => ({ tmdbId, reason: "理由" })),
      createdAt: new Date().toISOString(),
    });
    mockServices(() => Response.json(aiMessage({ message: "x", candidates: [] })));
    const data = await load(user);
    expect(data.ai.chats[0].candidates).toHaveLength(120);
  });

  it("入力が空・1,000文字を超える・探し終えた予告探しは 400", async () => {
    const user = await createUser();
    await seedVisit(user);
    mockServices(() => Response.json(aiMessage({ message: "x", candidates: [] })));
    expect(unwrap(await ask(user, "  ")).status).toBe(400);
    expect(unwrap(await ask(user, "あ".repeat(1001))).status).toBe(400);
    expect(unwrap(await ask(user, "あ".repeat(1000))).status).toBe(200);
    await post(user, { intent: "close" });
    expect(unwrap(await ask(user, "アニメだった")).status).toBe(400);
  });
});

describe("1日の上限（仕様書 014 AC5）", () => {
  async function seedReplies(userId: string, createdAt: string, n: number) {
    // D1 は1つの SQL に渡せる値の数に上限があるので、1行ずつ入れる。
    for (let i = 0; i < n; i++) {
      await getDb().insert(trailerChats).values({
        id: crypto.randomUUID(),
        userId,
        visitTmdbId: VISIT,
        role: "assistant",
        content: "返答",
        candidates: [],
        createdAt,
      });
    }
  }

  it("日本時間の今日の返答を数える", async () => {
    const user = await createUser();
    const now = new Date("2026-11-23T15:30:00.000Z"); // 日本時間 11/24 0:30
    await seedReplies(user.id, "2026-11-23T14:59:59.000Z", 3); // 日本時間 11/23 23:59（昨日）
    await seedReplies(user.id, "2026-11-23T15:00:00.000Z", 2); // 日本時間 11/24 0:00（今日）
    expect(await countAiRepliesToday(getDb(), user.id, now)).toBe(2);
  });

  it(`${DAILY_AI_REPLIES}回に達したら、API を呼ばずに案内を出す`, async () => {
    const user = await createUser();
    await seedVisit(user);
    await seedReplies(user.id, new Date().toISOString(), DAILY_AI_REPLIES);
    const { aiBodies } = mockServices(() => Response.json(aiMessage({ message: "x", candidates: [] })));

    const { body } = unwrap(await ask(user, "アニメだった"));
    expect(body).toMatchObject({ ok: false, error: AI_LIMIT_MESSAGE });
    expect(aiBodies).toHaveLength(0);

    const data = await load(user);
    expect(data.ai.repliesLeft).toBe(0);
    const html = renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data });
    expect(html).toContain("今日の分は使い切りました");
  });
});

describe("AI が失敗したとき（仕様書 014 AC6）", () => {
  it.each<[string, AiHandler, string]>([
    ["エラー（400）", () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: 400 }), AI_ERROR_MESSAGE],
    ["通信の失敗", () => { throw new TypeError("network down"); }, AI_ERROR_MESSAGE],
    ["拒否", () => Response.json(aiMessage(null, { stop_reason: "refusal", content: [] })), AI_REFUSAL_MESSAGE],
  ])("%s：案内を出し、会話にも残さず、回数も減らさない", async (_label, handler, message) => {
    const user = await createUser();
    await seedVisit(user);
    mockServices(handler);

    const result = unwrap(await ask(user, "アニメだった"));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: false, error: message, message: "アニメだった" });
    expect(await chatRows(user.id)).toEqual([]);
    expect(await countAiRepliesToday(getDb(), user.id)).toBe(0);
  });

  it("TMDb が応答しなくても、候補の一覧なしで AI に相談できる", async () => {
    const user = await createUser();
    await seedVisit(user);
    const { aiBodies } = mockServices(() => Response.json(aiMessage({ message: "候補です。", candidates: [] })), {
      tmdbFail: true,
    });
    expect(unwrap(await ask(user, "アニメだった")).body).toEqual({ ok: true });
    expect(JSON.stringify(aiBodies[0].system)).toContain("（取得できませんでした）");
  });

  it("ツールを呼ばずに終わったときは、本文を返答として保存する", async () => {
    const user = await createUser();
    await seedVisit(user);
    mockServices(() => Response.json(aiMessage(null)));
    await ask(user, "アニメだった");
    const rows = await chatRows(user.id);
    expect(rows[1]).toMatchObject({ role: "assistant", content: "調べてみます。" });
  });

  it("検索が長引いて止まった（pause_turn）ときは、応答を返して続きを頼む", async () => {
    const user = await createUser();
    await seedVisit(user);
    let call = 0;
    const { aiBodies } = mockServices(() => {
      call += 1;
      return Response.json(
        call === 1
          ? aiMessage(null, {
              stop_reason: "pause_turn",
              content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "映画 予告" } }],
            })
          : aiMessage({ message: "見つけました。", candidates: [] }),
      );
    });
    await ask(user, "アニメだった");
    expect(aiBodies).toHaveLength(2);
    const second = aiBodies[1].messages as { role: string; content: unknown }[];
    expect(second.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "server_tool_use" }] });
    expect((await chatRows(user.id))[1].content).toBe("見つけました。");
  });
});

describe("API キーがないとき（仕様書 014 AC7）", () => {
  const original = (env as unknown as Record<string, unknown>).ANTHROPIC_API_KEY;
  afterEach(() => {
    (env as unknown as Record<string, unknown>).ANTHROPIC_API_KEY = original;
  });

  it("「AI の設定がまだです」と出し、これまでの候補一覧はそのまま使える", async () => {
    (env as unknown as Record<string, unknown>).ANTHROPIC_API_KEY = "";
    const user = await createUser();
    await seedVisit(user);
    mockServices(() => Response.json(aiMessage({ message: "x", candidates: [] })));

    const data = await load(user);
    expect(data.ai.configured).toBe(false);
    expect(data.candidates.map((c) => c.tmdbId)).toEqual([2001, 2002, 2003]);
    const html = renderRoute(TrailerHuntPage, { path: "/trailers/:tmdbId", url: `/trailers/${VISIT}`, loaderData: data });
    expect(html).toContain("AI の設定がまだです");
    expect(unwrap(await ask(user, "アニメだった")).status).toBe(400);
  });
});
