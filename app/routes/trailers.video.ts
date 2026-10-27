import { data } from "react-router";

import { requireUser } from "~/context";
import { getTrailer, TmdbError } from "~/lib/tmdb/client.server";
import { parseTmdbId } from "~/lib/validation";

import type { Route } from "./+types/trailers.video";

// 予告探しの「予告を見る」で使う、予告動画の取得（仕様書 013）。画面のないルート（JSON を返す）。
export async function loader({ params, context }: Route.LoaderArgs) {
  requireUser(context);
  const tmdbId = parseTmdbId(params.id);
  if (tmdbId === null) throw data({ trailer: null, error: "not-found" }, { status: 404 });
  try {
    return { trailer: await getTrailer(tmdbId), error: null };
  } catch (error) {
    if (!(error instanceof TmdbError)) throw error;
    return { trailer: null, error: "tmdb" as const };
  }
}
