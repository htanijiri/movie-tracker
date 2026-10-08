import { Link } from "react-router";

import { EmptyState, MovieCard } from "~/components/MovieCard";
import { requireUser } from "~/context";
import { runInBackground } from "~/lib/background.server";
import { todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { refreshStaleSnapshots } from "~/lib/db/movies.server";
import { listByFilter } from "~/lib/db/user-movies.server";
import { LIST_FILTER_LABELS, LIST_FILTERS, type ListFilter } from "~/lib/list";
import { SITE_NAME } from "~/lib/site";

import type { Route } from "./+types/list";

export function meta() {
  return [{ title: `リスト | ${SITE_NAME}` }];
}

// 登録したすべての映画の一覧。保存済みの内容だけで表示する（TMDb を呼ばない）。
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context);
  const param = new URL(request.url).searchParams.get("filter");
  // 不正な値は「すべて」として扱う。
  const filter: ListFilter = (LIST_FILTERS as readonly string[]).includes(param ?? "")
    ? (param as ListFilter)
    : "all";
  const items = await listByFilter(getDb(), user.id, filter);
  // 古くなった映画の情報を、応答を返したあとに少しずつ取り直す（画面の表示は待たせない）。
  runInBackground(refreshStaleSnapshots(getDb()));
  return { filter, items, today: todayInTokyo() };
}

export default function List({ loaderData }: Route.ComponentProps) {
  const { filter, items, today } = loaderData;
  return (
    <div>
      <h1 className="text-xl font-bold">リスト</h1>

      <div
        role="tablist"
        aria-label="絞り込み"
        className="mt-3 flex gap-1 rounded-xl bg-zinc-900 p-1"
      >
        {LIST_FILTERS.map((key) => (
          <Link
            key={key}
            to={key === "all" ? "/list" : `/list?filter=${key}`}
            role="tab"
            aria-selected={filter === key}
            className={`flex min-h-10 flex-1 items-center justify-center whitespace-nowrap rounded-lg px-1 text-xs font-medium ${
              filter === key ? "bg-zinc-700 text-zinc-50" : "text-zinc-400"
            }`}
          >
            {LIST_FILTER_LABELS[key]}
          </Link>
        ))}
      </div>

      <p className="mt-3 text-xs text-muted" data-count>
        {items.length}本
      </p>

      {items.length === 0 ? (
        <div className="mt-2">
          <EmptyState />
        </div>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li key={item.tmdbId}>
              <MovieCard item={item} today={today} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
