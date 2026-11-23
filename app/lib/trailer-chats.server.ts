import { and, asc, count, eq, gte, inArray } from "drizzle-orm";

import {
  askTrailerAi,
  TrailerAiError,
  type AiSuggestion,
} from "~/lib/ai/trailer-chat.server";
import type { Db } from "~/lib/db/client.server";
import { upsertMovieSnapshot } from "~/lib/db/movies.server";
import { movies, trailerChats, type ChatCandidate, type ChatRole } from "~/lib/db/schema";
import { todayInTokyo } from "~/lib/date";
import { findMovieByTitle, listTrailerCandidates, TmdbError } from "~/lib/tmdb/client.server";
import type { MovieSummary } from "~/lib/tmdb/types";
import { listTrailerFinds, type TrailerHunt } from "~/lib/trailers.server";

// 「AI に相談」の会話の保存と、1日の上限（仕様書 014）。

/** AI の返答の、利用者ごとの1日（日本時間）の上限。 */
export const DAILY_AI_REPLIES = 20;
/** 1回の入力の文字数の上限。 */
export const MAX_MESSAGE_LENGTH = 1000;
/** AI に渡す候補を取得するページ数（1ページ20本）。 */
const CONTEXT_PAGES = 3;

export const AI_LIMIT_MESSAGE = `今日の AI への相談は${DAILY_AI_REPLIES}回までです。明日また使えます。`;
export const AI_ERROR_MESSAGE = "AI から返答をもらえませんでした。少し時間をおいて、もう一度送ってください。";
export const AI_REFUSAL_MESSAGE = "AI がこの内容には答えられませんでした。書き方を変えて送ってください。";

export type ChatRow = {
  id: string;
  role: ChatRole;
  content: string;
  candidates: ChatCandidate[];
};

/** 予告探しの会話（古い順）。 */
export async function listTrailerChats(db: Db, userId: string, visitTmdbId: number): Promise<ChatRow[]> {
  const rows = await db
    .select({
      id: trailerChats.id,
      role: trailerChats.role,
      content: trailerChats.content,
      candidates: trailerChats.candidates,
    })
    .from(trailerChats)
    .where(and(eq(trailerChats.userId, userId), eq(trailerChats.visitTmdbId, visitTmdbId)))
    .orderBy(asc(trailerChats.createdAt));
  return rows.map((r) => ({ ...r, candidates: r.candidates ?? [] }));
}

/** D1 の1つの SQL に渡せる値の上限（100）を超えないよう、ID をこの本数ずつに分けて読む。 */
const ID_CHUNK = 90;

export type SnapshotRow = { tmdbId: number; title: string; releaseDate: string | null; posterPath: string | null };

/** 保存済みのスナップショットを、ID で読む。 */
export async function loadSnapshots(db: Db, ids: number[]): Promise<Map<number, SnapshotRow>> {
  const result = new Map<number, SnapshotRow>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        tmdbId: movies.tmdbId,
        title: movies.title,
        releaseDate: movies.releaseDate,
        posterPath: movies.posterPath,
      })
      .from(movies)
      .where(inArray(movies.tmdbId, unique.slice(i, i + ID_CHUNK)));
    for (const r of rows) result.set(r.tmdbId, r);
  }
  return result;
}

/** 日本時間の今日の 0 時（UTC の ISO 形式）。 */
function startOfTodayInTokyo(now: Date): string {
  return new Date(`${todayInTokyo(now)}T00:00:00+09:00`).toISOString();
}

/** 今日（日本時間）の AI の返答の回数。 */
export async function countAiRepliesToday(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(trailerChats)
    .where(
      and(
        eq(trailerChats.userId, userId),
        eq(trailerChats.role, "assistant"),
        gte(trailerChats.createdAt, startOfTodayInTokyo(now)),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** AI に渡す、その時期に公開される映画の候補（最大60本）。取得できなければ空。 */
async function loadContextPool(hunt: TrailerHunt): Promise<MovieSummary[]> {
  try {
    const pages = await Promise.all(
      Array.from({ length: CONTEXT_PAGES }, (_, i) => listTrailerCandidates(hunt.watchedAt, i + 1)),
    );
    const seen = new Set<number>([hunt.tmdbId]);
    return pages
      .flatMap((p) => p.results)
      .filter((m) => (seen.has(m.tmdbId) ? false : (seen.add(m.tmdbId), true)));
  } catch (e) {
    if (!(e instanceof TmdbError)) throw e;
    console.error("AI に渡す候補を取得できませんでした:", e.message);
    return [];
  }
}

/** AI が挙げた作品を TMDb の作品に結び付ける。特定できない作品と、除く作品は落とす。 */
async function resolveSuggestions(
  suggestions: AiSuggestion[],
  pool: Map<number, MovieSummary>,
  excluded: Set<number>,
): Promise<{ movie: MovieSummary; reason: string }[]> {
  const resolved = await Promise.all(
    suggestions.map(async (s) => {
      const fromPool = s.tmdbId !== null ? pool.get(s.tmdbId) : undefined;
      if (fromPool) return { movie: fromPool, reason: s.reason };
      try {
        const found =
          (await findMovieByTitle(s.title, s.year)) ??
          (s.originalTitle && s.originalTitle !== s.title ? await findMovieByTitle(s.originalTitle, s.year) : null);
        return found ? { movie: found, reason: s.reason } : null;
      } catch (e) {
        if (!(e instanceof TmdbError)) throw e;
        console.error("AI の候補を TMDb で特定できませんでした:", e.message);
        return null;
      }
    }),
  );
  const seen = new Set(excluded);
  const result: { movie: MovieSummary; reason: string }[] = [];
  for (const r of resolved) {
    if (!r || seen.has(r.movie.tmdbId)) continue;
    seen.add(r.movie.tmdbId);
    result.push(r);
  }
  return result;
}

export type ConsultResult = { ok: true } | { ok: false; error: string };

/**
 * AI に相談し、入力と返答を会話に保存する。
 * 上限に達しているとき・AI が失敗したときは、API を呼ばない／会話に残さない。
 */
export async function consultTrailerAi(
  db: Db,
  userId: string,
  hunt: TrailerHunt,
  message: string,
  now: Date = new Date(),
): Promise<ConsultResult> {
  if ((await countAiRepliesToday(db, userId, now)) >= DAILY_AI_REPLIES) {
    return { ok: false, error: AI_LIMIT_MESSAGE };
  }
  const askedAt = now.toISOString();

  const [pool, finds, history] = await Promise.all([
    loadContextPool(hunt),
    listTrailerFinds(db, userId, hunt.tmdbId),
    listTrailerChats(db, userId, hunt.tmdbId),
  ]);
  const poolMap = new Map(pool.map((m) => [m.tmdbId, m]));

  // 「違う」にした作品のタイトル。候補の一覧にないもの（AI が挙げた作品）は、保存済みのスナップショットから。
  const rejectedIds = finds.rejectedIds;
  const snapshots = await loadSnapshots(
    db,
    rejectedIds.filter((id) => !poolMap.has(id)),
  );
  const rejectedTitles = rejectedIds
    .map((id) => poolMap.get(id)?.title ?? snapshots.get(id)?.title)
    .filter((t): t is string => Boolean(t));

  let reply;
  try {
    reply = await askTrailerAi({
      visitTitle: hunt.title,
      visitDate: hunt.watchedAt,
      candidates: pool.map((m) => ({
        tmdbId: m.tmdbId,
        title: m.title,
        originalTitle: m.originalTitle,
        releaseDate: m.releaseDate,
      })),
      rejectedTitles,
      history: history.map((h) => ({ role: h.role, content: h.content })),
      message,
    });
  } catch (e) {
    if (!(e instanceof TrailerAiError)) throw e;
    console.error("AI への相談に失敗しました:", e.message);
    return { ok: false, error: e.reason === "refusal" ? AI_REFUSAL_MESSAGE : AI_ERROR_MESSAGE };
  }

  const excluded = new Set([hunt.tmdbId, ...rejectedIds, ...finds.matched.map((m) => m.tmdbId)]);
  const resolved = await resolveSuggestions(reply.suggestions, poolMap, excluded);
  // 候補のカードを表示するため、スナップショットを保存する（古くなったものは一覧の画面の裏で整理される）。
  for (const r of resolved) await upsertMovieSnapshot(db, r.movie);

  // 並び順が入れ替わらないよう、返答は入力の1ミリ秒後の時刻で保存する（1日の回数は入力した時刻で数える）。
  const repliedAt = new Date(now.getTime() + 1).toISOString();
  await db.insert(trailerChats).values([
    {
      id: crypto.randomUUID(),
      userId,
      visitTmdbId: hunt.tmdbId,
      role: "user",
      content: message,
      candidates: null,
      createdAt: askedAt,
    },
    {
      id: crypto.randomUUID(),
      userId,
      visitTmdbId: hunt.tmdbId,
      role: "assistant",
      content: reply.message,
      candidates: resolved.map((r) => ({ tmdbId: r.movie.tmdbId, reason: r.reason })),
      createdAt: repliedAt,
    },
  ]);
  return { ok: true };
}
