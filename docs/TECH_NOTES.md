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
| フレームワーク | React Router v7（framework mode） | Next.js ＋ OpenNext、Hono ＋ React（SPA） | Cloudflare が公式にテンプレートを用意しており、`@cloudflare/vite-plugin` で開発サーバーが Workers のランタイム上で動く（手元と本番の差が小さい）。loader / action で TMDb のトークンをサーバー側に閉じ込められる。Next.js は変換層（OpenNext）を挟むぶんサイズが大きくなりやすい。Hono ＋ SPA は画面側のデータ取得を自分で書く量が増える |
| ORM | Drizzle | Prisma、生の SQL | D1 に公式対応し、軽い。`drizzle-kit` が出力する SQL を `wrangler d1 migrations apply` でそのまま適用できる |
| 認証 | Google ログイン（OAuth 2.0 ＋ PKCE）を自前で実装、署名付き Cookie のセッション | 合言葉1つ、Cloudflare Access、認証サービス | ユーザーの指定。Cloudflare Access はアプリの外の設定になり、利用者をアプリ内で識別できない。利用者が1人の段階なので、セッションは DB に持たず署名付き Cookie にした |
| 映画の情報 | TMDb の API（配信状況は TMDb 経由の JustWatch） | 映画館や配信サービスのサイトのスクレイピング | 公開リポジトリにする前提で、正式に取得が認められているものだけを使う |
| デプロイ | GitHub Actions（テスト → D1 マイグレーション → `wrangler deploy`） | Cloudflare Workers Builds、手元のコマンドだけ | Workers Builds が自動で作る API トークンには D1 の権限がなく、ビルドの中でマイグレーションを適用できない。GitHub Actions なら「テストが通ったときだけデプロイ」を1つの定義に書ける |
| テスト | Vitest ＋ `@cloudflare/vitest-pool-workers` | Node 上のモック DB | miniflare 上の実物の D1 に対してテストできる。外部 API はモックし、秘密情報なしで通す |

**実装時に確かめること**（確かめたら、結果をこのファイルに書く）
- Workers 無料プランの上限（スクリプトの圧縮後サイズ、1リクエストあたりの CPU 時間）と、SSR を含むビルドがそれに収まるか。
- カスタムドメイン（`routes` の `custom_domain: true`）を含むデプロイを GitHub Actions から行うとき、API トークンに必要な最小の権限。
- カスタムドメインで Cache API が効いているか（`*.workers.dev` では効かない場合があるため、公開 URL を独自ドメインだけにした）。
- TMDb の「近日公開」を日本向けに正しく取るには、どのエンドポイントとパラメータがよいか。

## 2. アーキテクチャ
<!-- 構成とデータの流れ -->

## 3. ハマりどころと対処
<!-- 症状 → 原因 → 対処 の順で書く。CLAUDE.md の「消してはいけない設定」の理由はここに書く -->

## 4. 「効かなかったこと」リスト
<!-- 試したがうまくいかなかったこと。同じ失敗を繰り返さないために書く -->

## 5. 今後の課題
