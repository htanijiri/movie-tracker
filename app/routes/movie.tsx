import { data, isRouteErrorResponse, Link } from "react-router";

import { MyRecord, type ActionResult } from "~/components/MyRecord";
import { Poster } from "~/components/Poster";
import { TrailerPlayer } from "~/components/TrailerPlayer";
import { WatchProvidersSection } from "~/components/WatchProvidersSection";
import { requireUser } from "~/context";
import { formatYmd, todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { ensureMovieSnapshot, upsertMovieSnapshot } from "~/lib/db/movies.server";
import {
  getUserMovie,
  listPlaceSuggestions,
  removeUserMovie,
  saveDiscovery,
  saveWatched,
  setPreferredMedium,
  unwatch,
} from "~/lib/db/user-movies.server";
import { formatRuntime } from "~/lib/format";
import { SITE_NAME, TMDB_ERROR_MESSAGE } from "~/lib/site";
import {
  getMovieDetail,
  TmdbError,
  TmdbNotFoundError,
} from "~/lib/tmdb/client.server";
import { backdropUrl } from "~/lib/tmdb/images";
import {
  parseDiscovery,
  parseMedium,
  parseTmdbId,
  parseWatched,
} from "~/lib/validation";

import type { Route } from "./+types/movie";

const NOT_FOUND_MESSAGE = "映画が見つかりませんでした";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.movie.title ?? "映画"} | ${SITE_NAME}` }];
}

/** URL の映画 ID を取り出す。数字でなければ、TMDb を呼ばずに 404 にする。 */
function requireTmdbId(value: string | undefined): number {
  const tmdbId = parseTmdbId(value);
  if (tmdbId === null) throw data(NOT_FOUND_MESSAGE, { status: 404 });
  return tmdbId;
}

/** TMDb の失敗を、画面に出せる応答に変える。 */
function toRouteError(error: unknown): never {
  if (error instanceof TmdbNotFoundError) throw data(NOT_FOUND_MESSAGE, { status: 404 });
  if (error instanceof TmdbError) {
    console.error("TMDb から映画の詳細を取得できませんでした:", error.message);
    throw data(TMDB_ERROR_MESSAGE, { status: 503 });
  }
  throw error;
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context);
  const tmdbId = requireTmdbId(params.tmdbId);

  const movie = await getMovieDetail(tmdbId).catch(toRouteError);

  const db = getDb();
  // 一覧の画面で TMDb を呼ばずにタイトルとポスターを出せるよう、最小限の情報を保存しておく。
  await upsertMovieSnapshot(db, movie);
  const [record, suggestions] = await Promise.all([
    getUserMovie(db, user.id, tmdbId),
    listPlaceSuggestions(db, user.id),
  ]);

  return { movie, record, suggestions, today: todayInTokyo() };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = requireUser(context);
  const tmdbId = requireTmdbId(params.tmdbId);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const db = getDb();

  const ok = (): ActionResult => ({ ok: true, intent });
  const invalid = (errors: Record<string, string>, values: Record<string, string> = {}) =>
    data<ActionResult>({ ok: false, intent, errors, values }, { status: 400 });

  switch (intent) {
    // 「劇場で見たい／サブスクで見たい／見送る」（仕様書 004）
    case "set-medium": {
      const medium = parseMedium(form);
      if (!medium) return invalid({ medium: "選び直してください。" });
      await ensureMovieSnapshot(db, tmdbId).catch(toRouteError);
      await setPreferredMedium(db, user.id, tmdbId, medium);
      return ok();
    }

    // 登録の取り消し（仕様書 004）
    case "remove": {
      await removeUserMovie(db, user.id, tmdbId);
      return ok();
    }

    // 知ったきっかけ（仕様書 005）
    case "save-discovery": {
      const parsed = parseDiscovery(form);
      if (!parsed.ok) return invalid(parsed.errors, parsed.values);
      const saved = await saveDiscovery(db, user.id, tmdbId, parsed.values);
      if (!saved) {
        return invalid({ form: "先に、この映画をリストに登録してください。" });
      }
      return ok();
    }

    // 見た記録（仕様書 006）
    case "save-watched": {
      const parsed = parseWatched(form, todayInTokyo());
      if (!parsed.ok) return invalid(parsed.errors, parsed.values);
      await ensureMovieSnapshot(db, tmdbId).catch(toRouteError);
      await saveWatched(db, user.id, tmdbId, parsed.values);
      return ok();
    }

    // 見た記録の取り消し（仕様書 006）
    case "unwatch": {
      await unwatch(db, user.id, tmdbId);
      return ok();
    }

    default:
      return invalid({ form: "この操作は受け付けられません。" });
  }
}

export default function MovieDetailPage({ loaderData, actionData }: Route.ComponentProps) {
  const { movie, record, suggestions, today } = loaderData;
  const backdrop = backdropUrl(movie.backdropPath);
  const facts = [
    formatYmd(movie.releaseDate) ? `${formatYmd(movie.releaseDate)} 公開` : "公開日未定",
    formatRuntime(movie.runtime),
  ].filter(Boolean);

  return (
    <article>
      {backdrop && (
        <div className="-mx-4 -mb-16 h-40 overflow-hidden" aria-hidden="true">
          <img
            src={backdrop}
            alt=""
            className="h-full w-full object-cover opacity-40 [mask-image:linear-gradient(to_bottom,black_30%,transparent)]"
          />
        </div>
      )}

      <header className="relative flex gap-4">
        <div className="w-28 shrink-0">
          <Poster path={movie.posterPath} title={movie.title} className="shadow-lg" />
        </div>
        <div className="min-w-0 flex-1 self-end">
          <h1 className="text-xl font-bold leading-snug">{movie.title}</h1>
          {movie.originalTitle && movie.originalTitle !== movie.title && (
            <p className="mt-0.5 text-xs text-muted" lang="und">
              {movie.originalTitle}
            </p>
          )}
          <p className="mt-2 text-sm text-zinc-300">{facts.join(" ・ ")}</p>
          {movie.genres.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1" aria-label="ジャンル">
              {movie.genres.map((genre) => (
                <li
                  key={genre}
                  className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300"
                >
                  {genre}
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <div className="mt-5">
        <MyRecord
          // 登録の状態が変わったら、入力欄の内容を作り直す。
          key={`${record?.status ?? "none"}:${record?.preferredMedium ?? "none"}`}
          record={record}
          today={today}
          suggestions={suggestions}
          actionData={actionData as ActionResult | undefined}
        />
      </div>

      {movie.trailer && (
        <section className="mt-6" aria-labelledby="trailer-title">
          <h2 id="trailer-title" className="section-title mb-2">
            予告
          </h2>
          <TrailerPlayer
            // 別の映画に移ったら、再生の状態を元に戻す。
            key={movie.trailer.key}
            trailer={movie.trailer}
            backdropPath={movie.backdropPath}
            title={movie.title}
          />
        </section>
      )}

      {movie.overview && (
        <section className="mt-6" aria-labelledby="overview-title">
          <h2 id="overview-title" className="section-title">
            あらすじ
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
            {movie.overview}
          </p>
        </section>
      )}

      <div className="mt-6">
        <WatchProvidersSection providers={movie.providers} />
      </div>

      {(movie.directors.length > 0 || movie.cast.length > 0) && (
        <section className="mt-6" aria-labelledby="credits-title">
          <h2 id="credits-title" className="section-title">
            スタッフ・キャスト
          </h2>
          <dl className="mt-2 space-y-1 text-sm">
            {movie.directors.length > 0 && (
              <div className="flex gap-2">
                <dt className="w-12 shrink-0 text-muted">監督</dt>
                <dd>{movie.directors.join("、")}</dd>
              </div>
            )}
            {movie.cast.length > 0 && (
              <div className="flex gap-2">
                <dt className="w-12 shrink-0 text-muted">出演</dt>
                <dd>{movie.cast.join("、")}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <p className="mt-8 text-[11px] text-muted">
        映画の情報は TMDb から取得しています。{" "}
        <Link to="/about" className="underline">
          クレジット
        </Link>
      </p>
    </article>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const known =
    isRouteErrorResponse(error) && typeof error.data === "string" ? error.data : null;
  return (
    <div className="py-12 text-center">
      <h1 className="text-lg font-bold">{known ?? "エラーが発生しました"}</h1>
      <p className="mt-6">
        <Link to="/search" className="btn">
          映画を探す
        </Link>
      </p>
    </div>
  );
}
