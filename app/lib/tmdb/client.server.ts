import { isValidYmd } from "~/lib/date";
import { getSecret } from "~/lib/env.server";

import { pickTrailer } from "./trailer";
import type {
  MovieDetail,
  MovieListPage,
  MovieSummary,
  Provider,
  WatchProviders,
} from "./types";

// TMDb の API を呼ぶ。トークンをブラウザに出さないため、このファイルはサーバー側だけで使う。
// 映画の情報は日本語・日本向けで取得する。

const API_BASE = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 5000;
/** TMDb が受け付けるページ番号の上限。 */
export const TMDB_MAX_PAGE = 500;
/** 近日公開として扱う範囲（今日から何日先まで）。 */
const UPCOMING_DAYS = 183;

/** TMDb から情報を取得できなかった（通信の失敗、時間切れ、混雑、設定の不備など）。 */
export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

/** 指定した映画が TMDb にない。 */
export class TmdbNotFoundError extends TmdbError {
  constructor() {
    super("TMDb に該当する映画がありません", 404);
    this.name = "TmdbNotFoundError";
  }
}

type Params = Record<string, string | number | boolean>;

async function tmdbGet<T>(path: string, params: Params = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("language", "ja-JP");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${getSecret("TMDB_ACCESS_TOKEN")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // エラーの中身にトークンは含まれない（URL にもトークンを入れていない）。
    throw new TmdbError(
      `TMDb への通信に失敗しました: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  if (response.status === 404) {
    await response.body?.cancel();
    throw new TmdbNotFoundError();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new TmdbError(`TMDb がエラーを返しました（${response.status}）`, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new TmdbError("TMDb の応答を読み取れませんでした");
  }
}

type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
};

type TmdbList = {
  page?: number;
  total_pages?: number;
  results?: TmdbMovie[];
};

function toSummary(movie: TmdbMovie): MovieSummary {
  const title = movie.title || movie.original_title || "（タイトル不明）";
  return {
    tmdbId: movie.id,
    title,
    originalTitle: movie.original_title || null,
    releaseDate:
      movie.release_date && isValidYmd(movie.release_date) ? movie.release_date : null,
    posterPath: movie.poster_path || null,
  };
}

function toListPage(list: TmdbList, page: number): MovieListPage {
  return {
    page: list.page ?? page,
    totalPages: Math.min(list.total_pages ?? 1, TMDB_MAX_PAGE),
    results: (list.results ?? [])
      .filter((m) => typeof m.id === "number")
      .map(toSummary),
  };
}

function clampPage(page: number): number {
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, TMDB_MAX_PAGE);
}

/** タイトルで検索する。 */
export async function searchMovies(query: string, page = 1): Promise<MovieListPage> {
  const p = clampPage(page);
  const list = await tmdbGet<TmdbList>("/search/movie", {
    query,
    region: "JP",
    include_adult: false,
    page: p,
  });
  return toListPage(list, p);
}

/** 日本で公開中の映画。 */
export async function listNowPlaying(page = 1): Promise<MovieListPage> {
  const p = clampPage(page);
  const list = await tmdbGet<TmdbList>("/movie/now_playing", { region: "JP", page: p });
  return toListPage(list, p);
}

function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 日本で近日公開の映画。今日から約6か月先までに劇場公開されるものを、注目度の高い順に返す。
 *
 * TMDb の /movie/upcoming は対象の期間が3週間ほどしかなく、予告で見た数か月先の作品が
 * 出てこないので、/discover/movie で期間を指定する。公開日順（primary_release_date.asc）は
 * 日本ではなく世界での最初の公開日で並ぶため使わず、注目度の順にしている。
 * 過去の作品の再上映は、最初の公開日が返ってくるので、今日より前の日付のものは除く。
 */
export async function listUpcoming(today: string, page = 1): Promise<MovieListPage> {
  const p = clampPage(page);
  const list = await tmdbGet<TmdbList>("/discover/movie", {
    region: "JP",
    with_release_type: "2|3",
    "release_date.gte": today,
    "release_date.lte": addDays(today, UPCOMING_DAYS),
    sort_by: "popularity.desc",
    include_adult: false,
    page: p,
  });
  const result = toListPage(list, p);
  return {
    ...result,
    results: result.results.filter((m) => m.releaseDate !== null && m.releaseDate >= today),
  };
}

type TmdbProvider = {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string | null;
  display_priority?: number;
};

type TmdbDetail = TmdbMovie & {
  overview?: string;
  runtime?: number | null;
  backdrop_path?: string | null;
  genres?: { name?: string }[];
  videos?: { results?: Parameters<typeof pickTrailer>[0] };
  release_dates?: {
    results?: {
      iso_3166_1?: string;
      release_dates?: { release_date?: string; type?: number }[];
    }[];
  };
  credits?: {
    cast?: { name?: string; order?: number }[];
    crew?: { name?: string; job?: string }[];
  };
  "watch/providers"?: {
    results?: Record<
      string,
      {
        link?: string;
        flatrate?: TmdbProvider[];
        rent?: TmdbProvider[];
        buy?: TmdbProvider[];
        free?: TmdbProvider[];
        ads?: TmdbProvider[];
      }
    >;
  };
};

function toProviders(...groups: (TmdbProvider[] | undefined)[]): Provider[] {
  const seen = new Set<number>();
  const providers: (Provider & { priority: number })[] = [];
  for (const provider of groups.flatMap((g) => g ?? [])) {
    if (typeof provider.provider_id !== "number" || !provider.provider_name) continue;
    if (seen.has(provider.provider_id)) continue;
    seen.add(provider.provider_id);
    providers.push({
      id: provider.provider_id,
      name: provider.provider_name,
      logoPath: provider.logo_path || null,
      priority: provider.display_priority ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return providers
    .sort((a, b) => a.priority - b.priority)
    .map(({ id, name, logoPath }) => ({ id, name, logoPath }));
}

function toWatchProviders(detail: TmdbDetail): WatchProviders | null {
  const jp = detail["watch/providers"]?.results?.JP;
  if (!jp) return null;
  const providers: WatchProviders = {
    link: jp.link ?? null,
    flatrate: toProviders(jp.flatrate),
    rentOrBuy: toProviders(jp.rent, jp.buy),
    free: toProviders(jp.free, jp.ads),
  };
  const total =
    providers.flatrate.length + providers.rentOrBuy.length + providers.free.length;
  return total === 0 ? null : providers;
}

// TMDb の公開の種類。3 が通常の劇場公開、2 が限定的な劇場公開。
const THEATRICAL_RELEASE_TYPES = [3, 2];

/**
 * 日本での劇場公開日を取り出す。
 * /movie/{id} の release_date は世界で最初の公開日なので、日本の公開日とは違うことがある
 * （海外で先に公開された作品など）。日本の劇場公開日があればそれを使う。
 * 再上映などで複数ある場合は、最初の日付を使う。
 */
function japanReleaseDate(detail: TmdbDetail): string | null {
  const jp = detail.release_dates?.results?.find((r) => r.iso_3166_1 === "JP");
  for (const type of THEATRICAL_RELEASE_TYPES) {
    const dates = (jp?.release_dates ?? [])
      .filter((d) => d.type === type && typeof d.release_date === "string")
      // "2026-01-10T00:00:00.000Z" の形で返ってくる。日付の部分だけを使う。
      .map((d) => d.release_date!.slice(0, 10))
      .filter(isValidYmd)
      .sort();
    if (dates.length > 0) return dates[0];
  }
  return null;
}

/** 映画の詳細。予告・配信状況・スタッフとキャスト・国ごとの公開日を、1回の呼び出しでまとめて取得する。 */
export async function getMovieDetail(tmdbId: number): Promise<MovieDetail> {
  const detail = await tmdbGet<TmdbDetail>(`/movie/${tmdbId}`, {
    append_to_response: "videos,watch/providers,credits,release_dates",
    include_video_language: "ja,en,null",
  });

  const cast = [...(detail.credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .map((c) => c.name)
    .filter((name): name is string => !!name)
    .slice(0, 5);
  const directors = (detail.credits?.crew ?? [])
    .filter((c) => c.job === "Director")
    .map((c) => c.name)
    .filter((name): name is string => !!name);

  const summary = toSummary(detail);
  return {
    ...summary,
    releaseDate: japanReleaseDate(detail) ?? summary.releaseDate,
    overview: detail.overview || null,
    runtime: detail.runtime && detail.runtime > 0 ? detail.runtime : null,
    genres: (detail.genres ?? []).map((g) => g.name).filter((n): n is string => !!n),
    backdropPath: detail.backdrop_path || null,
    directors,
    cast,
    trailer: pickTrailer(detail.videos?.results),
    providers: toWatchProviders(detail),
  };
}
