import { describe, expect, it } from "vitest";

import routes from "~/routes";
import * as appLayout from "~/routes/app-layout";
import { requireUserMiddleware } from "~/lib/auth/middleware.server";

// ルートの構成そのものを確かめる。ログインなしで開けるルートが、意図せず増えていないこと。
describe("ルートの構成", () => {
  const top = routes as Array<{ file: string; path?: string; children?: unknown[] }>;
  const layout = top.find((r) => r.file === "routes/app-layout.tsx");
  const publicPaths = top.filter((r) => r !== layout).map((r) => r.path).sort();

  it("ログインなしで開けるのは、クレジット・ログイン関連のルートだけ", () => {
    expect(publicPaths).toEqual(
      [
        "about",
        "auth/dev-login", // 開発サーバー（とテスト）でだけ登録される
        "auth/google",
        "auth/google/callback",
        "login",
        "logout",
      ].sort(),
    );
  });

  it("それ以外のルートは、ログイン必須のレイアウトの下にある", () => {
    expect(layout).toBeDefined();
    expect(layout!.children!.length).toBeGreaterThan(0);
  });

  it("ログイン必須のレイアウトには、ログインを確認するミドルウェアが付いている", () => {
    expect(appLayout.middleware).toContain(requireUserMiddleware);
    // loader があることで、画面を切り替えるたびにサーバーで確認が行われる。
    expect(typeof appLayout.loader).toBe("function");
  });
});
