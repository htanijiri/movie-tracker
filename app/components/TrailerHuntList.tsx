import { Link } from "react-router";

import { formatMonthDay } from "~/lib/date";
import type { TrailerHunt } from "~/lib/trailers.server";

import { Poster } from "./Poster";

/** 「この日の、映画館Xでの「映画A」の上映前」のような、予告探しの説明。 */
export function huntLabel(hunt: Pick<TrailerHunt, "watchedAt" | "watchedPlace" | "title">): string {
  return [formatMonthDay(hunt.watchedAt), hunt.watchedPlace, `「${hunt.title}」の上映前`]
    .filter(Boolean)
    .join(" ");
}

/** トップページの「予告を探す」（探し終わっていないもの。仕様書 013）。 */
export function TrailerHuntList({ hunts }: { hunts: TrailerHunt[] }) {
  if (hunts.length === 0) return null;
  return (
    <section aria-labelledby="hunts-title" className="mt-4" data-section="hunts">
      <h2 id="hunts-title" className="section-title mb-2 flex items-center gap-2">
        <span aria-hidden="true">🎞</span>予告を探す
      </h2>
      <ul className="space-y-2">
        {hunts.map((hunt) => (
          <li key={hunt.tmdbId}>
            <Link
              to={`/trailers/${hunt.tmdbId}`}
              className="flex items-center gap-3 rounded-xl border border-amber-800 bg-amber-950/30 p-2"
              data-hunt={hunt.tmdbId}
            >
              <div className="w-10 shrink-0">
                <Poster path={hunt.posterPath} title={hunt.title} size="w185" />
              </div>
              <p className="min-w-0 flex-1 text-sm leading-snug">
                {huntLabel(hunt)}
                <span className="mt-0.5 block text-xs font-bold text-amber-300">
                  {`気になった予告 ${hunt.trailerCount}本中 あと${hunt.trailerCount - hunt.found}本`}
                </span>
              </p>
              <span aria-hidden="true" className="text-zinc-500">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
