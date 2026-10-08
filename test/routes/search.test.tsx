import { describe, expect, it } from "vitest";

import { getDb } from "~/lib/db/client.server";
import { userMovies } from "~/lib/db/schema";
import { TMDB_ERROR_MESSAGE } from "~/lib/site";
import Search, { loader } from "~/routes/search";

import { createMovie, createUser, mockFetch, ORIGIN, routeArgs } from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbList, tmdbMovie } from "../helpers/tmdb-fixtures";

type LoaderData = Awaited<ReturnType<typeof loader>>;

const load = async (path: string, user = undefined as Awaited<ReturnType<typeof createUser>> | undefined) =>
  loader(routeArgs({ url: `${ORIGIN}${path}`, user: user ?? (await createUser()) }));

const render = (data: LoaderData) => renderRoute(Search, { path: "/search", loaderData: data });

describe("映画を探す（/search）", () => {
  it("タイトル検索は、日本語・日本向けの条件とトークンを付けて TMDb を呼ぶ（AC1）", async () => {
    let called: { url: URL; request: Request } | undefined;
    mockFetch((url, request) => {
      called = { url, request };
      return Response.json(tmdbList([tmdbMovie(1)]));
    });

    await load(`/search?q=${encodeURIComponent("ゴジラ")}`);

    expect(called!.url.origin + called!.url.pathname).toBe(
      "https://api.themoviedb.org/3/search/movie",
    );
    expect(called!.url.searchParams.get("query")).toBe("ゴジラ");
    expect(called!.url.searchParams.get("language")).toBe("ja-JP");
    expect(called!.url.searchParams.get("region")).toBe("JP");
    expect(called!.url.searchParams.get("include_adult")).toBe("false");
    expect(called!.request.headers.get("Authorization")).toBe("Bearer test-tmdb-token");
    // トークンを URL に入れない。
    expect(called!.url.href).not.toContain("test-tmdb-token");
  });

  it("ブラウザに渡るデータと HTML に、トークンが含まれない（AC2）", async () => {
    mockFetch(() => Response.json(tmdbList([tmdbMovie(1), tmdbMovie(2)])));
    const data = await load("/search?q=a");
    expect(JSON.stringify(data)).not.toContain("test-tmdb-token");
    expect(render(data)).not.toContain("test-tmdb-token");
  });

  it("「公開中」は、日本向けの公開中の一覧を返す（AC3）", async () => {
    let called: URL | undefined;
    mockFetch((url) => {
      called = url;
      return Response.json(tmdbList([tmdbMovie(1)]));
    });
    const data = await load("/search?tab=now_playing");
    expect(called!.pathname).toBe("/3/movie/now_playing");
    expect(called!.searchParams.get("region")).toBe("JP");
    expect(called!.searchParams.get("language")).toBe("ja-JP");
    expect(data.tab).toBe("now_playing");
    expect(data.results.map((r) => r.tmdbId)).toEqual([1]);
  });

  it("「近日公開」は、今日から約半年先までの日本の劇場公開を注目度順で取得し、今日より前の公開日の作品を含まない（AC3）", async () => {
    let called: URL | undefined;
    mockFetch((url) => {
      called = url;
      return Response.json(
        tmdbList([
          tmdbMovie(1, { release_date: "2999-01-01" }),
          tmdbMovie(2, { release_date: "1979-10-06" }), // 過去の作品の再上映
          tmdbMovie(3, { release_date: "" }),
        ]),
      );
    });
    const data = await load("/search?tab=upcoming");

    expect(called!.pathname).toBe("/3/discover/movie");
    expect(called!.searchParams.get("region")).toBe("JP");
    expect(called!.searchParams.get("with_release_type")).toBe("2|3");
    expect(called!.searchParams.get("sort_by")).toBe("popularity.desc");
    const from = called!.searchParams.get("release_date.gte")!;
    const to = called!.searchParams.get("release_date.lte")!;
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBe(183);

    expect(data.results.map((r) => r.tmdbId)).toEqual([1]);
  });

  it("結果には、ID・タイトル・公開日・ポスターが含まれる。ポスターのない作品は代わりの枠を出す（AC4）", async () => {
    mockFetch(() =>
      Response.json(
        tmdbList([
          tmdbMovie(1, { title: "映画A", release_date: "2026-01-10", poster_path: "/a.jpg" }),
          tmdbMovie(2, { title: "映画B", release_date: "", poster_path: null }),
        ]),
      ),
    );
    const data = await load("/search?q=a");
    expect(data.results[0]).toMatchObject({
      tmdbId: 1,
      title: "映画A",
      releaseDate: "2026-01-10",
      posterPath: "/a.jpg",
    });
    expect(data.results[1]).toMatchObject({ tmdbId: 2, releaseDate: null, posterPath: null });

    const html = render(data);
    expect(html).toContain('src="https://image.tmdb.org/t/p/w342/a.jpg"');
    expect(html).toContain("2026/01/10");
    expect(html).toContain('href="/movies/1"');
    expect(html).toContain('data-poster="placeholder"');
    expect(html).toContain("公開日未定");
  });

  it("自分が登録済みの映画にだけ、状態のラベルが付く。他の利用者の登録は影響しない（AC5）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await createMovie({ tmdbId: 1 });
    await createMovie({ tmdbId: 2 });
    const row = (userId: string, tmdbId: number, extra: Partial<typeof userMovies.$inferInsert>) => ({
      id: crypto.randomUUID(),
      userId,
      tmdbId,
      status: "WANT_TO_WATCH" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...extra,
    });
    await getDb()
      .insert(userMovies)
      .values([
        row(me.id, 1, { preferredMedium: "THEATER" }),
        row(other.id, 2, { preferredMedium: "STREAMING" }),
      ]);

    mockFetch(() => Response.json(tmdbList([tmdbMovie(1), tmdbMovie(2), tmdbMovie(3)])));
    const data = await load("/search?q=a", me);
    expect(data.results.map((r) => r.state)).toEqual(["theater", null, null]);

    const html = render(data);
    expect(html.match(/data-state="/g)).toHaveLength(1);
    expect(html).toContain("劇場で見たい");
  });

  it("「もっと見る」で page を増やすと、1ページ目からそのページまでをまとめて表示する（AC6）", async () => {
    const pagesCalled: string[] = [];
    mockFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      pagesCalled.push(String(page));
      return Response.json(
        tmdbList([tmdbMovie(page * 10 + 1), tmdbMovie(page * 10 + 2)], { page, totalPages: 3 }),
      );
    });

    const first = await load("/search?q=a");
    expect(first.results.map((r) => r.tmdbId)).toEqual([11, 12]);
    expect(first.hasMore).toBe(true);
    expect(render(first)).toContain('href="/search?q=a&amp;page=2"');

    const second = await load("/search?q=a&page=2");
    expect(second.results.map((r) => r.tmdbId)).toEqual([11, 12, 21, 22]);
    expect(second.hasMore).toBe(true);

    const last = await load("/search?q=a&page=3");
    expect(last.results).toHaveLength(6);
    expect(last.hasMore).toBe(false);
    expect(render(last)).not.toContain("もっと見る");

    expect(pagesCalled.sort()).toEqual(["1", "1", "1", "2", "2", "3"]);
  });

  it("不正な page は1ページ目として扱い、上限を超える page は上限までにする", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return Response.json(tmdbList([tmdbMovie(1)], { totalPages: 100 }));
    });
    expect((await load("/search?q=a&page=abc")).pages).toBe(1);
    expect((await load("/search?q=a&page=-5")).pages).toBe(1);
    calls = 0;
    const capped = await load("/search?q=a&page=999");
    expect(capped.pages).toBe(10);
    expect(calls).toBe(10);
    expect(capped.hasMore).toBe(false);
  });

  it("検索語が空のときは TMDb を呼ばず、入力を促す（AC7）", async () => {
    const fetchMock = mockFetch(() => Response.json(tmdbList([])));
    const data = await load("/search?q=%20%20");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(render(data)).toContain("映画のタイトルを入力して検索してください");
  });

  it("結果が0件のときは「見つかりませんでした」と表示する（AC7）", async () => {
    mockFetch(() => Response.json(tmdbList([])));
    const data = await load("/search?q=zzz");
    expect(data.results).toEqual([]);
    expect(render(data)).toContain("見つかりませんでした");
  });

  it.each([
    ["500", () => new Response("error", { status: 500 })],
    ["429", () => new Response("rate limited", { status: 429 })],
    ["401", () => Response.json({ status_message: "Invalid API key" }, { status: 401 })],
    ["JSON でない応答", () => new Response("<html>", { status: 200 })],
  ])("TMDb が %s を返しても 500 にならず、案内を表示する（AC8）", async (_label, respond) => {
    mockFetch(respond);
    const data = await load("/search?q=a");
    expect(data.error).toBe(TMDB_ERROR_MESSAGE);
    expect(data.results).toEqual([]);
    const html = render(data);
    expect(html).toContain("映画情報を取得できませんでした。時間をおいて試してください");
    expect(html).toContain('role="alert"');
  });

  it("TMDb への通信が時間切れになっても 500 にならず、案内を表示する（AC8）", async () => {
    mockFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const data = await load("/search?tab=now_playing");
    expect(data.error).toBe(TMDB_ERROR_MESSAGE);
  });

  it("未ログイン（利用者が context にない）では 401 で、TMDb を呼ばない", async () => {
    const fetchMock = mockFetch(() => Response.json(tmdbList([])));
    await expect(
      loader(routeArgs({ url: `${ORIGIN}/search?q=a`, user: null })),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
