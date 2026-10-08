import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { userContext } from "~/context";
import {
  requireUserMiddleware,
  sameOriginMiddleware,
} from "~/lib/auth/middleware.server";
import {
  createOAuthStateCookie,
  getSessionUser,
} from "~/lib/auth/session.server";
import { loader as callbackLoader } from "~/routes/auth.google.callback";
import { loader as googleLoader } from "~/routes/auth.google";
import { action as logoutAction } from "~/routes/logout";

import {
  catchThrown,
  contextFor,
  createUser,
  formRequest,
  mockFetch,
  ORIGIN,
  routeArgs,
  sessionCookieFor,
  statusOf,
} from "../helpers/app";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

// 日本語の名前を含むので、UTF-8 のバイト列にしてから Base64URL にする。
const b64url = (value: object) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/** Google が返す ID トークンの形をした文字列を作る（署名はダミー）。 */
function idToken(claims: Record<string, unknown> = {}): string {
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-sub-1",
    email: "owner@example.com",
    email_verified: true,
    name: "テスト利用者",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  };
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

/** Google のトークンエンドポイントを、決めた ID トークンを返すように差し替える。 */
function mockGoogleToken(claims: Record<string, unknown> = {}) {
  return mockFetch((url) => {
    expect(url.href).toBe("https://oauth2.googleapis.com/token");
    return Response.json({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken(claims),
    });
  });
}

/** Google から戻ってきたときのリクエストを作る。 */
async function callbackRequest(state = "state-1", savedState = "state-1") {
  const base = new Request(`${ORIGIN}/auth/google/callback`);
  const cookie = (
    await createOAuthStateCookie(base, { state: savedState, codeVerifier: "verifier-1" })
  ).split(";")[0];
  return new Request(`${ORIGIN}/auth/google/callback?code=code-1&state=${state}`, {
    headers: { Cookie: cookie },
  });
}

const countUsers = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n;

const setCookies = (response: Response) => response.headers.getSetCookie();
const sessionSetCookie = (response: Response) =>
  setCookies(response).find((c) => c.startsWith("__session="));

describe("ログイン必須のミドルウェア", () => {
  const run = (request: Request, context = contextFor(null)) =>
    requireUserMiddleware({ request, context, params: {} } as never, (async () =>
      new Response()) as never);

  it("未ログインなら /login へリダイレクトする（AC1）", async () => {
    for (const path of ["/", "/search", "/list", "/movies/1"]) {
      const thrown = await catchThrown(() => run(new Request(`${ORIGIN}${path}`)));
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("Location")).toBe("/login");
    }
  });

  it("ログイン済みなら、利用者を context に入れて通す", async () => {
    const user = await createUser();
    const context = contextFor(null);
    await run(
      new Request(`${ORIGIN}/`, { headers: { Cookie: await sessionCookieFor(user) } }),
      context,
    );
    expect(context.get(userContext)).toEqual(user);
  });

  it("署名を改ざんした Cookie は、未ログインとして扱う（AC7）", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user);
    const tampered = cookie.slice(0, -3) + (cookie.endsWith("abc") ? "xyz" : "abc");
    const request = new Request(`${ORIGIN}/`, { headers: { Cookie: tampered } });
    expect(await getSessionUser(request)).toBeNull();
    expect(statusOf(await catchThrown(() => run(request)))).toBe(302);
  });

  it("許可リストにないメールアドレスのセッションは、未ログインとして扱う", async () => {
    const outsider = await createUser({ email: "someone-else@example.com" });
    const request = new Request(`${ORIGIN}/`, {
      headers: { Cookie: await sessionCookieFor(outsider) },
    });
    expect(await getSessionUser(request)).toBeNull();
  });
});

describe("Google のログイン画面へ送る（/auth/google）", () => {
  it("必要なパラメータを付けてリダイレクトし、照合用の値を HttpOnly の Cookie に保存する（AC2）", async () => {
    const response: Response = await googleLoader(
      routeArgs({ url: `${ORIGIN}/auth/google` }),
    );
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/auth/google/callback`,
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const cookie = setCookies(response).find((c) => c.startsWith("__oauth="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    // state と code_verifier の生の値は URL には出さない（code_verifier は Cookie の中だけ）。
    expect(location.searchParams.has("code_verifier")).toBe(false);
  });
});

describe("Google から戻ってきたとき（/auth/google/callback）", () => {
  it("state が Cookie と一致しなければ 400 で、セッションを作らない（AC3）", async () => {
    const fetchMock = mockGoogleToken();
    const thrown = await catchThrown(async () =>
      callbackLoader(routeArgs({ request: await callbackRequest("state-X", "state-1") })),
    );
    expect(statusOf(thrown)).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await countUsers()).toBe(0);
  });

  it("照合用の Cookie がなければ 400", async () => {
    mockGoogleToken();
    const request = new Request(`${ORIGIN}/auth/google/callback?code=c&state=s`);
    const thrown = await catchThrown(() => callbackLoader(routeArgs({ request })));
    expect(statusOf(thrown)).toBe(400);
  });

  it("許可されたアカウントなら、利用者を作成し、セッションを発行して / へ送る（AC4、AC7）", async () => {
    const fetchMock = mockGoogleToken();
    const response = (await callbackLoader(
      routeArgs({ request: await callbackRequest() }),
    )) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const row = await env.DB.prepare("SELECT * FROM users").first<Record<string, string>>();
    expect(row).toMatchObject({
      google_sub: "google-sub-1",
      email: "owner@example.com",
      name: "テスト利用者",
    });

    const cookie = sessionSetCookie(response)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/i);
    expect(cookie).toMatch(/Secure/i);

    // 発行された Cookie で、ログイン済みとして扱われる。
    const next = new Request(`${ORIGIN}/`, { headers: { Cookie: cookie.split(";")[0] } });
    expect(await getSessionUser(next)).toMatchObject({ id: row!.id, email: "owner@example.com" });
  });

  it("トークンの交換には、認可コードと code_verifier を送る", async () => {
    let body = new URLSearchParams();
    mockFetch(async (_url, request) => {
      body = new URLSearchParams(await request.text());
      return Response.json({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken(),
      });
    });
    await callbackLoader(routeArgs({ request: await callbackRequest() }));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
  });

  it("2回目以降のログインでは、同じ利用者の行を使う（AC4）", async () => {
    mockGoogleToken();
    await callbackLoader(routeArgs({ request: await callbackRequest() }));
    mockGoogleToken();
    await callbackLoader(routeArgs({ request: await callbackRequest() }));
    expect(await countUsers()).toBe(1);
  });

  it("HTTP でアクセスしたとき（手元の開発サーバー）は、Cookie に Secure を付けない", async () => {
    mockGoogleToken();
    const base = new Request("http://localhost:5183/auth/google/callback");
    const cookie = (
      await createOAuthStateCookie(base, { state: "s", codeVerifier: "v" })
    ).split(";")[0];
    const response = (await callbackLoader(
      routeArgs({
        request: new Request("http://localhost:5183/auth/google/callback?code=c&state=s", {
          headers: { Cookie: cookie },
        }),
      }),
    )) as Response;
    expect(sessionSetCookie(response)).not.toMatch(/Secure/i);
  });

  it.each([
    ["許可リストにないメールアドレス", { email: "someone-else@example.com" }],
    ["メールアドレスが未確認", { email_verified: false }],
  ])("%s なら 403 で、利用者もセッションも作らない（AC5）", async (_label, claims) => {
    mockGoogleToken(claims);
    const result = await callbackLoader(routeArgs({ request: await callbackRequest() }));
    expect(result).not.toBeInstanceOf(Response);
    expect(statusOf(result)).toBe(403);
    expect((result as { data: unknown }).data).toEqual({ denied: true });
    expect(await countUsers()).toBe(0);
    const headers = new Headers((result as { init: ResponseInit }).init.headers);
    expect(headers.getSetCookie().some((c) => c.startsWith("__session="))).toBe(false);
  });

  it.each([
    ["宛先（aud）がこのアプリではない", { aud: "another-app.apps.googleusercontent.com" }],
    ["発行者（iss）が Google ではない", { iss: "https://evil.example" }],
    ["有効期限が切れている", { exp: Math.floor(Date.now() / 1000) - 10 }],
  ])("ID トークンの %s 場合は拒否する（AC6）", async (_label, claims) => {
    mockGoogleToken(claims);
    const thrown = await catchThrown(async () =>
      callbackLoader(routeArgs({ request: await callbackRequest() })),
    );
    expect(statusOf(thrown)).toBe(400);
    expect(await countUsers()).toBe(0);
  });

  it("Google がエラーを返した場合は 400 で、セッションを作らない", async () => {
    mockFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const thrown = await catchThrown(async () =>
      callbackLoader(routeArgs({ request: await callbackRequest() })),
    );
    expect(statusOf(thrown)).toBe(400);
    expect(await countUsers()).toBe(0);
  });
});

describe("ログアウト（POST /logout）", () => {
  it("セッション Cookie を消し、/login へ送る（AC8）", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user);
    const response: Response = await logoutAction(
      routeArgs({ request: formRequest("/logout", {}, { cookie }) }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");

    const cleared = sessionSetCookie(response)!;
    const next = new Request(`${ORIGIN}/`, { headers: { Cookie: cleared.split(";")[0] } });
    expect(await getSessionUser(next)).toBeNull();
  });
});

describe("別のサイトからの書き込みの拒否", () => {
  const run = (request: Request) =>
    sameOriginMiddleware({ request, context: contextFor(null), params: {} } as never, (async () =>
      new Response()) as never);

  it("Origin が自サイトと異なる POST は 403（AC9）", async () => {
    const thrown = await catchThrown(() =>
      run(formRequest("/logout", {}, { origin: "https://evil.example" })),
    );
    expect(statusOf(thrown)).toBe(403);
  });

  it("Origin のない POST は 403", async () => {
    const thrown = await catchThrown(() => run(formRequest("/logout", {}, { origin: null })));
    expect(statusOf(thrown)).toBe(403);
  });

  it("自サイトからの POST と、GET は通す", async () => {
    await expect(run(formRequest("/logout", {}))).resolves.toBeUndefined();
    await expect(run(new Request(`${ORIGIN}/`))).resolves.toBeUndefined();
  });
});
