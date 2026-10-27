import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";

import type { Db } from "~/lib/db/client.server";
import { ensureMovieSnapshot } from "~/lib/db/movies.server";
import {
  movies,
  trailerFinds,
  userMovies,
  type TrailerResult,
} from "~/lib/db/schema";
import { setPreferredMedium } from "~/lib/db/user-movies.server";
import type { SelectableMedium } from "~/lib/labels";
import { listTrailerCandidates } from "~/lib/tmdb/client.server";
import type { MovieSummary } from "~/lib/tmdb/types";

// 予告で見た映画を探す（仕様書 013）。
// 予告探しは、劇場で見た記録（user_movies の1行）ごとに1つ。見た記録の「気になった予告」の本数まで、
// 候補に「これだった」を付けていく。

/** 1回に表示する候補の本数。 */
export const CANDIDATE_LIMIT = 20;
/** 候補を取得するページ数。 */
const CANDIDATE_PAGES = 3;

export type TrailerHunt = {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  watchedAt: string;
  watchedPlace: string | null;
  trailerCount: number;
  found: number;
};

/** 予告探しの対象になる見た記録の条件（劇場で見て、本数が1以上）。 */
const huntTarget = and(
  eq(userMovies.status, "WATCHED"),
  eq(userMovies.watchedMedium, "THEATER"),
  gte(userMovies.trailerCount, 1),
);

const foundCount = sql<number>`(
  SELECT COUNT(*) FROM ${trailerFinds}
  WHERE ${trailerFinds.userId} = ${userMovies.userId}
    AND ${trailerFinds.visitTmdbId} = ${userMovies.tmdbId}
    AND ${trailerFinds.result} = 'match'
)`;

const huntColumns = {
  tmdbId: userMovies.tmdbId,
  title: movies.title,
  posterPath: movies.posterPath,
  watchedAt: sql<string>`${userMovies.watchedAt}`,
  watchedPlace: userMovies.watchedPlace,
  trailerCount: sql<number>`${userMovies.trailerCount}`,
  found: foundCount,
};

/** 探し終わっていない予告探し（見つけた本数が本数に達しておらず、終えていないもの）。見た日の新しい順。 */
export async function listOpenTrailerHunts(db: Db, userId: string): Promise<TrailerHunt[]> {
  return db
    .select(huntColumns)
    .from(userMovies)
    .innerJoin(movies, eq(movies.tmdbId, userMovies.tmdbId))
    .where(
      and(
        eq(userMovies.userId, userId),
        huntTarget,
        isNull(userMovies.trailerHuntClosedAt),
        sql`${foundCount} < ${userMovies.trailerCount}`,
      ),
    )
    .orderBy(desc(userMovies.watchedAt), desc(userMovies.updatedAt));
}

/** ある見た記録の予告探し。対象でなければ null。 */
export async function getTrailerHunt(
  db: Db,
  userId: string,
  tmdbId: number,
): Promise<(TrailerHunt & { closed: boolean }) | null> {
  const row = await db
    .select({ ...huntColumns, closedAt: userMovies.trailerHuntClosedAt })
    .from(userMovies)
    .innerJoin(movies, eq(movies.tmdbId, userMovies.tmdbId))
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId), huntTarget))
    .get();
  if (!row) return null;
  const { closedAt, ...hunt } = row;
  return { ...hunt, closed: closedAt !== null || hunt.found >= hunt.trailerCount };
}

export type FoundTrailer = {
  tmdbId: number;
  title: string | null;
  posterPath: string | null;
};

/** 予告探しで付けた「これだった」と「違う」。 */
export async function listTrailerFinds(db: Db, userId: string, visitTmdbId: number) {
  const rows = await db
    .select({
      candidateTmdbId: trailerFinds.candidateTmdbId,
      result: trailerFinds.result,
      title: movies.title,
      posterPath: movies.posterPath,
    })
    .from(trailerFinds)
    .leftJoin(movies, eq(movies.tmdbId, trailerFinds.candidateTmdbId))
    .where(and(eq(trailerFinds.userId, userId), eq(trailerFinds.visitTmdbId, visitTmdbId)))
    .orderBy(asc(trailerFinds.createdAt));
  return {
    matched: rows
      .filter((r) => r.result === "match")
      .map((r) => ({ tmdbId: r.candidateTmdbId, title: r.title, posterPath: r.posterPath })),
    rejectedIds: rows.filter((r) => r.result === "reject").map((r) => r.candidateTmdbId),
  };
}

/** 候補を取得し、見た映画・「これだった」・「違う」にした映画を除いて、最大20本を返す。 */
export async function loadTrailerCandidates(
  visit: { tmdbId: number; watchedAt: string },
  excluded: Set<number>,
): Promise<MovieSummary[]> {
  const pages = await Promise.all(
    Array.from({ length: CANDIDATE_PAGES }, (_, i) => listTrailerCandidates(visit.watchedAt, i + 1)),
  );
  const seen = new Set<number>([visit.tmdbId, ...excluded]);
  const result: MovieSummary[] = [];
  for (const movie of pages.flatMap((p) => p.results)) {
    if (seen.has(movie.tmdbId)) continue;
    seen.add(movie.tmdbId);
    result.push(movie);
    if (result.length >= CANDIDATE_LIMIT) break;
  }
  return result;
}

async function recordFind(
  db: Db,
  userId: string,
  visitTmdbId: number,
  candidateTmdbId: number,
  result: TrailerResult,
) {
  await db
    .insert(trailerFinds)
    .values({
      id: crypto.randomUUID(),
      userId,
      visitTmdbId,
      candidateTmdbId,
      result,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [trailerFinds.userId, trailerFinds.visitTmdbId, trailerFinds.candidateTmdbId],
      set: { result, createdAt: new Date().toISOString() },
    });
}

/**
 * 「これだった」：候補をリストに登録し、きっかけ（映画館の予告・見た日・映画館・「◯◯」の上映前）を入れる。
 * すでにリストにある映画なら、登録の状態は変えず、きっかけが空のときだけ入れる。
 */
export async function matchTrailer(
  db: Db,
  userId: string,
  hunt: TrailerHunt,
  candidateTmdbId: number,
  medium: SelectableMedium | null,
): Promise<void> {
  await ensureMovieSnapshot(db, candidateTmdbId);
  const existing = await db
    .select({ id: userMovies.id })
    .from(userMovies)
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, candidateTmdbId)))
    .get();
  if (!existing) {
    await setPreferredMedium(db, userId, candidateTmdbId, medium ?? "THEATER");
  }
  await db
    .update(userMovies)
    .set({
      discoveryType: "THEATER_TRAILER",
      discoveryDate: hunt.watchedAt,
      discoveryPlace: hunt.watchedPlace,
      discoveryNote: `「${hunt.title}」の上映前`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(userMovies.userId, userId),
        eq(userMovies.tmdbId, candidateTmdbId),
        // きっかけを入力済みの映画は上書きしない。
        isNull(userMovies.discoveryType),
        isNull(userMovies.discoveryDate),
        isNull(userMovies.discoveryPlace),
        isNull(userMovies.discoveryNote),
      ),
    );
  await recordFind(db, userId, hunt.tmdbId, candidateTmdbId, "match");
}

/** 「違う」。 */
export async function rejectTrailer(
  db: Db,
  userId: string,
  visitTmdbId: number,
  candidateTmdbId: number,
): Promise<void> {
  await recordFind(db, userId, visitTmdbId, candidateTmdbId, "reject");
}

/** 「違う」にした候補をすべて戻す。 */
export async function restoreRejects(db: Db, userId: string, visitTmdbId: number): Promise<void> {
  await db
    .delete(trailerFinds)
    .where(
      and(
        eq(trailerFinds.userId, userId),
        eq(trailerFinds.visitTmdbId, visitTmdbId),
        eq(trailerFinds.result, "reject"),
      ),
    );
}

/** 「探すのを終える」。 */
export async function closeTrailerHunt(db: Db, userId: string, visitTmdbId: number): Promise<void> {
  await db
    .update(userMovies)
    .set({ trailerHuntClosedAt: new Date().toISOString() })
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, visitTmdbId)));
}
