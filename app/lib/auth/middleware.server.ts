import { redirect, type MiddlewareFunction } from "react-router";

import { userContext } from "~/context";

import { getSessionUser } from "./session.server";

/**
 * ログイン必須のミドルウェア。未ログインならログイン画面へ送る。
 * ログイン必須のレイアウト（routes/app-layout.tsx）に付ける。
 */
export const requireUserMiddleware: MiddlewareFunction<Response> = async ({
  request,
  context,
}) => {
  const user = await getSessionUser(request);
  if (!user) {
    throw redirect("/login");
  }
  context.set(userContext, user);
};

/**
 * 別のサイトから送られた書き込みのリクエストを拒否する（CSRF 対策）。
 * Cookie の SameSite=Lax に加えて、Origin ヘッダーが自サイトと一致することを確かめる。
 * ルート（root.tsx）に付けて、すべてのリクエストに適用する。
 */
export const sameOriginMiddleware: MiddlewareFunction<Response> = async ({
  request,
}) => {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) {
    throw new Response("別のサイトからの操作は受け付けません", { status: 403 });
  }
};
