import { env } from "cloudflare:workers";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TrailerPlayer } from "~/components/TrailerPlayer";
import { pickTrailer } from "~/lib/tmdb/trailer";
import MovieDetailPage, { loader } from "~/routes/movie";

import {
  catchThrown,
  createUser,
  mockFetch,
  ORIGIN,
  routeArgs,
  statusOf,
} from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

const load = async (id: string) =>
  loader(
    routeArgs({
      url: `${ORIGIN}/movies/${id}`,
      params: { tmdbId: id },
      user: await createUser(),
    }),
  );

const render = (loaderData: Awaited<ReturnType<typeof loader>>) =>
  renderRoute(MovieDetailPage, {
    path: "/movies/:tmdbId",
    url: `/movies/${loaderData.movie.tmdbId}`,
    loaderData,
  });

describe("映画詳細（/movies/:tmdbId）", () => {
  it("TMDb を1回だけ呼び、予告・配信状況・スタッフとキャストをまとめて取得する（AC1）", async () => {
    const fetchMock = mockFetch(() => Response.json(tmdbDetail(42)));
    await load("42");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL((fetchMock.mock.calls[0][0] as URL).toString());
    expect(url.pathname).toBe("/3/movie/42");
    expect(url.searchParams.get("language")).toBe("ja-JP");
    expect(url.searchParams.get("append_to_response")).toBe(
      "videos,watch/providers,credits,release_dates",
    );
    expect(url.searchParams.get("include_video_language")).toBe("ja,en,null");
  });

  it("タイトル・原題・公開日・上映時間・ジャンル・あらすじ・監督・出演者（5人まで）を表示する（AC2）", async () => {
    mockFetch(() => Response.json(tmdbDetail(42, { title: "映画A", original_title: "Movie A" })));
    const html = render(await load("42"));

    expect(html).toContain("映画A");
    expect(html).toContain("Movie A");
    expect(html).toContain("2026/01/10");
    expect(html).toContain("1時間58分");
    expect(html).toContain("ドラマ");
    expect(html).toContain("ミステリー");
    expect(html).toContain("映画42のあらすじ。");
    expect(html).toContain("監督X");
    expect(html).not.toContain("脚本Y");
    // 出演者は、TMDb の順番（order）で先頭の5人まで。
    expect(html).toContain("俳優A、俳優B、俳優C、俳優D、俳優E");
    expect(html).not.toContain("俳優F");
  });

  describe("公開日", () => {
    const releaseDates = (jp: { release_date: string; type: number }[]) => ({
      release_date: "2025-12-01", // 世界で最初の公開日
      release_dates: {
        results: [
          { iso_3166_1: "US", release_dates: [{ release_date: "2025-12-01T00:00:00.000Z", type: 3 }] },
          { iso_3166_1: "JP", release_dates: jp },
        ],
      },
    });

    it("日本の劇場公開日があれば、世界で最初の公開日ではなく、それを使う", async () => {
      mockFetch(() =>
        Response.json(
          tmdbDetail(42, releaseDates([
            { release_date: "2026-01-05T00:00:00.000Z", type: 1 }, // 試写・プレミア
            { release_date: "2026-01-10T00:00:00.000Z", type: 3 },
            { release_date: "2026-04-01T00:00:00.000Z", type: 4 }, // 配信
          ])),
        ),
      );
      const loaderData = await load("42");
      expect(loaderData.movie.releaseDate).toBe("2026-01-10");
      expect(render(loaderData)).toContain("2026/01/10 公開");
      // 一覧用のスナップショットにも、日本の公開日を保存する。
      expect(await env.DB.prepare("SELECT release_date FROM movies WHERE tmdb_id = 42").first()).toEqual({
        release_date: "2026-01-10",
      });
    });

    it("再上映などで劇場公開日が複数あるときは、最初の日付を使う", async () => {
      mockFetch(() =>
        Response.json(
          tmdbDetail(42, releaseDates([
            { release_date: "2026-09-01T00:00:00.000Z", type: 3 },
            { release_date: "1999-07-10T00:00:00.000Z", type: 3 },
          ])),
        ),
      );
      expect((await load("42")).movie.releaseDate).toBe("1999-07-10");
    });

    it("通常の劇場公開がなく、限定公開だけのときは、その日付を使う", async () => {
      mockFetch(() =>
        Response.json(tmdbDetail(42, releaseDates([{ release_date: "2026-02-02T00:00:00.000Z", type: 2 }]))),
      );
      expect((await load("42")).movie.releaseDate).toBe("2026-02-02");
    });

    it("日本の劇場公開日がなければ、世界で最初の公開日を使う", async () => {
      mockFetch(() =>
        Response.json(tmdbDetail(42, releaseDates([{ release_date: "2026-04-01T00:00:00.000Z", type: 4 }]))),
      );
      expect((await load("42")).movie.releaseDate).toBe("2025-12-01");
    });
  });

  it("ブラウザに渡るデータと HTML に、トークンが含まれない", async () => {
    mockFetch(() => Response.json(tmdbDetail(42)));
    const loaderData = await load("42");
    expect(JSON.stringify(loaderData)).not.toContain("test-tmdb-token");
    expect(render(loaderData)).not.toContain("test-tmdb-token");
  });

  describe("予告の選び方（AC3）", () => {
    const v = (key: string, type: string, lang: string | null, official = true, site = "YouTube") => ({
      key,
      name: key,
      site,
      type,
      official,
      iso_639_1: lang,
    });

    it("日本語の公式の Trailer を最優先にする", () => {
      const trailer = pickTrailer([
        v("en-official", "Trailer", "en"),
        v("ja-unofficial", "Trailer", "ja", false),
        v("ja-official", "Trailer", "ja"),
        v("ja-teaser", "Teaser", "ja"),
      ]);
      expect(trailer?.key).toBe("ja-official");
    });

    it("日本語がなければ英語、同じ言語の中では公式を優先する", () => {
      expect(
        pickTrailer([v("en-unofficial", "Trailer", "en", false), v("en-official", "Trailer", "en")])?.key,
      ).toBe("en-official");
      expect(
        pickTrailer([v("en-official", "Trailer", "en"), v("ja-unofficial", "Trailer", "ja", false)])?.key,
      ).toBe("ja-unofficial");
    });

    it("Trailer がなければ Teaser を選ぶ", () => {
      expect(pickTrailer([v("ja-teaser", "Teaser", "ja"), v("clip", "Clip", "ja")])?.key).toBe("ja-teaser");
    });

    it("YouTube 以外の動画は選ばない。どれもなければ null", () => {
      expect(pickTrailer([v("vimeo", "Trailer", "ja", true, "Vimeo")])).toBeNull();
      expect(pickTrailer([v("clip", "Clip", "ja")])).toBeNull();
      expect(pickTrailer([])).toBeNull();
      expect(pickTrailer(undefined)).toBeNull();
    });

    it("予告がない作品では、予告の欄を出さない", async () => {
      mockFetch(() => Response.json(tmdbDetail(42, { videos: { results: [] } })));
      const html = render(await load("42"));
      expect(html).not.toContain('id="trailer-title"');
      expect(html).not.toContain("data-trailer");
    });
  });

  describe("予告の表示（AC4）", () => {
    const trailer = { key: "abc123", name: "本予告", language: "ja" };

    it("初期表示では YouTube の iframe を置かない（押すまで YouTube に通信しない）", async () => {
      mockFetch(() => Response.json(tmdbDetail(42)));
      const html = render(await load("42"));
      expect(html).toContain('data-trailer="poster"');
      expect(html).not.toContain("<iframe");
      // サムネイルにも YouTube の画像を使わない。
      expect(html).not.toContain("ytimg.com");
      expect(html).toContain("https://image.tmdb.org/t/p/w780/backdrop-42.jpg");
    });

    it("再生ボタンを押した後は、youtube-nocookie.com の iframe を表示する", () => {
      const html = renderToString(
        <TrailerPlayer trailer={trailer} backdropPath={null} title="映画A" defaultPlaying />,
      );
      expect(html).toMatch(/<iframe[^>]+src="https:\/\/www\.youtube-nocookie\.com\/embed\/abc123\?/);
    });
  });

  it("配信状況は日本の分だけを、定額・レンタルと購入・無料に分けて表示し、JustWatch 提供と書く（AC5）", async () => {
    mockFetch(() => Response.json(tmdbDetail(42)));
    const loaderData = await load("42");

    expect(loaderData.movie.providers).toEqual({
      link: "https://www.themoviedb.org/movie/42/watch?locale=JP",
      // 表示の優先度（display_priority）の順。
      flatrate: [
        { id: 1, name: "配信サービスA", logoPath: "/a.jpg" },
        { id: 2, name: "配信サービスB", logoPath: "/b.jpg" },
      ],
      // レンタルと購入の両方にあるサービスは、1つにまとめる。
      rentOrBuy: [
        { id: 3, name: "レンタルC", logoPath: "/c.jpg" },
        { id: 4, name: "販売D", logoPath: null },
      ],
      free: [{ id: 5, name: "無料配信E", logoPath: "/e.jpg" }],
    });

    const html = render(loaderData);
    expect(html).toContain("定額で見られる");
    expect(html).toContain("レンタル・購入");
    expect(html).toContain("配信サービスA");
    expect(html).toContain("無料配信E");
    expect(html).not.toContain("海外の配信サービス");
    expect(html).toContain('href="https://www.themoviedb.org/movie/42/watch?locale=JP"');
    expect(html).toContain("JustWatch");
    expect(html).toContain("https://image.tmdb.org/t/p/w92/a.jpg");
  });

  it("日本の配信情報がないときは「日本での配信情報はまだありません」と表示する（AC6）", async () => {
    mockFetch(() =>
      Response.json(
        tmdbDetail(42, {
          "watch/providers": { results: { US: { flatrate: [{ provider_id: 9, provider_name: "X" }] } } },
        }),
      ),
    );
    const loaderData = await load("42");
    expect(loaderData.movie.providers).toBeNull();
    const html = render(loaderData);
    expect(html).toContain("日本での配信情報はまだありません");
    // 配信がなくても、JustWatch 提供の表記は出す。
    expect(html).toContain("JustWatch");
  });

  it("TMDb にない ID は 404（AC7）", async () => {
    mockFetch(() => Response.json({ success: false, status_code: 34 }, { status: 404 }));
    const thrown = await catchThrown(() => load("999999"));
    expect(statusOf(thrown)).toBe(404);
    expect((thrown as { data: string }).data).toBe("映画が見つかりませんでした");
  });

  it.each(["abc", "12abc", "-1", "0", "1.5", "１２"])(
    "数字でない ID（%s）は、TMDb を呼ばずに 404（AC7）",
    async (id) => {
      const fetchMock = mockFetch(() => Response.json(tmdbDetail(1)));
      expect(statusOf(await catchThrown(() => load(id)))).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("TMDb が混雑などで応答できないときは、503 と案内を返す", async () => {
    mockFetch(() => new Response("error", { status: 500 }));
    const thrown = await catchThrown(() => load("42"));
    expect(statusOf(thrown)).toBe(503);
    expect((thrown as { data: string }).data).toContain("映画情報を取得できませんでした");
  });

  it("詳細を開くと、一覧用のスナップショットを保存し、開き直すと更新する（AC8）", async () => {
    mockFetch(() => Response.json(tmdbDetail(42, { title: "旧タイトル" })));
    await load("42");
    mockFetch(() => Response.json(tmdbDetail(42, { title: "新タイトル", poster_path: "/new.jpg" })));
    await load("42");

    const { results } = await env.DB.prepare("SELECT * FROM movies").all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tmdb_id: 42,
      title: "新タイトル",
      original_title: "Movie 42",
      release_date: "2026-01-10",
      poster_path: "/new.jpg",
    });
  });

  it("あらすじ・ポスター・予告・公開日などが欠けていても、エラーにならず、その部分だけ省く（AC9）", async () => {
    mockFetch(() =>
      Response.json({
        id: 42,
        title: "映画A",
        original_title: "映画A",
        overview: "",
        release_date: "",
        poster_path: null,
        backdrop_path: null,
        runtime: 0,
      }),
    );
    const loaderData = await load("42");
    expect(loaderData.movie).toMatchObject({
      overview: null,
      releaseDate: null,
      posterPath: null,
      runtime: null,
      genres: [],
      directors: [],
      cast: [],
      trailer: null,
      providers: null,
    });

    const html = render(loaderData);
    expect(html).toContain("映画A");
    expect(html).toContain("公開日未定");
    expect(html).toContain('data-poster="placeholder"');
    expect(html).not.toContain('id="overview-title"');
    expect(html).not.toContain('id="credits-title"');
    expect(html).not.toContain('id="trailer-title"');
  });
});
