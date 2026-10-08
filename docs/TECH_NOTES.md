# 技術ノート：movie-tracker

実装してわかったこと・ハマったことを、あとで記事や別プロジェクトで使える形で残す。
仕様書が完了したら、得られた知見をここに還元する。

## 1. 技術選定
計画の時点の候補は「Next.js ＋ Vercel ＋ PostgreSQL / Supabase」だった。キックオフでデプロイ先を Cloudflare に決めたため、Cloudflare 前提ですべて選び直した（2026-10-07）。

| 対象 | 選んだもの | 選ばなかったもの | 理由 |
|---|---|---|---|
| 実行環境 | Cloudflare Workers | Vercel | ユーザーの指定 |
| 公開 URL | 取得済みの独自ドメインのサブドメイン（Workers のカスタムドメイン）。`workers.dev` は無効 | `〜.workers.dev` の URL、両方を有効にする | ユーザーの指定（2026-10-08）。ドメインが同じ Cloudflare アカウントにあるので、DNS と証明書はデプロイ時に自動で設定される。入口を1つにすると、OAuth のリダイレクト先が1つで済む |
| DB | Cloudflare D1（SQLite 系） | Neon、Supabase（PostgreSQL） | アプリと同じアカウントで完結し、バインディングでつながるので接続文字列（秘密情報）を持たなくてよい。無料枠は 5GB・1日 500万行の読み取り・10万行の書き込みで、個人利用には十分。Supabase の無料枠は1週間ほど使わないと停止し、手動で再開する必要がある。Neon は自動で復帰するが、別アカウントと接続情報の管理が要る |
| フレームワーク | React Router v8（framework mode）。選んだ時点では「v7」のつもりだったが、ひな形を生成したら v8 になっていた | Next.js ＋ OpenNext、Hono ＋ React（SPA） | Cloudflare が公式にテンプレートを用意しており、`@cloudflare/vite-plugin` で開発サーバーが Workers のランタイム上で動く（手元と本番の差が小さい）。loader / action で TMDb のトークンをサーバー側に閉じ込められる。Next.js は変換層（OpenNext）を挟むぶんサイズが大きくなりやすい。Hono ＋ SPA は画面側のデータ取得を自分で書く量が増える |
| ORM | Drizzle | Prisma、生の SQL | D1 に公式対応し、軽い。`drizzle-kit` が出力する SQL を `wrangler d1 migrations apply` でそのまま適用できる |
| 認証 | Google ログイン（OAuth 2.0 ＋ PKCE）を自前で実装、署名付き Cookie のセッション | 合言葉1つ、Cloudflare Access、認証サービス | ユーザーの指定。Cloudflare Access はアプリの外の設定になり、利用者をアプリ内で識別できない。利用者が1人の段階なので、セッションは DB に持たず署名付き Cookie にした |
| 映画の情報 | TMDb の API（配信状況は TMDb 経由の JustWatch） | 映画館や配信サービスのサイトのスクレイピング | 公開リポジトリにする前提で、正式に取得が認められているものだけを使う |
| デプロイ | GitHub Actions（テスト → D1 マイグレーション → `wrangler deploy`） | Cloudflare Workers Builds、手元のコマンドだけ | Workers Builds が自動で作る API トークンには D1 の権限がなく、ビルドの中でマイグレーションを適用できない。GitHub Actions なら「テストが通ったときだけデプロイ」を1つの定義に書ける |
| テスト | Vitest 4.1 ＋ `@cloudflare/vitest-plugin`（旧名 `@cloudflare/vitest-pool-workers`） | Node 上のモック DB | miniflare 上の実物の D1 に対してテストできる。外部 API はモックし、秘密情報なしで通す |

**実装時に確かめたこと**
- **Workers 無料プランの上限**（公式ドキュメント、2026-10-08 時点）：サイズは無料・有料とも圧縮前 64 MiB で、圧縮後の上限はない。CPU 時間は1リクエスト 10ミリ秒、1日 10万リクエスト、1リクエストあたりの外部への通信は 50回。`wrangler deploy --dry-run` の結果は圧縮前 約 1 MiB／gzip 後 約 225 KiB で、サイズは問題にならない。事前の検索では「1MB」「3MB」「CPU 30ms」など食い違う数字が出てきたので、数字は必ず公式ドキュメントで確かめること。
- **TMDb の「近日公開」**：`/movie/upcoming`（`region=JP`）は約3週間先までの31件しか返さない。`/discover/movie` に `region=JP`、`with_release_type=2|3`、`release_date.gte`／`lte` を指定すると、期間を自分で決められる（半年先までで135件）。並び順は `popularity.desc` にした。`primary_release_date.asc` は世界での最初の公開日で並び、再上映の旧作が先頭に来るので使えない。
- **キャッシュ（Cache API）は使わないことにした。** 利用者が1人では効果が小さく、配信状況が古くなる害のほうが大きい。

## 2. アーキテクチャ
```
ブラウザ ──→ Cloudflare Workers（React Router v8、SSR）──→ TMDb の API（映画の情報）
   │                │
   │                ├──→ Cloudflare D1（利用者、映画のスナップショット、利用者ごとの記録）
   │                └──→ Google（ログインのときだけ）
   ├──→ image.tmdb.org（ポスターなどの画像。ブラウザが直接読み込む）
   └──→ youtube-nocookie.com（予告の再生ボタンを押したときだけ）
```

- **ルート**：`app/routes.ts` に手で書く。ログインが必要なルートは、レイアウト `routes/app-layout.tsx` の下に置く。このレイアウトのミドルウェアがセッションを確認し、利用者を context に入れる。
- **データの読み書き**：`app/lib/db/*.server.ts` の関数にまとめる。利用者のデータに触れる関数は、すべて `userId` を引数に取る。
- **映画の情報**：`app/lib/tmdb/client.server.ts` だけが TMDb を呼ぶ。応答はそのまま持ち回らず、画面で使う項目だけの型（`MovieSummary`、`MovieDetail`）に変換する。
- **映画詳細の画面の操作**（登録、きっかけ、見た記録）は、1つの action に `intent` を付けて POST する。画面は `useFetcher` で送り、再読み込みなしで更新する。JavaScript が無効でも、通常のフォームの送信として動く。
- **一覧の画面**（トップページ、リスト）は、D1 に保存したスナップショットだけで表示する。応答を返したあと、古くなったスナップショットを数本ずつ TMDb から取り直す（`refreshStaleSnapshots`）。
- **日付**：`YYYY-MM-DD` の文字列で持つ。「今日」は `Asia/Tokyo` で計算する（Workers は UTC で動く）。

## 3. ハマりどころと対処
### 画面側からサーバー専用のファイルを参照すると、ビルドだけが失敗する
- **症状**：`pnpm dev` もテストも通るのに、`pnpm build` が `Server-only module referenced by client` で失敗する。
- **原因**：画面のコンポーネントが、`*.server.ts` に置いた定数（絞り込みの種類の一覧）を参照していた。React Router は loader / action のコードをブラウザ用のビルドから取り除くが、コンポーネントが使う値は取り除けない。型だけの参照（`import type`）は問題ない。
- **対処**：画面とサーバーの両方で使う定数は、`.server` の付かないファイル（`app/lib/list.ts` など）に置く。変更したら `pnpm check` でビルドまで通す。

### 開発用の機能が、本番のビルドに文字列として残る
- **症状**：開発用ログインのルートを本番では登録していないのに、`grep -r dev-login build/` がヒットする。
- **原因**：ログイン画面で、loader が返したフラグ（`showDevLogin`）でリンクを出し分けていた。出すかどうかは実行時に決まるので、リンクの文字列はビルドに入る。
- **対処**：`import.meta.env.DEV && <a ...>` のように、ビルド時に定数になる条件で直接囲む。本番のビルドでは、この部分がコードごと消える。

### 映画の公開日が、日本の公開日と違う
- **症状**：「近日公開」の一覧では 10月公開だった作品が、登録するとトップページで 9月公開と表示される。
- **原因**：TMDb の `/movie/{id}` の `release_date` は、世界で最初の公開日。一覧（`region=JP` を指定した discover など）は日本の日付を返すので、食い違う。
- **対処**：詳細の取得に `append_to_response=release_dates` を足し、日本（`JP`）の劇場公開（種類 3、なければ 2）の最初の日付を使う。なければ `release_date` を使う。

### テストが `.dev.vars` の実物のトークンを読む
- **症状**：テストの実行時に `Using secrets defined in .dev.vars` と表示される。
- **原因**：テスト用のプラグインは `wrangler.jsonc` と一緒に `.dev.vars` も読み込む。
- **対処**：`vitest.config.ts` の `miniflare.bindings` で、すべての秘密情報をダミー値で上書きする（上書きが効いていることを確かめるテストもある）。あわせて `test/setup.ts` で `fetch` を差し替え、モックしていない外部への通信は例外にしている。

### 応答のあとに続く処理が、テストの後始末のあとに動く
- **症状**：一覧の loader が裏で始めた「古い情報の取り直し」が、テストが終わって `fetch` の差し替えを外したあとに動き、実際に TMDb に通信しようとする。
- **対処**：裏で動かす処理は `runInBackground`（`app/lib/background.server.ts`）を通し、動いている処理を覚えておく。テストの後始末（`afterEach`）で `settleBackgroundTasks()` を待ってから、差し替えを外す。

### `<details>` の中身が、開いた直後のスクリーンショットに写らない
- 画面の確認で、「見た」を押したのに入力欄が出ていないように見えた。DOM を調べると開いており、少し待って撮り直すと表示されていた。遅延読み込みの画像（`loading="lazy"`）も同じで、直後のスクリーンショットでは空に見える。見た目だけで不具合と決めつけず、DOM の状態を確かめること。

### `build/` に秘密情報のコピーができる
- `react-router build` は、`vite preview` のために `build/server/.dev.vars` を作る。`build/` は `.gitignore` に入っている。この行を消さないこと。

### 開発サーバーのポート
- Vite の既定の 5173 は、同じ Mac で動いていた別のプロジェクトの開発サーバーとぶつかった。Google ログインのリダイレクト URI はポートまで一致させる必要があるので、このプロジェクトは 5183 に固定している（`strictPort` で、空いていなければ起動を失敗させる）。

### React Router と Origin の検証
- 画面のあるルートへの POST は、React Router 自身が Origin の不一致を 400 で拒否する（自前のミドルウェアより先に働く）。画面のないルート（`/logout`）は対象外なので、自前のミドルウェア（`sameOriginMiddleware`）が 403 で拒否する。両方とも残すこと。

### zsh では、変数が単語に分割されない
- 確認用のシェルスクリプトで `set -- $IDS` と書いたら、zsh では1つの引数として渡り、URL が壊れて `curl` が終了コード 3 で失敗した。複数の値を1つの変数に入れて回す処理は、`bash` で実行する。

## 4. 「効かなかったこと」リスト
- **`@cloudflare/vitest-pool-workers` を入れる** → 改名されて非推奨。`@cloudflare/vitest-plugin` を使う。
- **Vitest の最新版（5 系）をそのまま使う** → プラグインが 4.1 系を要求する。
- **TMDb の `/movie/upcoming` で近日公開を出す** → 約3週間先までしか返らず、予告で見た数か月先の作品が見つからない。
- **`/discover/movie` を `primary_release_date.asc` で並べる** → 世界での最初の公開日で並び、再上映の旧作が先頭に来る。
- **effect の中で `setState` して、保存の成功後に入力欄を閉じる** → `eslint-plugin-react-hooks` v7 の `set-state-in-effect` でエラーになる。送信結果が変わったことを描画中に検知して状態を更新する形にした（`useCloseOnSuccess`）。
- **ID トークンのテストデータを `btoa(JSON.stringify(...))` で作る** → 名前に日本語が入っていると `btoa` が例外を出す。UTF-8 のバイト列にしてから Base64URL にする。
- **TMDb の申請フォームの概要欄に一言だけ書く** → 「please elaborate on how you plan to use our API」というエラーになる。使い方を数行で具体的に書く。

## 5. 今後の課題
- **CPU 時間（無料プランは1リクエスト 10ミリ秒）**：「探す」で「もっと見る」を重ねると、最大200件を1回で描画する。本番で CPU の上限に掛かっていないかを、Cloudflare の管理画面のログで確認する。掛かる場合は、1回に表示するページ数の上限（`MAX_PAGES`）を下げる。
- **セッションの失効**：セッションは署名付きの Cookie に入れており、個別に無効にする手段は「許可リストから外す」と「署名鍵を変える（全員が対象）」だけ。利用者を増やすときは、D1 にセッションを持つ形に変える。
- **Content-Security-Policy**：まだ入れていない。入れるには、React Router が出力するインラインのスクリプトに nonce を付ける必要がある（`entry.server.tsx` を用意する）。
- **配信状況の変化の検出**（フェーズ2）：いまは、詳細を開いた時点の配信状況を表示するだけ。定期的に確認する仕組みを作るときは、スナップショットの取り直し（`refreshStaleSnapshots`）と合わせて設計する。
- **見た記録を複数回ぶん持つ**：いまは1本につき1つ。再鑑賞を別々に残すなら、見た記録を別のテーブルに分ける。
