import { Form, Link, NavLink, Outlet } from "react-router";

import { requireUser } from "~/context";
import { requireUserMiddleware } from "~/lib/auth/middleware.server";
import { SITE_NAME } from "~/lib/site";

import type { Route } from "./+types/app-layout";

// このレイアウトの下にあるルートは、すべてログインが必要になる。
export const middleware: Route.MiddlewareFunction[] = [requireUserMiddleware];

// loader を置くことで、画面を切り替えるたびにサーバーでログインの確認が行われる。
export function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context);
  return { user: { name: user.name, email: user.email } };
}

const NAV_ITEMS = [
  { to: "/", label: "ホーム", emoji: "🏠", end: true },
  { to: "/search", label: "探す", emoji: "🔍", end: false },
  { to: "/list", label: "リスト", emoji: "📋", end: false },
] as const;

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <Link to="/" className="text-base font-bold">
          🎬 {SITE_NAME}
        </Link>
        <details className="relative">
          <summary
            className="btn btn-quiet min-h-9 cursor-pointer list-none px-3 py-1"
            aria-label="メニュー"
          >
            ☰
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
            <p className="truncate px-2 py-1 text-xs text-muted">
              {user.name ?? user.email}
            </p>
            <Link to="/about" className="btn btn-quiet w-full justify-start">
              クレジット
            </Link>
            <Form method="post" action="/logout">
              <button type="submit" className="btn btn-quiet w-full justify-start">
                ログアウト
              </button>
            </Form>
          </div>
        </details>
      </header>

      <main className="flex-1 px-4 pb-24">
        <Outlet />
      </main>

      <nav
        aria-label="メインメニュー"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <ul className="mx-auto flex max-w-xl">
          {NAV_ITEMS.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs ${
                    isActive ? "font-bold text-amber-400" : "text-zinc-400"
                  }`
                }
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  {item.emoji}
                </span>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
