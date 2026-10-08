import { RouterContextProvider } from "react-router";
import { vi } from "vitest";

import { userContext, type SessionUser } from "~/context";
import { createSessionCookie } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { movies, users, type Movie } from "~/lib/db/schema";

export const ORIGIN = "https://movie-tracker.test";

/** テスト用の利用者を DB に作る。 */
export async function createUser(
  overrides: Partial<SessionUser> = {},
): Promise<SessionUser> {
  const user: SessionUser = {
    id: crypto.randomUUID(),
    email: "owner@example.com",
    name: "テスト利用者",
    ...overrides,
  };
  await getDb().insert(users).values({
    id: user.id,
    googleSub: `sub-${user.id}`,
    email: user.email,
    name: user.name,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return user;
}

/** テスト用の映画のスナップショットを DB に作る（架空の作品）。 */
export async function createMovie(overrides: Partial<Movie> = {}): Promise<Movie> {
  const movie: Movie = {
    tmdbId: 1001,
    title: "映画A",
    originalTitle: "Movie A",
    releaseDate: "2026-01-10",
    posterPath: "/poster-a.jpg",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
  await getDb().insert(movies).values(movie);
  return movie;
}

/** ログイン済みの利用者を入れた context を作る（ミドルウェアが済んだあとの状態）。 */
export function contextFor(user: SessionUser | null): RouterContextProvider {
  const context = new RouterContextProvider();
  if (user) context.set(userContext, user);
  return context;
}

/** Cookie ヘッダーに入れる、ログイン済みのセッション Cookie を作る。 */
export async function sessionCookieFor(user: SessionUser): Promise<string> {
  const setCookie = await createSessionCookie(new Request(`${ORIGIN}/`), user);
  return setCookie.split(";")[0];
}

type RouteArgs = {
  request?: Request;
  url?: string;
  params?: Record<string, string>;
  user?: SessionUser | null;
};

/** loader / action を、ルーターを通さずに直接呼ぶ。 */
export function routeArgs({ request, url, params = {}, user = null }: RouteArgs = {}) {
  return {
    request: request ?? new Request(url ?? `${ORIGIN}/`),
    params,
    context: contextFor(user),
    // 生成された型（Route.LoaderArgs）は実物のルート構成に依存するので、テストでは型を問わない。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** フォームの POST リクエストを作る。 */
export function formRequest(
  path: string,
  fields: Record<string, string>,
  init: { cookie?: string; origin?: string | null } = {},
): Request {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

type FetchHandler = (url: URL, request: Request) => Response | Promise<Response>;

/** 外部への通信を、決めた応答に差し替える。呼ばれた内容は戻り値の mock から確認できる。 */
export function mockFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return handler(new URL(request.url), request);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** throw された Response や data() から、ステータスを取り出す。 */
export function statusOf(thrown: unknown): number | undefined {
  if (thrown instanceof Response) return thrown.status;
  const init = (thrown as { init?: ResponseInit | null })?.init;
  return init?.status;
}

/** 関数が throw した値を受け取る。throw しなければテストを失敗させる。 */
export async function catchThrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (thrown) {
    return thrown;
  }
  throw new Error("throw されるはずの処理が、throw せずに終わりました");
}
