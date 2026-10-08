import { describe, expect, it } from "vitest";

// workers/app.ts は、応答のヘッダーを写してからセキュリティ用のヘッダーを足している。
// ログインのときは Set-Cookie が2つ付くので、写しても2つのまま残ることを確かめておく。
describe("ランタイムの前提", () => {
  it("Headers を写しても、複数の Set-Cookie がまとめられずに残る", () => {
    const original = new Headers();
    original.append("Set-Cookie", "a=1; Path=/");
    original.append("Set-Cookie", "b=2; Path=/");
    const copied = new Headers(original);
    copied.set("X-Frame-Options", "DENY");
    expect(copied.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});
