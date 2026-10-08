import { Form, Link, useNavigation } from "react-router";

import { Poster } from "~/components/Poster";
import { StateBadge } from "~/components/StateBadge";
import { requireUser } from "~/context";
import { formatYmd, todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { getStatesByTmdbId } from "~/lib/db/user-movies.server";
import type { StateKey } from "~/lib/labels";
import { SITE_NAME, TMDB_ERROR_MESSAGE } from "~/lib/site";
import {
  listNowPlaying,
  listUpcoming,
  searchMovies,
  TmdbError,
} from "~/lib/tmdb/client.server";
import type { MovieListPage, MovieSummary } from "~/lib/tmdb/types";

import type { Route } from "./+types/search";

const TABS = [
  { key: "search", label: "検索" },
  { key: "now_playing", label: "公開中" },
  { key: "upcoming", label: "近日公開" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** 「もっと見る」で一度に表示できるページ数の上限（1ページ20件）。 */
const MAX_PAGES = 10;
/** 検索語の長さの上限。 */
const MAX_QUERY_LENGTH = 100;

export function meta() {
  return [{ title: `探す | ${SITE_NAME}` }];
}

type SearchResult = MovieSummary & { state: StateKey | null };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context);
  const url = new URL(request.url);

  const tabParam = url.searchParams.get("tab");
  const tab: TabKey = TABS.some((t) => t.key === tabParam)
    ? (tabParam as TabKey)
    : "search";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const pageParam = Number(url.searchParams.get("page") ?? "1");
  const pages = Number.isInteger(pageParam)
    ? Math.min(Math.max(pageParam, 1), MAX_PAGES)
    : 1;

  const base = { tab, q, pages };

  // 検索語が空のときは、TMDb を呼ばずに入力を促す。
  if (tab === "search" && q === "") {
    return { ...base, results: [] as SearchResult[], hasMore: false, error: null };
  }

  const today = todayInTokyo();
  const fetchPage = (page: number): Promise<MovieListPage> => {
    if (tab === "now_playing") return listNowPlaying(page);
    if (tab === "upcoming") return listUpcoming(today, page);
    return searchMovies(q, page);
  };

  let fetched: MovieListPage[];
  try {
    // 「もっと見る」を押すたびに page が1つ増える。1ページ目から page ページ目までをまとめて表示する
    // （JavaScript が無効でも動き、URL を開き直しても同じ表示になる）。
    fetched = await Promise.all(
      Array.from({ length: pages }, (_, i) => fetchPage(i + 1)),
    );
  } catch (error) {
    if (!(error instanceof TmdbError)) throw error;
    console.error("TMDb から一覧を取得できませんでした:", error.message);
    return {
      ...base,
      results: [] as SearchResult[],
      hasMore: false,
      error: TMDB_ERROR_MESSAGE,
    };
  }

  const states = await getStatesByTmdbId(getDb(), user.id);
  const seen = new Set<number>();
  const results: SearchResult[] = [];
  for (const movie of fetched.flatMap((p) => p.results)) {
    if (seen.has(movie.tmdbId)) continue;
    seen.add(movie.tmdbId);
    results.push({ ...movie, state: states.get(movie.tmdbId) ?? null });
  }

  const totalPages = fetched[0]?.totalPages ?? 1;
  return {
    ...base,
    results,
    hasMore: pages < Math.min(totalPages, MAX_PAGES),
    error: null,
  };
}

function searchHref(params: { tab: TabKey; q?: string; page?: number }): string {
  const search = new URLSearchParams();
  if (params.tab !== "search") search.set("tab", params.tab);
  if (params.tab === "search" && params.q) search.set("q", params.q);
  if (params.page && params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `/search?${query}` : "/search";
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { tab, q, pages, results, hasMore, error } = loaderData;
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  return (
    <div>
      <h1 className="sr-only">映画を探す</h1>

      <div role="tablist" aria-label="探し方" className="flex gap-1 rounded-xl bg-zinc-900 p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={searchHref({ tab: t.key, q })}
            role="tab"
            aria-selected={tab === t.key}
            className={`flex min-h-10 flex-1 items-center justify-center rounded-lg text-sm font-medium ${
              tab === t.key ? "bg-zinc-700 text-zinc-50" : "text-zinc-400"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "search" && (
        <Form method="get" action="/search" role="search" className="mt-4 flex gap-2">
          <label htmlFor="q" className="sr-only">
            映画のタイトル
          </label>
          <input
            id="q"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="タイトルの一部を入力"
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            enterKeyHint="search"
            className="field"
          />
          <button type="submit" className="btn btn-primary shrink-0">
            検索
          </button>
        </Form>
      )}

      {tab !== "search" && (
        <p className="mt-3 text-xs text-muted">
          {tab === "now_playing"
            ? "日本で公開中の映画です。"
            : "これから半年ほどの間に日本で公開される映画を、注目度の高い順に並べています。"}
          TMDb に登録されている公開日をもとにしているため、近くの映画館で上映されているとは限りません。
        </p>
      )}

      {error && (
        <p role="alert" className="panel mt-4 text-sm text-red-300">
          {error}
        </p>
      )}

      {!error && tab === "search" && q === "" && (
        <p className="mt-8 text-center text-sm text-muted">
          映画のタイトルを入力して検索してください。
          <br />
          タイトルを思い出せないときは、「公開中」「近日公開」から探せます。
        </p>
      )}

      {!error && !(tab === "search" && q === "") && results.length === 0 && (
        <p className="mt-8 text-center text-sm text-muted">見つかりませんでした。</p>
      )}

      {results.length > 0 && (
        <ul
          className={`mt-4 grid grid-cols-3 gap-x-3 gap-y-5 ${loading ? "opacity-60" : ""}`}
        >
          {results.map((movie) => (
            <li key={movie.tmdbId} className="min-w-0">
              <Link to={`/movies/${movie.tmdbId}`} className="block">
                <div className="relative">
                  <Poster path={movie.posterPath} title={movie.title} />
                  {movie.state && (
                    <StateBadge
                      state={movie.state}
                      className="absolute left-1 top-1 max-w-[calc(100%-0.5rem)] shadow"
                    />
                  )}
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug">
                  {movie.title}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {formatYmd(movie.releaseDate) || "公開日未定"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <p className="mt-6 text-center">
          <Link
            to={searchHref({ tab, q, page: pages + 1 })}
            preventScrollReset
            className="btn"
          >
            もっと見る
          </Link>
        </p>
      )}
    </div>
  );
}
