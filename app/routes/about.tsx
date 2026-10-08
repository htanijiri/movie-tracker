import { Link } from "react-router";

import {
  JUSTWATCH_URL,
  REPOSITORY_URL,
  SITE_NAME,
  TMDB_LOGO_URL,
  TMDB_NOTICE,
  TMDB_URL,
} from "~/lib/site";

export function meta() {
  return [{ title: `クレジット | ${SITE_NAME}` }];
}

// クレジットのページ。TMDb の利用条件で必要な表示なので、ログインしていなくても見られる。
// このページと、TMDb のロゴ・表記、JustWatch の表記は消さない。
export default function About() {
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <p>
        <Link to="/" className="text-sm text-amber-400 underline">
          ← {SITE_NAME}
        </Link>
      </p>
      <h1 className="mt-4 text-xl font-bold">クレジット</h1>

      <section className="panel mt-6" aria-labelledby="about-app">
        <h2 id="about-app" className="section-title">
          このアプリについて
        </h2>
        <p className="mt-2 text-sm text-zinc-300">
          見たいと思った映画を忘れず、見るまで・見た後まで管理する、個人用の映画リストです。
          非商用で運用しています。
        </p>
      </section>

      <section className="panel mt-4" aria-labelledby="about-tmdb">
        <h2 id="about-tmdb" className="section-title">
          映画の情報
        </h2>
        <a href={TMDB_URL} rel="noreferrer" className="mt-3 inline-block">
          <img
            src={TMDB_LOGO_URL}
            alt="TMDB"
            width={136}
            height={18}
            loading="lazy"
          />
        </a>
        <p className="mt-3 text-sm text-zinc-300" lang="en">
          {TMDB_NOTICE}
        </p>
        <p className="mt-2 text-sm text-muted">
          映画のタイトル、あらすじ、ポスター画像、予告動画の情報は、TMDb の API
          から取得しています。このアプリは TMDb による承認や認定を受けたものではありません。
        </p>
      </section>

      <section className="panel mt-4" aria-labelledby="about-justwatch">
        <h2 id="about-justwatch" className="section-title">
          配信状況
        </h2>
        <p className="mt-2 text-sm text-zinc-300">
          日本での配信状況のデータは、TMDb を通じて{" "}
          <a href={JUSTWATCH_URL} rel="noreferrer" className="underline">
            JustWatch
          </a>{" "}
          から提供されています。実際の配信状況と異なる場合があります。
        </p>
      </section>

      <section className="panel mt-4" aria-labelledby="about-source">
        <h2 id="about-source" className="section-title">
          ソースコード
        </h2>
        <p className="mt-2 text-sm text-zinc-300">
          ソースコードは{" "}
          <a href={REPOSITORY_URL} rel="noreferrer" className="underline">
            GitHub
          </a>{" "}
          で MIT License のもとに公開しています。TMDb
          から取得するデータと画像は、リポジトリにもライセンスの対象にも含まれません。
        </p>
      </section>
    </main>
  );
}
