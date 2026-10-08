import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { sameOriginMiddleware } from "./lib/auth/middleware.server";

// すべてのリクエストに適用する（別のサイトからの書き込みを拒否する）。
export const middleware: Route.MiddlewareFunction[] = [sameOriginMiddleware];

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export function meta() {
  return [
    { title: "movie-tracker" },
    {
      name: "description",
      content: "見たいと思った映画を忘れず、見るまで・見た後まで管理する映画リスト",
    },
    // 個人用のアプリなので、検索エンジンには載せない。
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#09090b" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "エラーが発生しました";
  let details = "時間をおいて、もう一度試してください。";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "ページが見つかりませんでした";
      details = "URL が間違っているか、ページが移動した可能性があります。";
    } else if (error.status === 403) {
      title = "この操作は許可されていません";
      details = "ページを開き直して、もう一度試してください。";
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mt-2 text-muted">{details}</p>
      <p className="mt-6">
        <Link to="/" className="btn">
          トップページへ
        </Link>
      </p>
      {stack && (
        <pre className="mt-6 w-full overflow-x-auto rounded-lg bg-zinc-900 p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
