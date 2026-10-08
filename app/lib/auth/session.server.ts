import { createCookie, createCookieSessionStorage } from "react-router";

import type { SessionUser } from "~/context";
import { getSecret } from "~/lib/env.server";

import { isAllowedEmail } from "./allowlist.server";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30日
const OAUTH_MAX_AGE = 60 * 10; // 10分

type SessionData = { user: SessionUser };

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

// セッションは署名付きの Cookie に持つ（DB には保存しない）。
function sessionStorage(request: Request) {
  return createCookieSessionStorage<SessionData>({
    cookie: {
      name: "__session",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
      secure: isSecure(request),
      secrets: [getSecret("SESSION_SECRET")],
    },
  });
}

/**
 * Cookie からログイン中の利用者を取り出す。未ログイン、署名が不正、または
 * 許可リストから外れたメールアドレスの場合は null。
 */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const session = await sessionStorage(request).getSession(
    request.headers.get("Cookie"),
  );
  const user = session.get("user");
  if (
    !user ||
    typeof user.id !== "string" ||
    typeof user.email !== "string"
  ) {
    return null;
  }
  // 許可リストから外したら、発行済みのセッションもすぐに使えなくする。
  if (!isAllowedEmail(user.email)) return null;
  return { id: user.id, email: user.email, name: user.name ?? null };
}

/** ログイン用の Set-Cookie ヘッダーの値を作る。 */
export async function createSessionCookie(
  request: Request,
  user: SessionUser,
): Promise<string> {
  const storage = sessionStorage(request);
  const session = await storage.getSession();
  session.set("user", user);
  return storage.commitSession(session);
}

/** ログアウト用の Set-Cookie ヘッダーの値を作る。 */
export async function destroySessionCookie(request: Request): Promise<string> {
  const storage = sessionStorage(request);
  const session = await storage.getSession(request.headers.get("Cookie"));
  return storage.destroySession(session);
}

// Google へ行って戻ってくるまでの間だけ使う、state と code_verifier の置き場。
type OAuthState = { state: string; codeVerifier: string };

function oauthCookie(request: Request) {
  return createCookie("__oauth", {
    httpOnly: true,
    sameSite: "lax",
    path: "/auth",
    maxAge: OAUTH_MAX_AGE,
    secure: isSecure(request),
    secrets: [getSecret("SESSION_SECRET")],
  });
}

export async function createOAuthStateCookie(
  request: Request,
  value: OAuthState,
): Promise<string> {
  return oauthCookie(request).serialize(value);
}

export async function readOAuthStateCookie(
  request: Request,
): Promise<OAuthState | null> {
  const value: unknown = await oauthCookie(request).parse(
    request.headers.get("Cookie"),
  );
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OAuthState).state === "string" &&
    typeof (value as OAuthState).codeVerifier === "string"
  ) {
    return value as OAuthState;
  }
  return null;
}

export async function clearOAuthStateCookie(request: Request): Promise<string> {
  return oauthCookie(request).serialize("", { maxAge: 0 });
}
