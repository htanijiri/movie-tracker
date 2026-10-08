import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

// ログインなしで開けるルート。ここに足すときは、公開してよい内容かを必ず確認する。
const publicRoutes = [
  route("about", "routes/about.tsx"),
  route("login", "routes/login.tsx"),
  route("auth/google", "routes/auth.google.ts"),
  route("auth/google/callback", "routes/auth.google.callback.tsx"),
  route("logout", "routes/logout.ts"),
];

// 開発用ログインは、開発サーバーのときだけ登録する（本番のビルドに含めない）。
const devOnlyRoutes = import.meta.env.DEV
  ? [route("auth/dev-login", "routes/auth.dev-login.ts")]
  : [];

export default [
  // ログインが必要なルートは、すべてこのレイアウトの下に置く。
  layout("routes/app-layout.tsx", [index("routes/home.tsx")]),
  ...publicRoutes,
  ...devOnlyRoutes,
] satisfies RouteConfig;
