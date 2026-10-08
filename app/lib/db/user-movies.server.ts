import { and, asc, desc, eq, sql } from "drizzle-orm";

import { nowIso } from "~/lib/date";
import { stateKeyOf, type SelectableMedium, type StateKey } from "~/lib/labels";
import { RECENT_WATCHED_LIMIT, type ListFilter } from "~/lib/list";
import type { DiscoveryValues, WatchedValues } from "~/lib/validation";

import type { Db } from "./client.server";
import {
  movies,
  userMovies,
  type DiscoveryType,
  type PreferredMedium,
  type Status,
  type UserMovie,
  type WatchedMedium,
} from "./schema";

// 利用者と映画の関係（見たい・きっかけ・見た記録）を読み書きする。
// 他の利用者のデータに触れないよう、すべての関数で userId を必須にする。

/** 利用者が登録している映画の状態を、TMDb の ID をキーにして返す。 */
export async function getStatesByTmdbId(
  db: Db,
  userId: string,
): Promise<Map<number, StateKey>> {
  const rows = await db
    .select({
      tmdbId: userMovies.tmdbId,
      status: userMovies.status,
      preferredMedium: userMovies.preferredMedium,
    })
    .from(userMovies)
    .where(eq(userMovies.userId, userId));
  return new Map(rows.map((row) => [row.tmdbId, stateKeyOf(row)]));
}

/** 利用者の、ある映画についての記録。未登録なら null。 */
export async function getUserMovie(
  db: Db,
  userId: string,
  tmdbId: number,
): Promise<UserMovie | null> {
  const row = await db
    .select()
    .from(userMovies)
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId)))
    .get();
  return row ?? null;
}

/**
 * 「どこまでなら見たいか」を登録・変更する。未登録なら行を作る。
 * すでに視聴済みの映画では、見た記録を消さないよう、状態は視聴済みのままにする。
 * 先に movies のスナップショットがあること（外部キー）。
 */
export async function setPreferredMedium(
  db: Db,
  userId: string,
  tmdbId: number,
  medium: SelectableMedium,
): Promise<void> {
  const status: Status = medium === "NONE" ? "SKIPPED" : "WANT_TO_WATCH";
  const now = nowIso();
  await db
    .insert(userMovies)
    .values({
      id: crypto.randomUUID(),
      userId,
      tmdbId,
      status,
      preferredMedium: medium,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userMovies.userId, userMovies.tmdbId],
      set: {
        status: sql`CASE WHEN ${userMovies.status} = 'WATCHED' THEN 'WATCHED' ELSE ${status} END`,
        preferredMedium: medium,
        updatedAt: now,
      },
    });
}

/** 映画を自分のリストから消す（きっかけや見た記録も消える）。 */
export async function removeUserMovie(
  db: Db,
  userId: string,
  tmdbId: number,
): Promise<void> {
  await db
    .delete(userMovies)
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId)));
}

/** きっかけを保存する。未登録の映画には保存できない（false を返す）。 */
export async function saveDiscovery(
  db: Db,
  userId: string,
  tmdbId: number,
  values: DiscoveryValues,
): Promise<boolean> {
  const updated = await db
    .update(userMovies)
    .set({
      discoveryType: values.type,
      discoveryDate: values.date,
      discoveryPlace: values.place,
      discoveryNote: values.note,
      updatedAt: nowIso(),
    })
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId)))
    .returning({ id: userMovies.id });
  return updated.length > 0;
}

/**
 * 見た記録を保存する。未登録の映画なら、視聴済みとして行を作る。
 * すでに見た記録があれば上書きする（1本につき記録は1つ）。
 * 先に movies のスナップショットがあること（外部キー）。
 */
export async function saveWatched(
  db: Db,
  userId: string,
  tmdbId: number,
  values: WatchedValues,
): Promise<void> {
  const now = nowIso();
  const watched = {
    status: "WATCHED" as const,
    watchedAt: values.watchedAt,
    watchedMedium: values.medium,
    watchedPlace: values.place,
    rating: values.rating,
    review: values.review,
    updatedAt: now,
  };
  await db
    .insert(userMovies)
    .values({
      id: crypto.randomUUID(),
      userId,
      tmdbId,
      preferredMedium: null,
      createdAt: now,
      ...watched,
    })
    .onConflictDoUpdate({
      target: [userMovies.userId, userMovies.tmdbId],
      set: watched,
    });
}

/**
 * 見た記録を取り消し、見る前の状態に戻す。
 * 「どこまでなら見たいか」を登録していなかった映画（直接「見た」を付けた映画）は、
 * 戻す先の状態がないので、リストから消す。
 */
export async function unwatch(db: Db, userId: string, tmdbId: number): Promise<void> {
  const record = await getUserMovie(db, userId, tmdbId);
  if (!record || record.status !== "WATCHED") return;

  if (record.preferredMedium === null) {
    await removeUserMovie(db, userId, tmdbId);
    return;
  }
  await db
    .update(userMovies)
    .set({
      status: record.preferredMedium === "NONE" ? "SKIPPED" : "WANT_TO_WATCH",
      watchedAt: null,
      watchedMedium: null,
      watchedPlace: null,
      rating: null,
      review: null,
      updatedAt: nowIso(),
    })
    .where(and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId)));
}

const MAX_SUGGESTIONS = 10;

export type PlaceSuggestions = {
  /** きっかけの「場所」の候補。 */
  discovery: string[];
  /** 見た記録の「場所・サービス名」の候補（視聴方法ごと）。 */
  watched: Record<WatchedMedium, string[]>;
};

/**
 * 以前に入力した場所・サービス名を、入力の候補として返す（重複なし、新しい順、最大10件ずつ）。
 * 映画館の名前は、きっかけの場所と、劇場で見たときの場所の両方に出てくるので、互いの候補に含める。
 */
export async function listPlaceSuggestions(
  db: Db,
  userId: string,
): Promise<PlaceSuggestions> {
  const rows = await db
    .select({
      discoveryPlace: userMovies.discoveryPlace,
      watchedPlace: userMovies.watchedPlace,
      watchedMedium: userMovies.watchedMedium,
    })
    .from(userMovies)
    .where(eq(userMovies.userId, userId))
    .orderBy(desc(userMovies.updatedAt));

  const theaters = new Set<string>();
  const byMedium: Record<WatchedMedium, Set<string>> = {
    THEATER: theaters,
    STREAMING: new Set(),
    RENTAL: new Set(),
    OTHER: new Set(),
  };
  for (const row of rows) {
    if (row.discoveryPlace) theaters.add(row.discoveryPlace);
    if (row.watchedPlace && row.watchedMedium) {
      byMedium[row.watchedMedium].add(row.watchedPlace);
    }
  }

  const take = (set: Set<string>) => [...set].slice(0, MAX_SUGGESTIONS);
  return {
    discovery: take(theaters),
    watched: {
      THEATER: take(byMedium.THEATER),
      STREAMING: take(byMedium.STREAMING),
      RENTAL: take(byMedium.RENTAL),
      OTHER: take(byMedium.OTHER),
    },
  };
}

// ---- 一覧（トップページとリスト）----

const listColumns = {
  tmdbId: userMovies.tmdbId,
  title: movies.title,
  posterPath: movies.posterPath,
  releaseDate: movies.releaseDate,
  status: userMovies.status,
  preferredMedium: userMovies.preferredMedium,
  discoveryType: userMovies.discoveryType,
  discoveryDate: userMovies.discoveryDate,
  discoveryPlace: userMovies.discoveryPlace,
  discoveryNote: userMovies.discoveryNote,
  watchedAt: userMovies.watchedAt,
  watchedMedium: userMovies.watchedMedium,
  watchedPlace: userMovies.watchedPlace,
  rating: userMovies.rating,
};

/** 一覧に出す1本ぶんの情報。タイトルやポスターは、保存済みのスナップショットから取る（TMDb を呼ばない）。 */
export type ListItem = {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  releaseDate: string | null;
  status: Status;
  preferredMedium: PreferredMedium | null;
  discoveryType: DiscoveryType | null;
  discoveryDate: string | null;
  discoveryPlace: string | null;
  discoveryNote: string | null;
  watchedAt: string | null;
  watchedMedium: WatchedMedium | null;
  watchedPlace: string | null;
  rating: number | null;
};

function listQuery(db: Db, userId: string, filter: ListFilter) {
  const base = db
    .select(listColumns)
    .from(userMovies)
    .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId));
  const mine = eq(userMovies.userId, userId);

  switch (filter) {
    case "theater":
      // 公開日が早い順（上映が先に終わりそうなものが上）。公開日が未定のものは最後。
      return base
        .where(
          and(
            mine,
            eq(userMovies.status, "WANT_TO_WATCH"),
            eq(userMovies.preferredMedium, "THEATER"),
          ),
        )
        .orderBy(
          sql`${movies.releaseDate} IS NULL`,
          asc(movies.releaseDate),
          desc(userMovies.createdAt),
        );
    case "streaming":
      // 登録が新しい順。
      return base
        .where(
          and(
            mine,
            eq(userMovies.status, "WANT_TO_WATCH"),
            eq(userMovies.preferredMedium, "STREAMING"),
          ),
        )
        .orderBy(desc(userMovies.createdAt));
    case "watched":
      // 見た日が新しい順。同じ日なら、あとから記録したものが上。
      return base
        .where(and(mine, eq(userMovies.status, "WATCHED")))
        .orderBy(desc(userMovies.watchedAt), desc(userMovies.updatedAt));
    case "skipped":
      return base
        .where(and(mine, eq(userMovies.status, "SKIPPED")))
        .orderBy(desc(userMovies.updatedAt));
    case "all":
      return base.where(mine).orderBy(desc(userMovies.updatedAt));
  }
}

/** トップページの3つの区分。見送りにした映画は含まない。 */
export async function listForHome(
  db: Db,
  userId: string,
): Promise<{
  theater: ListItem[];
  streaming: ListItem[];
  watched: ListItem[];
  /** 「最近見た」に出しきれない見た記録があるか。 */
  hasMoreWatched: boolean;
}> {
  const [theater, streaming, watched] = await db.batch([
    listQuery(db, userId, "theater"),
    listQuery(db, userId, "streaming"),
    // 続きがあるかを知るために、1本多く取る。
    listQuery(db, userId, "watched").limit(RECENT_WATCHED_LIMIT + 1),
  ]);
  return {
    theater,
    streaming,
    watched: watched.slice(0, RECENT_WATCHED_LIMIT),
    hasMoreWatched: watched.length > RECENT_WATCHED_LIMIT,
  };
}

/** 登録したすべての映画を、区分で絞って返す。 */
export async function listByFilter(
  db: Db,
  userId: string,
  filter: ListFilter,
): Promise<ListItem[]> {
  return listQuery(db, userId, filter);
}
