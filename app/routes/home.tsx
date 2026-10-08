import { Link } from "react-router";

import { EmptyState, MovieCard } from "~/components/MovieCard";
import { requireUser } from "~/context";
import { runInBackground } from "~/lib/background.server";
import { todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { refreshStaleSnapshots } from "~/lib/db/movies.server";
import { listForHome, type ListItem } from "~/lib/db/user-movies.server";
import { SITE_NAME } from "~/lib/site";

import type { Route } from "./+types/home";

export function meta() {
  return [{ title: SITE_NAME }];
}

// トップページ。保存済みの内容だけで表示する（TMDb を呼ばない）。
export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context);
  const lists = await listForHome(getDb(), user.id);
  // 古くなった映画の情報を、応答を返したあとに少しずつ取り直す（画面の表示は待たせない）。
  runInBackground(refreshStaleSnapshots(getDb()));
  return { ...lists, today: todayInTokyo() };
}

function Section({
  id,
  emoji,
  title,
  items,
  today,
  children,
}: {
  id: string;
  emoji: string;
  title: string;
  items: ListItem[];
  today: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="mt-6" aria-labelledby={`${id}-title`} data-section={id}>
      <h2 id={`${id}-title`} className="section-title mb-2 flex items-center gap-2">
        <span aria-hidden="true">{emoji}</span>
        {title}
        {items.length > 0 && (
          <span className="text-xs font-normal text-muted">{items.length}本</span>
        )}
      </h2>
      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.tmdbId}>
              <MovieCard item={item} today={today} />
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { theater, streaming, watched, hasMoreWatched, today } = loaderData;
  return (
    <div>
      <h1 className="text-xl font-bold">次に何を見る？</h1>

      <Section id="theater" emoji="🎬" title="劇場で見たい" items={theater} today={today} />
      <Section id="streaming" emoji="📺" title="サブスク待ち" items={streaming} today={today} />
      <Section id="watched" emoji="✅" title="最近見た" items={watched} today={today}>
        {hasMoreWatched && (
          <p className="mt-2 text-right">
            <Link to="/list?filter=watched" className="text-sm text-amber-400 underline">
              すべて見る
            </Link>
          </p>
        )}
      </Section>
    </div>
  );
}
