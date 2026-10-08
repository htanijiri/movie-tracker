import { Link } from "react-router";

import { formatMonthDay, formatYmd } from "~/lib/date";
import type { ListItem } from "~/lib/db/user-movies.server";
import { formatDiscovery, formatStars } from "~/lib/format";
import { stateKeyOf, WATCHED_MEDIUM_LABELS } from "~/lib/labels";

import { Poster } from "./Poster";
import { StateBadge } from "./StateBadge";

/** 劇場で見たい映画に付ける、公開日の説明。 */
export function releaseLabel(releaseDate: string | null, today: string): string {
  if (!releaseDate) return "公開日未定";
  if (releaseDate > today) return `${formatMonthDay(releaseDate)}公開`;
  return `${formatYmd(releaseDate)} 公開`;
}

/**
 * 一覧用のカード（横型）。左にポスター、右に「映画の情報」と「自分の情報」を並べる。
 * 押すと映画詳細に進む。
 */
export function MovieCard({ item, today }: { item: ListItem; today: string }) {
  const state = stateKeyOf(item);
  const discovery = formatDiscovery(item);
  const stars = formatStars(item.rating);
  const watchedLine = [
    formatYmd(item.watchedAt),
    item.watchedPlace || (item.watchedMedium ? WATCHED_MEDIUM_LABELS[item.watchedMedium] : ""),
  ]
    .filter(Boolean)
    .join(" ・ ");

  return (
    <Link
      to={`/movies/${item.tmdbId}`}
      className="flex gap-3 rounded-xl p-2 hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-amber-400"
      data-card={item.tmdbId}
    >
      <div className="w-16 shrink-0">
        <Poster path={item.posterPath} title={item.title} size="w185" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-bold leading-snug">{item.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <StateBadge state={state} />
          {state === "theater" && (
            <span className="text-xs text-zinc-300" data-release>
              {releaseLabel(item.releaseDate, today)}
            </span>
          )}
        </p>
        {state === "watched" && (
          <p className="mt-1 text-xs text-zinc-300" data-watched-line>
            {watchedLine}
            {stars && (
              <span className="ml-2 text-amber-400" aria-label={`★${item.rating}`}>
                {stars}
              </span>
            )}
          </p>
        )}
        {discovery && (
          <p className="mt-1 line-clamp-2 text-xs text-muted" data-discovery-line>
            {discovery}
          </p>
        )}
      </div>
    </Link>
  );
}

/** 何も登録していない区分に出す案内。 */
export function EmptyState({ children }: { children?: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-zinc-800 px-3 py-4 text-center text-sm text-muted">
      {children ?? "まだありません。"}{" "}
      <Link to="/search" className="text-amber-400 underline">
        映画を探す
      </Link>
    </p>
  );
}
