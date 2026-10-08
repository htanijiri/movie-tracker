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

export default {
  async fetch(request) {
    const response = await requestHandler(request);
    const headers = new Headers(response.headers);
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
