import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

// すべての応答に付ける、基本的なセキュリティ用のヘッダー。
const SECURITY_HEADERS: Record<string, string> = {
  // ほかのサイトの枠の中に、このアプリを表示させない。
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  // 外部（TMDb、YouTube など）へ移動するとき、開いていたページの URL を伝えない。
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export default {
  async fetch(request) {
    // 本番では HTTPS だけで応答する（HTTP で来たら HTTPS へ送る）。
    // ブラウザは .dev のドメインを最初から HTTPS で開くが、それ以外の経路でも Cookie を平文で流さないため。
    const url = new URL(request.url);
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol === "http:" && !local) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    const response = await requestHandler(request);
    const headers = new Headers(response.headers);
    if (!local) {
      headers.set("Strict-Transport-Security", "max-age=31536000");
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    // ログイン中の利用者ごとの内容なので、途中の経路やブラウザに保存させない。
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "private, no-store");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
