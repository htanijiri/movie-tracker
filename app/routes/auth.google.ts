import { data, redirect } from "react-router";

import { createAuthorization } from "~/lib/auth/google.server";
import { createOAuthStateCookie } from "~/lib/auth/session.server";
import { hasSecret } from "~/lib/env.server";

import type { Route } from "./+types/auth.google";

// Google のログイン画面へ送る。戻ってきたときに照合する値を、短命の Cookie に入れておく。
export async function loader({ request }: Route.LoaderArgs) {
  if (!hasSecret("GOOGLE_CLIENT_ID") || !hasSecret("GOOGLE_CLIENT_SECRET")) {
    throw data(
      "Google ログインの設定（GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET）がまだ登録されていません。",
      { status: 503 },
    );
  }
  const { url, state, codeVerifier } = createAuthorization(request);
  return redirect(url.toString(), {
    headers: {
      "Set-Cookie": await createOAuthStateCookie(request, { state, codeVerifier }),
    },
  });
}
