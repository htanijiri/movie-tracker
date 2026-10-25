import { and, eq } from "drizzle-orm";

import type { Db } from "~/lib/db/client.server";
import { upsertMovieSnapshot } from "~/lib/db/movies.server";
import { movies, userMovies, type PreferredMedium, type Status } from "~/lib/db/schema";
import { genreName } from "~/lib/genres";
import type { RecommendLang, RecommendSource } from "~/lib/recommend";
import {
  getMovieDetail,
  listNowPlaying,
  listRecommendations,
  listStreaming,
  TmdbError,
  TmdbNotFoundError,
} from "~/lib/tmdb/client.server";
import type { MovieListPage, MovieSummary } from "~/lib/tmdb/types";

// 映画のおすすめ（仕様書 012）。記録（★、見たい、見送り）からジャンルの好みを計算し、
// 公開中・配信中の作品を好みに合う順に並べる。計算はこのアプリの中だけで行い、記録を外部に送らない。


/** 表示する本数。 */
export const RECOMMEND_LIMIT = 20;
/** 好みの手がかりがこれより少なければ、人気順に並べる。 */
export const MIN_SIGNALS = 3;
/** 候補を取得するページ数。 */
const CANDIDATE_PAGES = 3;
/** 関連作品を取得する、★の高い見た映画の本数。 */
const RELATED_SOURCES = 3;
/** 1回の表示で、ジャンルの分からない記録を補う本数。 */
const GENRE_FILL = 4;
/** 関連作品1つあたりの加点。 */
const RELATED_BONUS = 2;

export type TasteRecord = {
  tmdbId: number;
  title: string;
  status: Status;
  preferredMedium: PreferredMedium | null;
  rating: number | null;
  genreIds: number[] | null;
};

/** 記録1本の好みの重み（＋は好き、−は苦手）。 */
export function recordWeight(record: Pick<TasteRecord, "status" | "preferredMedium" | "rating">): number {
  if (record.status === "WATCHED") {
    return record.rating ? record.rating - 3 : 0.5;
  }
  if (record.status === "SKIPPED") return -1;
  if (record.status === "WANT_TO_WATCH" && (record.preferredMedium === "THEATER" || record.preferredMedium === "STREAMING")) {
    return 1;
  }
  return 0;
}

type GenreTaste = {
  weight: number;
  /** そのジャンルで、★がいちばん高い（★4以上の）見た映画。理由の表示に使う。 */
  best: { title: string; rating: number } | null;
};

export type TasteProfile = {
  genres: Map<number, GenreTaste>;
  /** 好みの手がかりになった記録の本数（重みが0でなく、ジャンルが分かるもの）。 */
  signals: number;
};

export function buildTasteProfile(records: TasteRecord[]): TasteProfile {
  const genres = new Map<number, GenreTaste>();
  let signals = 0;
  for (const record of records) {
    const weight = recordWeight(record);
    if (weight === 0 || !record.genreIds?.length) continue;
    signals += 1;
    for (const id of record.genreIds) {
      const taste = genres.get(id) ?? { weight: 0, best: null };
      taste.weight += weight;
      if (record.status === "WATCHED" && record.rating && record.rating >= 4) {
        if (!taste.best || record.rating > taste.best.rating) {
          taste.best = { title: record.title, rating: record.rating };
        }
      }
      genres.set(id, taste);
    }
  }
  return { genres, signals };
}

export type Related = Map<number, { title: string; rating: number }[]>;

export type Recommendation = MovieSummary & {
  reason: string | null;
  score: number;
};

/** 候補に点数を付け、好みに合う順に並べる。自分のリストにある映画は除く。 */
export function scoreCandidates(
  candidates: MovieSummary[],
  profile: TasteProfile,
  related: Related,
  excluded: Set<number>,
): Recommendation[] {
  const seen = new Set<number>();
  const pool = candidates.filter((c) => {
    if (excluded.has(c.tmdbId) || seen.has(c.tmdbId)) return false;
    seen.add(c.tmdbId);
    return true;
  });

  // 人気の順位（同点を崩すための小さな加点に使う）。
  const byPopularity = [...pool].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  const popularityRank = new Map(byPopularity.map((c, i) => [c.tmdbId, i]));
  const tieBreaker = (c: MovieSummary) =>
    pool.length > 0 ? 0.1 * (1 - (popularityRank.get(c.tmdbId) ?? 0) / pool.length) : 0;

  const scored = pool.map((candidate) => {
    const genreIds = candidate.genreIds ?? [];
    let genreScore = 0;
    let bestGenre: { id: number; taste: GenreTaste } | null = null;
    for (const id of genreIds) {
      const taste = profile.genres.get(id);
      if (!taste) continue;
      genreScore += taste.weight;
      if (taste.best && taste.weight > 0 && (!bestGenre || taste.best.rating > (bestGenre.taste.best?.rating ?? 0) || (taste.best.rating === bestGenre.taste.best?.rating && taste.weight > bestGenre.taste.weight))) {
        bestGenre = { id, taste };
      }
    }
    if (genreIds.length > 0) genreScore /= Math.sqrt(genreIds.length);

    const sources = related.get(candidate.tmdbId) ?? [];
    const score = genreScore + RELATED_BONUS * sources.length + tieBreaker(candidate);

    let reason: string | null = null;
    if (sources.length > 0) {
      const top = [...sources].sort((a, b) => b.rating - a.rating)[0];
      reason = `「${top.title}」（★${top.rating}）の関連作品`;
    } else if (bestGenre?.taste.best) {
      const name = genreName(bestGenre.id);
      if (name) reason = `★${bestGenre.taste.best.rating}の「${bestGenre.taste.best.title}」と同じ「${name}」`;
    }
    return { ...candidate, score, reason };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/** 人気順に並べる（記録が少ないとき）。 */
function byPopularityOnly(candidates: MovieSummary[], excluded: Set<number>): Recommendation[] {
  const seen = new Set<number>();
  return candidates
    .filter((c) => {
      if (excluded.has(c.tmdbId) || seen.has(c.tmdbId)) return false;
      seen.add(c.tmdbId);
      return true;
    })
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .map((c) => ({ ...c, score: 0, reason: null }));
}

function matchesLang(movie: MovieSummary, lang: RecommendLang): boolean {
  if (lang === "ja") return movie.originalLanguage === "ja";
  if (lang === "foreign") return movie.originalLanguage !== "ja";
  return true;
}

export type RecommendResult = {
  items: Recommendation[];
  /** 記録が少なく、人気順に並べたとき true。 */
  coldStart: boolean;
};

/**
 * おすすめを作る。1回の表示で TMDb を呼ぶのは、候補3回・関連作品3回・ジャンルの補完4回までの10回。
 * TMDb が応答しないときは TmdbError を投げる。
 */
export async function loadRecommendations(
  db: Db,
  userId: string,
  source: RecommendSource,
  lang: RecommendLang,
): Promise<RecommendResult> {
  const rows = await db
    .select({
      tmdbId: userMovies.tmdbId,
      title: movies.title,
      status: userMovies.status,
      preferredMedium: userMovies.preferredMedium,
      rating: userMovies.rating,
      genreIds: movies.genreIds,
    })
    .from(userMovies)
    .innerJoin(movies, eq(movies.tmdbId, userMovies.tmdbId))
    .where(and(eq(userMovies.userId, userId)));
  const records: TasteRecord[] = rows.map((r) => ({ ...r, genreIds: r.genreIds ?? null }));

  // ジャンルの分からない記録を、好みに効くものから数本補う（ふだんは定期実行が補っている）。
  const missing = records
    .filter((r) => r.genreIds === null && recordWeight(r) !== 0)
    .sort((a, b) => Math.abs(recordWeight(b)) - Math.abs(recordWeight(a)))
    .slice(0, GENRE_FILL);
  await Promise.all(
    missing.map(async (record) => {
      try {
        const detail = await getMovieDetail(record.tmdbId);
        await upsertMovieSnapshot(db, detail);
        record.genreIds = detail.genreIds;
      } catch (error) {
        if (!(error instanceof TmdbError)) throw error;
        if (error instanceof TmdbNotFoundError) record.genreIds = [];
      }
    }),
  );

  const fetchPage = (page: number): Promise<MovieListPage> =>
    source === "theater"
      ? listNowPlaying(page)
      : listStreaming(page, lang === "ja" ? "ja" : undefined);
  const relatedSources = records
    .filter((r) => r.status === "WATCHED" && (r.rating ?? 0) >= 4)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, RELATED_SOURCES);

  const [pages, relatedLists] = await Promise.all([
    Promise.all(Array.from({ length: CANDIDATE_PAGES }, (_, i) => fetchPage(i + 1))),
    Promise.all(
      relatedSources.map((r) =>
        listRecommendations(r.tmdbId).catch((error) => {
          // 関連作品は加点のためだけなので、取れなくてもおすすめは出す。
          if (error instanceof TmdbError) return null;
          throw error;
        }),
      ),
    ),
  ]);

  const candidates = pages.flatMap((p) => p.results).filter((m) => matchesLang(m, lang));
  const excluded = new Set(records.map((r) => r.tmdbId));
  const profile = buildTasteProfile(records);

  if (profile.signals < MIN_SIGNALS) {
    return { items: byPopularityOnly(candidates, excluded).slice(0, RECOMMEND_LIMIT), coldStart: true };
  }

  const related: Related = new Map();
  relatedLists.forEach((list, i) => {
    if (!list) return;
    const source = relatedSources[i];
    for (const movie of list.results) {
      const entries = related.get(movie.tmdbId) ?? [];
      entries.push({ title: source.title, rating: source.rating ?? 0 });
      related.set(movie.tmdbId, entries);
    }
  });

  return {
    items: scoreCandidates(candidates, profile, related, excluded).slice(0, RECOMMEND_LIMIT),
    coldStart: false,
  };
}
