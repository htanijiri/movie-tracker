import { Form, Link, useNavigation } from "react-router";

import { Poster } from "~/components/Poster";
import { StateBadge } from "~/components/StateBadge";
import { requireUser } from "~/context";
import { formatYmd, todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { getStatesByTmdbId } from "~/lib/db/user-movies.server";
import type { StateKey } from "~/lib/labels";
import {
  RECOMMEND_LANGS,
  RECOMMEND_SOURCES,
  type RecommendLang,
  type RecommendSource,
} from "~/lib/recommend";
import { loadRecommendations } from "~/lib/recommend.server";
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
  { key: "recommend", label: "おすすめ" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** 「もっと見る」で一度に表示できるページ数の上限（1ページ20件）。 */
const MAX_PAGES = 10;
/** 検索語の長さの上限。 */
const MAX_QUERY_LENGTH = 100;

export function meta() {
  return [{ title: `探す | ${SITE_NAME}` }];
}

type SearchResult = MovieSummary & {
  state: StateKey | null;
  /** おすすめの理由（おすすめのタブだけ。仕様書 012）。 */
  reason?: string | null;
};

type RecommendView = { source: RecommendSource; lang: RecommendLang; coldStart: boolean };

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

  const base = { tab, q, pages, recommend: null as RecommendView | null };

  // 検索語が空のときは、TMDb を呼ばずに入力を促す。
  if (tab === "search" && q === "") {
    return { ...base, results: [] as SearchResult[], hasMore: false, error: null };
  }

  // おすすめ（仕様書 012）。
  if (tab === "recommend") {
    const sourceParam = url.searchParams.get("source");
    const langParam = url.searchParams.get("lang");
    const source: RecommendSource = (RECOMMEND_SOURCES as readonly string[]).includes(sourceParam ?? "")
      ? (sourceParam as RecommendSource)
      : "theater";
    const lang: RecommendLang = (RECOMMEND_LANGS as readonly string[]).includes(langParam ?? "")
      ? (langParam as RecommendLang)
      : "all";
    try {
      const { items, coldStart } = await loadRecommendations(getDb(), user.id, source, lang);
      return {
        ...base,
        recommend: { source, lang, coldStart },
        results: items.map((item) => ({ ...item, state: null })) as SearchResult[],
        hasMore: false,
        error: null,
      };
    } catch (error) {
      if (!(error instanceof TmdbError)) throw error;
      console.error("おすすめの候補を取得できませんでした:", error.message);
      return {
        ...base,
        recommend: { source, lang, coldStart: false },
        results: [] as SearchResult[],
        hasMore: false,
        error: TMDB_ERROR_MESSAGE,
      };
    }
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
  const { tab, q, pages, results, hasMore, error, recommend } = loaderData;
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

      {recommend && <RecommendControls view={recommend} />}

      {(tab === "now_playing" || tab === "upcoming") && (
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
        <p className="mt-8 text-center text-sm text-muted">
          {recommend ? "条件に合う作品がありませんでした。" : "見つかりませんでした。"}
        </p>
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
                {movie.reason && (
                  <p className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-amber-300" data-reason>
                    {movie.reason}
                  </p>
                )}
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

const SOURCE_LABELS: Record<RecommendSource, string> = {
  theater: "劇場で公開中",
  streaming: "配信中",
};
const LANG_LABELS: Record<RecommendLang, string> = {
  all: "すべて",
  ja: "邦画",
  foreign: "洋画",
};

function recommendHref(source: RecommendSource, lang: RecommendLang): string {
  const search = new URLSearchParams({ tab: "recommend" });
  if (source !== "theater") search.set("source", source);
  if (lang !== "all") search.set("lang", lang);
  return `/search?${search.toString()}`;
}

/** おすすめの切り替え（劇場で公開中／配信中）と絞り込み（すべて／邦画／洋画）。仕様書 012。 */
function RecommendControls({ view }: { view: RecommendView }) {
  const pill = (active: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium ${
      active ? "border-amber-400 bg-amber-400 text-zinc-950" : "border-zinc-700 text-zinc-300"
    }`;
  return (
    <div className="mt-3 space-y-2" data-recommend-controls>
      <div className="flex flex-wrap gap-2" role="group" aria-label="おすすめの対象">
        {RECOMMEND_SOURCES.map((source) => (
          <Link
            key={source}
            to={recommendHref(source, view.lang)}
            aria-current={view.source === source ? "true" : undefined}
            className={pill(view.source === source)}
          >
            {SOURCE_LABELS[source]}
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="邦画・洋画">
        {RECOMMEND_LANGS.map((lang) => (
          <Link
            key={lang}
            to={recommendHref(view.source, lang)}
            aria-current={view.lang === lang ? "true" : undefined}
            className={pill(view.lang === lang)}
          >
            {LANG_LABELS[lang]}
          </Link>
        ))}
      </div>
      <p className="text-xs text-muted">
        {view.coldStart
          ? "人気の高い順に並べています。記録が増えると好みに合わせて並びます。"
          : "これまでの記録（★、見たい、見送り）から、好みに合いそうな順に並べています。"}
        {view.source === "streaming" && "見放題か無料で見られる作品です。"}
      </p>
    </div>
  );
}
