import { data, Form, isRouteErrorResponse, Link } from "react-router";

import { Poster } from "~/components/Poster";
import { TrailerCandidate, type CandidateItem } from "~/components/TrailerCandidate";
import { huntLabel } from "~/components/TrailerHuntList";
import { requireUser } from "~/context";
import { getDb } from "~/lib/db/client.server";
import { getStatesByTmdbId } from "~/lib/db/user-movies.server";
import { SITE_NAME, TMDB_ERROR_MESSAGE } from "~/lib/site";
import { TmdbError, TmdbNotFoundError } from "~/lib/tmdb/client.server";
import {
  closeTrailerHunt,
  getTrailerHunt,
  listTrailerFinds,
  loadTrailerCandidates,
  matchTrailer,
  rejectTrailer,
  restoreRejects,
} from "~/lib/trailers.server";
import { parseMedium, parseTmdbId } from "~/lib/validation";

import type { Route } from "./+types/trailers";

const NOT_FOUND = "この予告探しは見つかりませんでした";

export function meta() {
  return [{ title: `予告を探す | ${SITE_NAME}` }];
}

async function requireHunt(userId: string, value: string | undefined) {
  const tmdbId = parseTmdbId(value);
  const hunt = tmdbId === null ? null : await getTrailerHunt(getDb(), userId, tmdbId);
  if (!hunt) throw data(NOT_FOUND, { status: 404 });
  return hunt;
}

// 予告で見た映画を探す（仕様書 013）。`:tmdbId` は、劇場で見た映画。
export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context);
  const db = getDb();
  const hunt = await requireHunt(user.id, params.tmdbId);
  const finds = await listTrailerFinds(db, user.id, hunt.tmdbId);

  let candidates: CandidateItem[] = [];
  let error: string | null = null;
  if (!hunt.closed) {
    try {
      const excluded = new Set([...finds.matched.map((m) => m.tmdbId), ...finds.rejectedIds]);
      const [movies, states] = await Promise.all([
        loadTrailerCandidates(hunt, excluded),
        getStatesByTmdbId(db, user.id),
      ]);
      candidates = movies.map((m) => ({
        tmdbId: m.tmdbId,
        title: m.title,
        releaseDate: m.releaseDate,
        posterPath: m.posterPath,
        state: states.get(m.tmdbId) ?? null,
      }));
    } catch (e) {
      if (!(e instanceof TmdbError)) throw e;
      console.error("予告探しの候補を取得できませんでした:", e.message);
      error = TMDB_ERROR_MESSAGE;
    }
  }

  return {
    hunt,
    matched: finds.matched,
    rejectedCount: finds.rejectedIds.length,
    candidates,
    error,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = requireUser(context);
  const db = getDb();
  const hunt = await requireHunt(user.id, params.tmdbId);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const invalid = (message: string) => data({ ok: false, error: message }, { status: 400 });

  switch (intent) {
    case "match":
    case "reject": {
      const candidate = parseTmdbId(String(form.get("candidate") ?? ""));
      if (candidate === null || candidate === hunt.tmdbId) return invalid("候補を選び直してください。");
      if (intent === "reject") {
        await rejectTrailer(db, user.id, hunt.tmdbId, candidate);
        return { ok: true };
      }
      const states = await getStatesByTmdbId(db, user.id);
      const medium = parseMedium(form);
      // リストにない映画を登録するときは、区分（劇場／サブスク／見送る）が必要。
      if (!states.has(candidate) && medium === null) return invalid("どこまでなら見たいかを選んでください。");
      try {
        await matchTrailer(db, user.id, hunt, candidate, medium);
      } catch (e) {
        if (e instanceof TmdbNotFoundError) return invalid("この映画は TMDb に見つかりませんでした。");
        if (e instanceof TmdbError) return invalid(TMDB_ERROR_MESSAGE);
        throw e;
      }
      return { ok: true };
    }
    case "restore-rejects":
      await restoreRejects(db, user.id, hunt.tmdbId);
      return { ok: true };
    case "close":
      await closeTrailerHunt(db, user.id, hunt.tmdbId);
      return { ok: true };
    default:
      return invalid("この操作は受け付けられません。");
  }
}

export default function TrailerHuntPage({ loaderData }: Route.ComponentProps) {
  const { hunt, matched, rejectedCount, candidates, error } = loaderData;
  const remaining = Math.max(hunt.trailerCount - hunt.found, 0);

  return (
    <div>
      <p>
        <Link to="/" className="text-sm text-amber-400 underline">
          ← ホーム
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">予告を探す</h1>
      <p className="mt-1 text-sm text-zinc-300">{huntLabel(hunt)}</p>
      <p className="mt-1 text-sm font-bold text-amber-300" data-progress>
        {hunt.closed
          ? hunt.found >= hunt.trailerCount
            ? `気になった予告 ${hunt.trailerCount}本をすべて見つけました`
            : `探すのを終えました（${hunt.trailerCount}本中 ${hunt.found}本）`
          : `気になった予告 ${hunt.trailerCount}本中 あと${remaining}本`}
      </p>

      {matched.length > 0 && (
        <section className="mt-4" aria-labelledby="matched-title" data-section="matched">
          <h2 id="matched-title" className="section-title mb-2">
            見つけた予告
          </h2>
          <ul className="grid grid-cols-4 gap-2">
            {matched.map((m) => (
              <li key={m.tmdbId} className="min-w-0">
                <Link to={`/movies/${m.tmdbId}`} className="block">
                  <Poster path={m.posterPath} title={m.title ?? "（不明）"} size="w185" />
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug">{m.title}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!hunt.closed && (
        <section className="mt-6" aria-labelledby="candidates-title">
          <h2 id="candidates-title" className="section-title">
            候補
          </h2>
          <p className="mt-1 text-xs text-muted">
            この日の1か月前から半年後までに公開（予定）の映画を、注目度の高い順に並べています。予告を見て「これだった」か「違う」を押してください。
          </p>
          {error && (
            <p role="alert" className="panel mt-3 text-sm text-red-300">
              {error}
            </p>
          )}
          {!error && candidates.length === 0 && (
            <p className="mt-6 text-center text-sm text-muted">候補がありません。</p>
          )}
          <ul className="mt-3 space-y-2">
            {candidates.map((candidate) => (
              <li key={candidate.tmdbId}>
                <TrailerCandidate candidate={candidate} />
              </li>
            ))}
          </ul>

          <div className="mt-6 flex flex-col gap-2">
            {rejectedCount > 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="restore-rejects" />
                <button type="submit" className="btn btn-quiet w-full text-xs">
                  {`「違う」にした${rejectedCount}本を戻す`}
                </button>
              </Form>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="close" />
              <button type="submit" className="btn w-full text-xs">
                探すのを終える
              </button>
            </Form>
          </div>
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error) && typeof error.data === "string" ? error.data : "エラーが発生しました";
  return (
    <div className="py-12 text-center">
      <h1 className="text-lg font-bold">{message}</h1>
      <p className="mt-6">
        <Link to="/" className="btn">
          ホームへ
        </Link>
      </p>
    </div>
  );
}
