import { Link } from "react-router";

import { formatYmd } from "~/lib/date";
import type { ListItem } from "~/lib/db/user-movies.server";
import { formatDiscovery, formatStars } from "~/lib/format";
import { stateKeyOf, WATCHED_MEDIUM_BADGES } from "~/lib/labels";
import { releaseStatus, type ReleaseStatus } from "~/lib/release";

import { Poster } from "./Poster";
import { StateBadge } from "./StateBadge";

/** 公開日についての表示（「公開3週目」「来週公開（10/30）」など）。仕様書 010・011。 */
export function ReleaseLabel({ status }: { status: ReleaseStatus }) {
  return (
    <span
      data-release
      data-release-warning={status.warning ? "true" : undefined}
      className={
        status.warning
          ? "rounded bg-red-950 px-1.5 py-0.5 text-xs font-bold text-red-300"
          : "text-xs text-zinc-300"
      }
    >
      {status.label}
    </span>
  );
}

/** サービス名を3つまで並べ、超えたら「ほか」を付ける。 */
export function formatProviderNames(names: string[]): string {
  const shown = names.slice(0, 3).join("、");
  return names.length > 3 ? `${shown} ほか` : shown;
}

/**
 * 一覧用のカード（横型）。左にポスター、右に「映画の情報」と「自分の情報」を並べる。
 * 押すと映画詳細に進む。
 */
export function MovieCard({ item, today }: { item: ListItem; today: string }) {
  const state = stateKeyOf(item);
  const discovery = formatDiscovery(item);
  const stars = formatStars(item.rating);
  // どこで見たか（劇場、サブスクなど）はラベルで出すので、この行は見た日と場所だけにする。
  const watchedLine = [formatYmd(item.watchedAt), item.watchedPlace ?? ""]
    .filter(Boolean)
    .join(" ・ ");
  // 「サブスク待ち」「劇場で見たい」の映画が、いま見放題・無料で見られるか（仕様書 009）。
  const streamingNow =
    (state === "theater" || state === "streaming") && item.streamingProviders?.length
      ? formatProviderNames(item.streamingProviders.map((p) => p.name))
      : null;
  const mediumBadge =
    state === "watched" && item.watchedMedium
      ? WATCHED_MEDIUM_BADGES[item.watchedMedium]
      : null;

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
          {mediumBadge && (
            <span
              data-watched-medium={item.watchedMedium}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-600 px-2 py-0.5 text-[11px] font-bold leading-tight text-zinc-200"
            >
              <span aria-hidden="true">{mediumBadge.emoji}</span>
              {mediumBadge.label}
            </span>
          )}
          {state === "theater" && (
            <ReleaseLabel status={releaseStatus(item.releaseDate, today)} />
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
        {streamingNow && (
          <p className="mt-1 text-xs font-bold text-sky-300" data-streaming-now>
            <span aria-hidden="true">📺</span> 配信中：{streamingNow}
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
