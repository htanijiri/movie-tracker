import {
  decodeIdToken,
  generateCodeVerifier,
  generateState,
  Google,
} from "arctic";

import { getSecret } from "~/lib/env.server";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

function googleClient(request: Request): Google {
  // リダイレクト先は、アクセスされた URL の origin から組み立てる
  // （手元は http://localhost:5183、本番は公開 URL）。Google 側に登録した URI と一致させること。
  const redirectUri = `${new URL(request.url).origin}/auth/google/callback`;
  return new Google(
    getSecret("GOOGLE_CLIENT_ID"),
    getSecret("GOOGLE_CLIENT_SECRET"),
    redirectUri,
  );
}

/** Google のログイン画面の URL と、戻ってきたときの照合に使う値を作る。 */
export function createAuthorization(request: Request) {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = googleClient(request).createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "profile",
  ]);
  return { url, state, codeVerifier };
}

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export class InvalidIdTokenError extends Error {}

/**
 * 認可コードをトークンに交換し、ID トークンの中身を検証して返す。
 * ID トークンは Google のトークンエンドポイントから TLS で直接受け取るので、
 * 署名の検証は省略し、発行者・宛先・有効期限のクレームを検証する。
 */
export async function exchangeCode(
  request: Request,
  code: string,
  codeVerifier: string,
  now: Date = new Date(),
): Promise<GoogleProfile> {
  const tokens = await googleClient(request).validateAuthorizationCode(
    code,
    codeVerifier,
  );
  const claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;

  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new InvalidIdTokenError("ID トークンの発行者が Google ではありません");
  }
  if (claims.aud !== getSecret("GOOGLE_CLIENT_ID")) {
    throw new InvalidIdTokenError("ID トークンの宛先がこのアプリではありません");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) {
    throw new InvalidIdTokenError("ID トークンの有効期限が切れています");
  }
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new InvalidIdTokenError("ID トークンに必要な項目がありません");
  }

  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
  };
}
