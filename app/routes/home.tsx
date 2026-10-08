import { Link } from "react-router";

import { SITE_NAME } from "~/lib/site";

// 仮のトップページ。仕様書 007 で本物に置き換える。
export default function Home() {
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-xl font-bold">{SITE_NAME}</h1>
      <p className="mt-4">
        <Link to="/about" className="underline">
          クレジット
        </Link>
      </p>
    </main>
  );
}
