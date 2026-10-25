import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "~/lib/db/client.server";
import { upsertMovieSnapshot } from "~/lib/db/movies.server";
import {
  movieProviders,
  movies,
  streamingNotices,
  userMovies,
  type StreamingProvider,
} from "~/lib/db/schema";
import {
  getMovieDetail,
  getWatchProviders,
  TmdbError,
  TmdbNotFoundError,
} from "~/lib/tmdb/client.server";
import type { WatchProviders } from "~/lib/tmdb/types";

// 配信開始チェック（仕様書 009）。定期実行（workers/app.ts の scheduled）から呼ぶ。
// 「サブスク待ち」「劇場で見たい」の映画の日本の配信状況を確かめ、見放題・無料のサービスが
// 前回より増えていたら、その映画を登録している利用者にお知らせを作る。

/** 1回の実行で確かめる映画の本数の上限（無料プランの外部への通信は1回50まで）。 */
export const CHECK_LIMIT = 30;
/** 同じ映画を確かめ直すまでの間隔。 */
export const RECHECK_HOURS = 20;
/** 1回の実行で、ジャンルの分からない映画の詳細を取得する本数（仕様書 012 のための補完）。 */
export const GENRE_FILL_LIMIT = 5;

/** 配信開始チェックの対象の状態（サブスク待ち、劇場で見たい）。 */
export const watchingTarget = and(
  eq(userMovies.status, "WANT_TO_WATCH"),
  inArray(userMovies.preferredMedium, ["THEATER", "STREAMING"]),
);

/** 配信状況のうち、見放題（定額）と無料（広告付きを含む）のサービスだけを取り出す。 */
export function toStreamingProviders(providers: WatchProviders | null): StreamingProvider[] {
  if (!providers) return [];
  const result: StreamingProvider[] = [];
  const seen = new Set<number>();
  for (const [type, list] of [
    ["flatrate", providers.flatrate],
    ["free", providers.free],
  ] as const) {
    for (const p of list) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      result.push({ id: p.id, name: p.name, logoPath: p.logoPath, type });
    }
  }
  return result;
}

/** 前回の配信状況から増えたサービス。前回の記録がなければ（初めての確認）、何も増えていないとみなす。 */
export function addedProviders(
  previous: StreamingProvider[] | null,
  current: StreamingProvider[],
): StreamingProvider[] {
  if (previous === null) return [];
  const before = new Set(previous.map((p) => p.id));
  return current.filter((p) => !before.has(p.id));
}

export type StreamingCheckResult = {
  checked: number;
  notices: number;
  failed: number;
  genresFilled: number;
};

export async function runStreamingCheck(
  db: Db,
  now: Date = new Date(),
): Promise<StreamingCheckResult> {
  const nowIso = now.toISOString();
  const recheckBefore = new Date(now.getTime() - RECHECK_HOURS * 60 * 60 * 1000).toISOString();

  // 対象の映画を、前回の確認が古い順（未確認が先）に選ぶ。
  const targets = await db
    .select({
      tmdbId: userMovies.tmdbId,
      previous: movieProviders.providers,
      checkedAt: movieProviders.checkedAt,
    })
    .from(userMovies)
    .leftJoin(movieProviders, eq(movieProviders.tmdbId, userMovies.tmdbId))
    .where(
      and(
        watchingTarget,
        or(isNull(movieProviders.checkedAt), lt(movieProviders.checkedAt, recheckBefore)),
      ),
    )
    .groupBy(userMovies.tmdbId)
    .orderBy(sql`${movieProviders.checkedAt} IS NOT NULL`, asc(movieProviders.checkedAt))
    .limit(CHECK_LIMIT);

  const result: StreamingCheckResult = { checked: 0, notices: 0, failed: 0, genresFilled: 0 };
  if (targets.length > 0) {
    // その映画を対象の状態で登録している利用者（お知らせの宛先）。
    const watchers = await db
      .select({ userId: userMovies.userId, tmdbId: userMovies.tmdbId })
      .from(userMovies)
      .where(and(watchingTarget, inArray(userMovies.tmdbId, targets.map((t) => t.tmdbId))));

    const writes = [];
    for (const target of targets) {
      let current: StreamingProvider[];
      try {
        current = toStreamingProviders(await getWatchProviders(target.tmdbId));
      } catch (error) {
        if (error instanceof TmdbNotFoundError) {
          // TMDb から消えた映画。確認したことだけ記録し、配信状況は前回のままにする。
          current = target.previous ?? [];
        } else if (error instanceof TmdbError) {
          console.error(`配信状況を取得できませんでした（${target.tmdbId}）:`, error.message);
          result.failed += 1;
          continue;
        } else {
          throw error;
        }
      }
      result.checked += 1;

      for (const provider of addedProviders(target.previous ?? null, current)) {
        for (const w of watchers.filter((w) => w.tmdbId === target.tmdbId)) {
          result.notices += 1;
          writes.push(
            db
              .insert(streamingNotices)
              .values({
                id: crypto.randomUUID(),
                userId: w.userId,
                tmdbId: target.tmdbId,
                providerId: provider.id,
                providerName: provider.name,
                detectedAt: nowIso,
              })
              // 確認済みのお知らせがあれば、配信が再開したものとして出し直す。未確認なら増やさない。
              .onConflictDoUpdate({
                target: [streamingNotices.userId, streamingNotices.tmdbId, streamingNotices.providerId],
                set: { detectedAt: nowIso, dismissedAt: null, providerName: provider.name },
                setWhere: isNotNull(streamingNotices.dismissedAt),
              }),
          );
        }
      }

      writes.push(
        db
          .insert(movieProviders)
          .values({ tmdbId: target.tmdbId, providers: current, checkedAt: nowIso })
          .onConflictDoUpdate({
            target: movieProviders.tmdbId,
            set: { providers: current, checkedAt: nowIso },
          }),
      );
    }
    if (writes.length > 0) {
      // D1 への書き込みは1回にまとめる（外部への通信の回数を抑える）。
      await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
    }
  }

  result.genresFilled = await fillMissingGenres(db);
  return result;
}

/**
 * リストに入っている映画のうち、ジャンルがまだ分からないものを数本ずつ TMDb から補う（仕様書 012）。
 * おすすめの計算は、自分の記録の映画のジャンルを使うため。
 */
export async function fillMissingGenres(db: Db, limit = GENRE_FILL_LIMIT): Promise<number> {
  const missing = await db
    .selectDistinct({ tmdbId: movies.tmdbId })
    .from(movies)
    .innerJoin(userMovies, eq(userMovies.tmdbId, movies.tmdbId))
    .where(isNull(movies.genreIds))
    .orderBy(desc(movies.fetchedAt))
    .limit(limit);
  let filled = 0;
  for (const { tmdbId } of missing) {
    try {
      await upsertMovieSnapshot(db, await getMovieDetail(tmdbId));
      filled += 1;
    } catch (error) {
      if (error instanceof TmdbNotFoundError) {
        // TMDb から消えた映画は、空のジャンルとして記録し、毎回取りに行かないようにする。
        await db.update(movies).set({ genreIds: [] }).where(eq(movies.tmdbId, tmdbId));
        continue;
      }
      if (error instanceof TmdbError) break;
      throw error;
    }
  }
  return filled;
}

// ---- お知らせの表示（トップページ）----

export type StreamingNoticeItem = {
  id: string;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  providerName: string;
  detectedAt: string;
};

/** 確認していないお知らせ（新しい順）。視聴済み・見送り・リストから消した映画のものは含めない。 */
export async function listStreamingNotices(
  db: Db,
  userId: string,
): Promise<StreamingNoticeItem[]> {
  return db
    .select({
      id: streamingNotices.id,
      tmdbId: streamingNotices.tmdbId,
      title: movies.title,
      posterPath: movies.posterPath,
      providerName: streamingNotices.providerName,
      detectedAt: streamingNotices.detectedAt,
    })
    .from(streamingNotices)
    .innerJoin(movies, eq(movies.tmdbId, streamingNotices.tmdbId))
    .innerJoin(
      userMovies,
      and(
        eq(userMovies.userId, streamingNotices.userId),
        eq(userMovies.tmdbId, streamingNotices.tmdbId),
      ),
    )
    .where(
      and(eq(streamingNotices.userId, userId), isNull(streamingNotices.dismissedAt), watchingTarget),
    )
    .orderBy(desc(streamingNotices.detectedAt), asc(movies.title));
}

/** お知らせを「確認した」にする。他の利用者のお知らせは変えない。変えられたら true。 */
export async function dismissStreamingNotice(
  db: Db,
  userId: string,
  noticeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(streamingNotices)
    .set({ dismissedAt: now.toISOString() })
    .where(and(eq(streamingNotices.id, noticeId), eq(streamingNotices.userId, userId)))
    .returning({ id: streamingNotices.id });
  return updated.length > 0;
}
