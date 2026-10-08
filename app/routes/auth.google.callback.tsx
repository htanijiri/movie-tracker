import { data, Link, redirect } from "react-router";

import { isAllowedEmail } from "~/lib/auth/allowlist.server";
import { exchangeCode } from "~/lib/auth/google.server";
import {
  clearOAuthStateCookie,
  createSessionCookie,
  readOAuthStateCookie,
} from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { findOrCreateUser } from "~/lib/db/users.server";
import { SITE_NAME } from "~/lib/site";

import type { Route } from "./+types/auth.google.callback";

export function meta() {
  return [{ title: `ログイン | ${SITE_NAME}` }];
}

// Google から戻ってきたところ。照合 → トークンの交換 → 許可リストの確認 → セッションの発行。
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = await readOAuthStateCookie(request);
  const clearCookie = await clearOAuthStateCookie(request);

  if (!code || !state || !saved || saved.state !== state) {
    throw data("ログインの手続きを確認できませんでした。もう一度ログインしてください。", {
      status: 400,
      headers: { "Set-Cookie": clearCookie },
    });
  }

  let profile;
  try {
    profile = await exchangeCode(request, code, saved.codeVerifier);
  } catch (error) {
    console.error("Google ログインに失敗しました:", error, (error as { cause?: unknown })?.cause);
    throw data("Google でのログインに失敗しました。もう一度ログインしてください。", {
      status: 400,
      headers: { "Set-Cookie": clearCookie },
    });
  }

  if (!profile.emailVerified || !isAllowedEmail(profile.email)) {
    // 許可していないアカウント。利用者の行もセッションも作らない。
    return data(
      { denied: true as const },
      { status: 403, headers: { "Set-Cookie": clearCookie } },
    );
  }

  const user = await findOrCreateUser(getDb(), profile);
  const headers = new Headers();
  headers.append("Set-Cookie", clearCookie);
  headers.append(
    "Set-Cookie",
    await createSessionCookie(request, {
      id: user.id,
      email: user.email,
      name: user.name,
    }),
  );
  return redirect("/", { headers });
}

export default function GoogleCallback() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="text-xl font-bold">このアプリは現在、作者だけが利用できます</h1>
      <p className="mt-3 text-sm text-muted">
        ログインに使った Google アカウントは、利用を許可されていません。
      </p>
      <p className="mt-6">
        <Link to="/login" className="btn">
          ログイン画面へ戻る
        </Link>
      </p>
    </main>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message =
    typeof (error as { data?: unknown })?.data === "string"
      ? (error as { data: string }).data
      : "ログインに失敗しました。もう一度ログインしてください。";
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="text-xl font-bold">ログインできませんでした</h1>
      <p className="mt-3 text-sm text-muted">{message}</p>
      <p className="mt-6">
        <Link to="/login" className="btn">
          ログイン画面へ戻る
        </Link>
      </p>
    </main>
  );
}
