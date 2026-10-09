# movie-tracker デプロイ手順書

## 0. 全体像と前提
- **デプロイ先**：Cloudflare Workers（アプリ）と Cloudflare D1（データベース）。公開 URL は `https://movie-tracker.tanijiri.dev`（Workers のカスタムドメイン）。`workers.dev` とプレビュー用の URL は無効にしている。
- **ふだんのデプロイ**：main ブランチに push すると、GitHub Actions（`.github/workflows/deploy.yml`）が「テスト → D1 のマイグレーション → デプロイ」を行う。テストが失敗した場合、デプロイは行われない。
- **必要なアカウント**：Cloudflare（公開 URL のドメインを持っているアカウント）、GitHub、TMDb、Google Cloud。
- **手元に必要なツール**：Node.js 22 以上、pnpm 10。Cloudflare の操作は `pnpm exec wrangler ...` で行う（初回に `pnpm exec wrangler login`）。

## 1. 設定値・シークレット
値そのものは、このファイルにも、リポジトリのどこにも書かない。

| 名前 | 用途 | 手元 | 本番 |
|---|---|---|---|
| `TMDB_ACCESS_TOKEN` | TMDb の API を呼ぶ | `.dev.vars` | Workers のシークレット |
| `GOOGLE_CLIENT_ID` | Google ログイン | `.dev.vars` | Workers のシークレット |
| `GOOGLE_CLIENT_SECRET` | Google ログイン | `.dev.vars` | Workers のシークレット |
| `ALLOWED_EMAILS` | このアプリを使ってよいメールアドレス（カンマ区切り） | `.dev.vars` | Workers のシークレット |
| `SESSION_SECRET` | セッション Cookie の署名鍵 | `.dev.vars` | Workers のシークレット（手元とは別の値） |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions からデプロイする | — | GitHub のリポジトリのシークレット |
| `CLOUDFLARE_ACCOUNT_ID` | 同上 | — | GitHub のリポジトリのシークレット |

手元の設定ファイルは、`.dev.vars.example` をコピーして作る（`.dev.vars` は Git に入らない）。

### TMDb の API Read Access Token
1. [themoviedb.org](https://www.themoviedb.org/) でアカウントを作り、メールの確認を済ませる。PC のブラウザで行う（登録の画面はスマホ向けに作られていない）。
2. 「設定」→「API」（[themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)）で、API キーの発行を申請する。利用区分は個人・非商用（Developer）。
3. アプリの概要の欄は、一言では受け付けられない（「please elaborate on how you plan to use our API」というエラーになる）。どの API を何のために使うかを、数行で具体的に書く。
4. 発行後、同じページに表示される **「API Read Access Token」**（`eyJ` で始まる長い文字列）を使う。短い英数字の「API Key」ではない。

### Google ログイン（OAuth クライアント）
設定の場所は、Google Cloud コンソールの「Google Auth Platform」（[console.cloud.google.com/auth/overview](https://console.cloud.google.com/auth/overview)。「API とサービス」→「OAuth 同意画面」からも開ける）。メニューの名前は表示言語によって違うので、英語の名前を併記する。

1. [Google Cloud コンソール](https://console.cloud.google.com/) でプロジェクトを作る（既存のものでもよい）。
2. Google Auth Platform で「開始（Get started）」を押し、アプリ名、ユーザーサポートメール、対象（Audience）＝「外部（External）」、連絡先を入力する。
3. 「対象（Audience）」で、公開ステータスが「テスト中（Testing）」であることを確かめ、「テストユーザー」にログインに使うメールアドレスを追加する。テスト中のままでよい（追加したアカウントだけがログインでき、Google の審査も要らない）。
4. 「クライアント（Clients）」→「クライアントを作成（Create client）」。種類は「ウェブ アプリケーション」。「承認済みの JavaScript 生成元」は空のままにする。
5. 「承認済みのリダイレクト URI」に、次の2つを登録する（1文字でも違うとログインできない）。
   - `https://movie-tracker.tanijiri.dev/auth/google/callback`
   - `http://localhost:5183/auth/google/callback`
6. 作成直後に表示される「クライアント ID」と「クライアント シークレット」を、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` に設定する。**シークレットは作成したときにしか表示されない。** 控える前に閉じてしまった場合は、クライアントの詳細画面でシークレットを新しく追加する。JSON をダウンロードする場合は、プロジェクトのフォルダの外に保存する。
7. `ALLOWED_EMAILS` に、ログインを許可する Google アカウントのメールアドレスを設定する。

- 「データアクセス（Data Access）」の設定は要らない（受け取るのはメールアドレスと名前だけ）。
- 設定の反映には、5分から数時間かかることがある。
- 設定を確かめる方法（ログインはしない）：`curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://movie-tracker.tanijiri.dev/auth/google` が、`302` と `https://accounts.google.com/o/oauth2/v2/auth?...` を返す。`redirect_uri` が上の URI と一致していること。

### セッションの署名鍵
```bash
openssl rand -base64 48
```
手元と本番で別の値にする。値を変えると、発行済みのセッションはすべて無効になる（全員がログインし直しになる）。

## 2. 初回のセットアップ
一度だけ行う。`pnpm exec wrangler login` 済みであること。

```bash
# 1. D1 のデータベースを作る。表示された database_id を wrangler.jsonc の d1_databases に書く
pnpm exec wrangler d1 create movie-tracker

# 2. テーブルを作る
pnpm db:migrate:remote

# 3. デプロイする（カスタムドメインの DNS と証明書は、このとき自動で設定される）
pnpm run deploy

# 4. 本番のシークレットを登録する。手元の .dev.vars をもとに、SESSION_SECRET だけ新しく作る
grep -E '^[A-Z_]+=' .dev.vars | grep -v '^SESSION_SECRET=' > .prod.vars
echo "SESSION_SECRET=$(openssl rand -base64 48)" >> .prod.vars
pnpm exec wrangler secret bulk .prod.vars
rm .prod.vars
```

- `database_id` は識別子であり、秘密情報ではない（リポジトリに書いてよい）。
- 公開 URL と同じ名前の DNS レコードがすでにある場合、カスタムドメインは作れない。先に、そのレコードが何に使われているかを確認する（勝手に消さない）。
- `.prod.vars` は一時ファイル。`.gitignore` に入れてあるが、登録が済んだら必ず消す。

### GitHub Actions からデプロイできるようにする
1. Cloudflare の管理画面 →「マイプロフィール」→「API トークン」→「トークンを作成」。
2. テンプレート「Edit Cloudflare Workers（Cloudflare Workers を編集する）」を選ぶ。権限の一覧に **「アカウント / D1 / 編集」** がなければ追加する（D1 の権限がないと、デプロイの前のマイグレーションで失敗する）。
3. 「アカウント リソース」は対象のアカウントだけ、「ゾーン リソース」は公開 URL のドメインのゾーンだけに絞る。
4. 作成したトークンと、アカウント ID（管理画面の「Workers & Pages」の右側に表示される）を、GitHub のリポジトリのシークレットに登録する。値はターミナルで聞かれるので、貼り付けて Enter を押す（コマンドの引数には書かない）。

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
```

2つとも登録するまでは、デプロイのジョブは「未登録のためデプロイしませんでした」と通知して、失敗にせず終わる。

## 3. デプロイ
### 自動（ふだんはこちら）
```bash
git push origin main
```
実行の状況は次で確認する。

```bash
gh run list --workflow deploy.yml --limit 3
```

### 手動（GitHub Actions が使えないとき）
```bash
pnpm check               # 型チェック、lint、テスト、ビルド
pnpm db:migrate:remote   # データベースの構造に変更があるとき
pnpm run deploy
```

### データベースの構造を変えるとき
1. `app/lib/db/schema.ts` を変更する。
2. `pnpm db:generate` で `migrations/` に SQL を生成し、内容を読んで確かめる。
3. `pnpm db:migrate:local` で手元に適用し、`pnpm check` を通す。
4. push する（本番への適用は、デプロイの直前に GitHub Actions が行う）。

マイグレーションは、デプロイより先に適用される。**古いコードが動いている間に適用されても壊れない変更**（列の追加など）にする。列の削除や名前の変更は、「コードが使わなくなる」→「列を消す」の2回に分ける。

## 4. デプロイ後の動作確認
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://movie-tracker.tanijiri.dev/about` が `200` を返す
- [ ] 未ログインで `https://movie-tracker.tanijiri.dev/` を開くと、ログイン画面に移動する
- [ ] 自分の Google アカウントでログインでき、トップページが表示される
- [ ] 「探す」でタイトル検索ができ、映画の詳細が日本語で表示される
- [ ] 映画を登録し、トップページに表示される

## 5. 運用メモ
- **ログを見る**：`pnpm exec wrangler tail`（リアルタイム）。Cloudflare の管理画面の「Workers & Pages」→ movie-tracker →「ログ」でも見られる。
- **データのバックアップ**：`pnpm exec wrangler d1 export movie-tracker --remote --output backup.sql`。出力には登録した映画や感想が含まれるので、リポジトリに入れない。
- **データを直接見る**：`pnpm exec wrangler d1 execute movie-tracker --remote --command "SELECT COUNT(*) FROM user_movies"`。
- **無料プランの上限**：Workers は1日10万リクエスト、1リクエストあたり CPU 10ミリ秒。D1 は 5GB、1日 500万行の読み取り、10万行の書き込み。超えるとその日はエラーになる（料金は発生しない）。
- **許可するアカウントを変える**：`pnpm exec wrangler secret put ALLOWED_EMAILS` で登録し直す。外したメールアドレスのセッションは、すぐに無効になる。
- **TMDb の利用条件**：非商用に限る。クレジットのページ（`/about`）を消さない。広告や課金を入れる場合は、先に TMDb に問い合わせる。

## 6. ロールバック
- **アプリを前の版に戻す**：`pnpm exec wrangler rollback`（直前の版に戻る）。原因が分かったら、`git revert` で main を直して push する。戻したままにすると、次の push で新しい版がまたデプロイされる。
- **データベースの構造**：マイグレーションに「戻す」操作はない。戻す必要がある場合は、元に戻すマイグレーションを新しく作る。
- **データを過去の時点に戻す**：D1 の Time Travel（`pnpm exec wrangler d1 time-travel restore movie-tracker --timestamp=<時刻>`）。無料プランでは過去7日まで。戻した時点より後の登録は失われるので、先にバックアップを取る。
