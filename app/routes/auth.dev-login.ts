import { redirect, type LoaderFunctionArgs } from "react-router";

import { DEV_EMAIL, getAllowedEmails } from "~/lib/auth/allowlist.server";
import { createSessionCookie } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { findOrCreateUser } from "~/lib/db/users.server";

// 開発用ログイン。Google の画面を通らずに、開発サーバーでログイン後の画面を確かめるためのもの。
// app/routes.ts で開発サーバーのときだけ登録しており、本番のビルドには含まれない。
// 万一登録されても動かないよう、ここでも確認する。
// （本番の型生成ではこのルートが登録されないので、生成される型ではなく汎用の型を使う。）
export async function loader({ request }: LoaderFunctionArgs) {
  if (!import.meta.env.DEV) {
    throw new Response("Not Found", { status: 404 });
  }
  const email = getAllowedEmails()[0] ?? DEV_EMAIL;
  const user = await findOrCreateUser(getDb(), {
    sub: `dev:${email}`,
    email,
    name: "開発用ユーザー",
  });
  return redirect("/", {
    headers: {
      "Set-Cookie": await createSessionCookie(request, {
        id: user.id,
        email: user.email,
        name: user.name,
      }),
    },
  });
}
