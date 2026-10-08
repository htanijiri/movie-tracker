import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

type RenderOptions = {
  /** ルートのパスの定義（例：`/movies/:tmdbId`）。 */
  path?: string;
  /** 実際に開く URL（例：`/movies/123`）。省略時は path と同じ。 */
  url?: string;
  loaderData?: unknown;
  actionData?: unknown;
};

/**
 * 画面のコンポーネントを、loader の戻り値を渡した状態で HTML 文字列にする。
 * ブラウザを使わずに、表示される文言や属性を確かめるために使う。
 */
export function renderRoute(
  // ルートのコンポーネントは、生成された型（Route.ComponentProps）を受け取る。
  // テストでは matches などが実物と揃わないので、props の型は問わない。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: ComponentType<any>,
  { path = "/", url, loaderData, actionData }: RenderOptions = {},
): string {
  const Stub = createRoutesStub([{ id: "test", path, Component }]);
  return renderToString(
    <Stub
      initialEntries={[url ?? path]}
      hydrationData={{
        loaderData: { test: loaderData ?? null },
        actionData: actionData === undefined ? null : { test: actionData },
      }}
    />,
  );
}
