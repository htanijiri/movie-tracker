import { createContext, type RouterContextProvider } from "react-router";

// ログイン中の利用者。ログイン必須のレイアウト（routes/app-layout.tsx）のミドルウェアが設定する。
export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
};

export const userContext = createContext<SessionUser | null>(null);

/**
 * loader / action の先頭で呼び、ログイン中の利用者を取り出す。
 * ログイン必須のレイアウトの外にルートを置いてしまった場合でも、ここで止まる。
 */
export function requireUser(
  context: Readonly<RouterContextProvider>,
): SessionUser {
  const user = context.get(userContext);
  if (!user) {
    throw new Response("ログインが必要です", { status: 401 });
  }
  return user;
}
