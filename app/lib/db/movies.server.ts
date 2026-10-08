import { and, asc, eq, lt, notExists } from "drizzle-orm";

import { nowIso } from "~/lib/date";
import {
  getMovieDetail,
  TmdbError,
  TmdbNotFoundError,
} from "~/lib/tmdb/client.server";
import type { MovieSummary } from "~/lib/tmdb/types";

import type { Db } from "./client.server";
import { movies, userMovies } from "./schema";

/**
 * 映画のスナップショット（一覧で使う最小限の情報）を保存する。すでにあれば上書きする。
 * 一覧の画面は TMDb を呼ばず、ここに保存した内容で表示する。
 */
export async function upsertMovieSnapshot(db: Db, movie: MovieSummary): Promise<void> {
  const values = {
    tmdbId: movie.tmdbId,
    title: movie.title,
    originalTitle: movie.originalTitle,
    releaseDate: movie.releaseDate,
    posterPath: movie.posterPath,
    fetchedAt: nowIso(),
  };
  await db
    .insert(movies)
    .values(values)
    .onConflictDoUpdate({
      target: movies.tmdbId,
      set: {
        title: values.title,
        originalTitle: values.originalTitle,
        releaseDate: values.releaseDate,
        posterPath: values.posterPath,
        fetchedAt: values.fetchedAt,
      },
    });
}

/**
 * 映画のスナップショットがなければ、TMDb から取得して作る。
 * 映画を登録する前に呼ぶ（user_movies は movies を参照するため）。
 * TMDb に映画がなければ TmdbNotFoundError、取得できなければ TmdbError を投げる。
 */
export async function ensureMovieSnapshot(db: Db, tmdbId: number): Promise<void> {
  const existing = await db
    .select({ tmdbId: movies.tmdbId })
    .from(movies)
    .where(eq(movies.tmdbId, tmdbId))
    .get();
  if (existing) return;
  await upsertMovieSnapshot(db, await getMovieDetail(tmdbId));
}

/** スナップショットを「古い」とみなすまでの日数。 */
export const SNAPSHOT_MAX_AGE_DAYS = 30;
/** 1回の呼び出しで取り直す本数の上限（TMDb への呼び出しを増やしすぎないため）。 */
const REFRESH_LIMIT = 3;

/**
 * 古くなったスナップショットを整理する。TMDb の利用条件（データを6か月を超えて保持しない）を
 * 守るため、長いあいだ詳細を開いていない映画の情報を持ち続けないようにする。
 *  - どの利用者のリストにも入っていない映画の、古いスナップショットは消す。
 *  - リストに入っている映画の、古いスナップショットは、古い順に数本ずつ TMDb から取り直す。
 * 一覧の画面から、応答を返したあとに呼ぶ（画面の表示は待たせない）。取り直した本数を返す。
 */
export async function refreshStaleSnapshots(db: Db, now: Date = new Date()): Promise<number> {
  const threshold = new Date(
    now.getTime() - SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const stale = lt(movies.fetchedAt, threshold);

  await db
    .delete(movies)
    .where(
      and(
        stale,
        notExists(
          db
            .select({ id: userMovies.id })
            .from(userMovies)
            .where(eq(userMovies.tmdbId, movies.tmdbId)),
        ),
      ),
    );

  const targets = await db
    .select({ tmdbId: movies.tmdbId })
    .from(movies)
    .where(stale)
    .orderBy(asc(movies.fetchedAt))
    .limit(REFRESH_LIMIT);

  let refreshed = 0;
  for (const { tmdbId } of targets) {
    try {
      await upsertMovieSnapshot(db, await getMovieDetail(tmdbId));
      refreshed += 1;
    } catch (error) {
      if (error instanceof TmdbNotFoundError) {
        // TMDb から消えた映画。利用者の記録が参照しているので行は残し、
        // 毎回取り直そうとしないよう、確認した日時だけ更新する。
        await db.update(movies).set({ fetchedAt: nowIso(now) }).where(eq(movies.tmdbId, tmdbId));
        continue;
      }
      if (error instanceof TmdbError) {
        // TMDb が応答できないときは、今回はあきらめる（次に一覧を開いたときにまた試す）。
        console.error("スナップショットを取り直せませんでした:", error.message);
        break;
      }
      throw error;
    }
  }
  return refreshed;
}
