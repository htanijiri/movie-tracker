import { redirect } from "react-router";

import { destroySessionCookie } from "~/lib/auth/session.server";

import type { Route } from "./+types/logout";

export async function action({ request }: Route.ActionArgs) {
  return redirect("/login", {
    headers: { "Set-Cookie": await destroySessionCookie(request) },
  });
}

// アドレスを直接開いた場合は、何もせずトップページへ戻す。
export function loader() {
  return redirect("/");
}
