import { Link, redirect } from "react-router";

import { getSessionUser } from "~/lib/auth/session.server";
import { SITE_NAME } from "~/lib/site";

import type { Route } from "./+types/login";

export function meta() {
  return [{ title: `ログイン | ${SITE_NAME}` }];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getSessionUser(request)) {
    throw redirect("/");
  }
  return null;
}

export default function Login() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="text-center text-2xl font-bold">🎬 {SITE_NAME}</h1>
      <p className="mt-3 text-center text-sm text-muted">
        見たいと思った映画を忘れず、見るまで・見た後まで管理する映画リスト
      </p>

      {/* Google の画面へ移動するので、画面内の遷移ではなく通常のリンクにする。 */}
      <a href="/auth/google" className="btn btn-primary mt-8 w-full">
        Google でログイン
      </a>
      <p className="mt-3 text-center text-xs text-muted">
        このアプリは現在、作者だけが利用できます。
      </p>

      {/* 開発用ログインは、開発サーバーでだけ案内する。import.meta.env.DEV はビルド時に
          定数に置き換わるので、本番のビルドにはこのリンクの文字列ごと含まれない。 */}
      {import.meta.env.DEV && (
        <a href="/auth/dev-login" className="btn mt-6 w-full">
          開発用ログイン（開発サーバーのみ）
        </a>
      )}

      <p className="mt-10 text-center text-xs">
        <Link to="/about" className="text-muted underline">
          クレジット
        </Link>
      </p>
    </main>
  );
}
