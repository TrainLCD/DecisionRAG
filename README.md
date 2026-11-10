# TrainLCD DecisionRAG

TrainLCD org の Issue・PR・リポジトリ文書・ユーザーフィードバックを、Jevで階層的に探索するヘッドレスAPI。Cloudflare Workers + D1 + Queues、TypeScript製。

検索方式は **[Retriever-Free Retrieval: Navigating Documents with Decision Models](https://arxiv.org/abs/2610.35868) の §3・Algorithm 1 に基づく階層ナビゲーション**。Embedding、ベクトルDB、BM25、FTSによる候補の事前絞り込みは行わない。D1は文書・階層・本文区間の保存に用いる。

## 検索方法

1. 検索範囲が5,000文書以下で設定された上限内なら、全ての文書タイトルをJevで評価する。超える場合は `リポジトリ × 種類` の枝をJevで評価して、上位6枝の全タイトルに進む。
2. 文書タイトルを共有コンテキストのバッチに分け、並列で評価する。上位30文書に加え、NoulのYes確率が50%を超えた文書の本文も評価する。
3. 選んだ文書の本文区間を評価し、関連あり（NoulのYes確率が50%を超える）と判定した全区間を数える。
4. 関連ありの全区間を返す。上位20区間のうち入力上限に収まるものをChoiceで並べ替え、残りはNoulの順位を使う。本文候補全体が20区間以内で一つのリクエストに収まる場合は、関連性の判定とChoiceをまとめて行う。

候補集合は枝120件、文書240件、本文区間60件を上限とし、1バッチの説明文は枝と文書で70,000文字、本文で38,000文字以内に分ける。Jevがコンテキスト超過を返したバッチは分割して評価する。Choiceに渡す説明文は28,000文字以内とする。本文は見出し・段落を優先し、最大2,400文字の区間に分割する。

`/answer` は検索で見つかった資料から、出典付きの回答または要約を作る。引用IDを照合し、上位20区間を使ってJevで主張ごとの裏付け、回答の十分性、根拠間の矛盾を判定する。質問に完全には答えられなくても、出典で確認できる内容を要約として返せる。矛盾の確率が `CONFLICT_THRESHOLD` に達した場合は回答を保留する。

## 情報源と同期

| 対象 | 内容 |
|---|---|
| org内Issue | 本文、全コメント、状態、ラベル、投稿者 |
| org内PR | 本文、会話、レビュー、インラインレビュー、変更ファイル名、マージ日時、マージ先ブランチ |
| 各リポジトリ文書 | デフォルトブランチの `.md`, `.mdx`, `.rst`, `.adoc`, `.txt`。vendor/build等を除外 |
| `TrainLCD/Issues` | 同じIssueを重複登録せず `feedback` として保存 |

初回 `POST /sync` でorg内のアクセス可能なリポジトリを列挙し、Queuesで分割取り込みする。6時間ごとのCronとWebhookで更新する。Issue/PRの差分巡回には10分の重複期間を設ける。文書のURLはコミットSHA固定。文書削除は完全なツリー取得後に反映し、古いコミットのジョブは破棄する。

リポジトリごとにGitHubの最新正式リリースを同期する。リリースタグが指すコミットの履歴にPRのマージコミットが含まれると確認できた場合、根拠に `metadata.github_release`（タグ、URL、公開日時）を追加する。画面はそのGitHubリリースに収録されたことを表示する。初出バージョンやApp Store・Google Playの配信状況は別の情報源が必要になる。

## セットアップ

Node.js 24以降を推奨する。テストは `node:sqlite` を使う。

```sh
npm ci
npm run check
npm test
npx wrangler d1 create trainlcd-decision-rag
npx wrangler queues create trainlcd-rag-sync
npx wrangler queues create trainlcd-rag-sync-dlq
```

作成されたD1 IDを `wrangler.jsonc` の `database_id` に設定する。ゼロのIDは例示用であり、実環境にはそのままデプロイしない。

```sh
npm run db:remote
npx wrangler secret put API_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TYPESAFE_API_KEY
```

- `API_TOKEN`: フィードバック検索・同期・管理用のBearerトークン。十分長いランダム値を設定する。
- `WEBHOOK_SECRET`: GitHub Webhookと同じ値。
- `GITHUB_TOKEN`: org内対象リポジトリのMetadata・Contents・Issues・Pull requestsの読み取り権限が必要。リポジトリ作成・書き込み権限は不要。
- `TYPESAFE_API_KEY`: Jevのキー。[公式APIドキュメント](https://docs.typesafe.ai/api/system-one)を参照。

既定の文章生成には Cloudflare Workers AI の `AI` バインディングを使う。別の生成サービスを使う場合は、`ANSWER_MODEL`・`ANSWER_BASE_URL` を設定し、`wrangler secret put ANSWER_API_KEY` を実行する。OpenAI互換の `/chat/completions` とJSON object出力に対応するプロバイダーを想定する。根拠の本文はJevと設定された生成サービスに送信される。

`workers_dev` は既定で `false`。利用するホスト名のrouteを設定するか、意図して `true` に変更してから `npm run deploy` を実行する。公開資料の検索・要約は認証なしで使える。フィードバック検索、同期、管理APIはBearer認証が必須。WebhookはHMAC-SHA256署名検証が必須。複数ユーザー向けのACLは実装していないため、このAPIトークンを他者に配布しないこと。

ローカル開発:

```sh
cp .dev.vars.example .dev.vars
# .dev.varsの値を自分のキーに設定する
npm run db:local
npm run dev
```

`.dev.vars`、`.env`、ローカルD1データはgit対象外。

## サンプルWebアプリ

`npm run dev` で表示されるローカルURLの `/` から公開資料を検索できる。「フィードバックを含める」を選んだときや、ヘッダーのメニューから同期操作をするときは、`API_TOKEN` で接続する。認証に成功した利用キーは同じブラウザーに保存され、次回アクセス時に再認証される。接続解除または保存済みのキーが認証で拒否されたときに消去される。

### 本番の自動デプロイ

既存の `trainlcd-decision-rag` Worker を対象にする。有効化の前に、公開中の Worker のソースをデフォルトブランチへ取り込み、D1 と Queues のバインディングが `wrangler.jsonc` と一致することを確認する。

1. GitHub の Settings → Environments → `production` で、Deployment branches and tags を **Selected branches and tags** に設定し、デフォルトブランチ（現在は `main`）だけを Branch ルールに追加する。本番デプロイに承認が必要な場合は、同じ環境で Required reviewers を設定する。同じ環境に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を Secrets として登録する。
2. 同じ環境の Variables に、既存の本番 D1 の ID を `DECISIONRAG_D1_DATABASE_ID` として登録する。
3. Cloudflare の本番 Worker の Variables and Secrets で `GITHUB_ORG` が `TrainLCD` に設定されていることを確認する。
4. リポジトリの Actions Variables に `DECISIONRAG_DEPLOY_ENABLED=true` を設定する。

有効化後は、デフォルトブランチへの push または同ブランチでの手動実行で CI が走る。検証を通過したデプロイジョブは順番に実行され、各ジョブがデプロイ直前にデフォルトブランチの最新コミットかどうかを確認する。自動デプロイは `wrangler.jsonc` の `vars` を除外し、Cloudflare に登録済みの本番変数と Secrets を引き継ぐ。`SUPPORT_THRESHOLD` などの本番値は、Cloudflare の本番 Worker の Variables and Secrets で変更する。

CI は `wrangler versions upload` と `wrangler versions deploy` でコードのバージョンを更新する。`workers.dev`、カスタムドメイン、Cron などの公開経路やトリガーは Cloudflare 側の既存設定を使う。これらを変更する場合は Cloudflare 側で別途設定する。

#### 本番 D1 のマイグレーション

CI のマイグレーションはローカル D1 にのみ適用する。本番のスキーマ変更に依存する PR は、次の順で反映する。

Wrangler はファイル名で適用済みのマイグレーションを記録する。本番に適用したファイルは固定し、修正は新しいマイグレーションとして追加して、同じ手順でマージ前に適用する。

1. 現行 Worker でも動く互換性のあるマイグレーションを用意する。列の削除や名前変更が必要なら、新旧スキーマに対応できる Worker を先にデプロイし、旧スキーマを参照しなくなってから削除する。
2. マージ前に、対象のマイグレーションファイルを含む作業ツリーのルートで `wrangler.jsonc` を `wrangler.production.jsonc` にコピーする。コピーの `d1_databases` にある `DB` バインディングの `database_id` を、GitHub の `production` 環境に登録した `DECISIONRAG_D1_DATABASE_ID` の値に置き換える。コピーはローカルの作業用に使う。そのパスを指定して未適用のマイグレーションを確認し、適用する。適用後に未適用分がないことと、現行 Worker の `/sync/status` が本番 D1 を読み取れることを確認する。

   ```sh
   export DECISIONRAG_PROD_CONFIG=./wrangler.production.jsonc
   npx wrangler d1 migrations list DB --remote --config "$DECISIONRAG_PROD_CONFIG"
   npx wrangler d1 migrations apply DB --remote --config "$DECISIONRAG_PROD_CONFIG"
   npx wrangler d1 migrations list DB --remote --config "$DECISIONRAG_PROD_CONFIG"
   ```

3. 適用と動作確認が成功してから PR をマージし、Worker の自動デプロイへ進む。どちらかが失敗したらマージを保留する。先にマージする必要がある場合は、マージ前に `DECISIONRAG_DEPLOY_ENABLED=false` を設定し、実行待ちの本番デプロイもキャンセルする。複数のマイグレーションの途中で失敗した場合、先に成功した分は適用済みなので、再試行前に未適用分を確認する。
4. 自動デプロイを停止してマージした場合は、マイグレーションと動作確認が成功してから `DECISIONRAG_DEPLOY_ENABLED=true` に戻す。変数の変更だけでは CI は起動しない。GitHub Actions の `CI` で **Run workflow** を選び、デフォルトブランチ（現在は `main`）を指定する。GitHub CLI なら `gh workflow run ci.yml --ref main` で起動する。

## API

| Method | Path | 役割 |
|---|---|---|
| GET | `/health` | プロセスの生存確認。外部サービス疎通は確認しない |
| POST | `/sync` | 全リポジトリの同期をキューに登録 |
| GET | `/sync/status` | 同期ジョブ、失敗、ソース数、最終同期カーソル |
| POST | `/search` | 階層探索による根拠・出典・Jev判定トレース |
| POST | `/answer` | 根拠を検索し、生成モデルがあれば出典付きの主張を生成・検証する。モデルがなければ根拠を評価する |
| POST | `/admin/purge` | `{"repo":"TrainLCD/Example"}` の索引を削除 |
| POST | `/webhooks/github` | GitHubイベント受信。署名必須 |

```sh
curl "$RAG_URL/sync" -X POST -H "Authorization: Bearer $RAG_API_TOKEN"
curl "$RAG_URL/search" \
  -H 'Content-Type: application/json' \
  --data '{"query":"地下で位置更新が止まる問題について、どんな対応が議論された？"}'
```

`/search`・`/answer` には1〜1,500文字の `query` と、任意の真偽値 `include_feedback` を指定できる。認証なし、または `include_feedback: false` の場合は、GitHubが現在公開と返すリポジトリの資料だけを検索する。`include_feedback: true` と有効なBearerトークンを送ると、公開資料に `TrainLCD/Issues` のフィードバックを加える。互換性のため、有効なBearerトークンだけを送って `include_feedback` を省略すると、従来どおり認証済みの索引全体を検索する。認証なしの利用はIPアドレスごとに Cloudflare のレート制限を適用する。

公開範囲は検索ごとに GitHub で再確認し、ETag に対して `304 Not Modified` が返った場合はリポジトリ一覧の応答を再利用する。確認に失敗した場合は検索を中止する。

レスポンスには `evidence`（引用ID、ソースID、本文区間、URL、repo、状態等のmetadata、関連度）、`hit_count`（選択文書の中で関連ありと判定した本文区間の総数）、`trace`（ステージ、候補数、モデル、呼び出し数、使用トークン、時間）、`elapsed_ms` を含む。`timings` には公開範囲の確認、D1取得、Jev判定、要約生成、検索完了までの時間をミリ秒で記録する。公開範囲の確認と最初のD1取得は並行するため、工程別の時間には重複がある。検索はソース間の網羅的な調査を保証せず、各階層の上位予算により枝刈りする。

既定の生成モデルは1回の呼び出しで最大2文を生成する。`generate_answer` ステージには、生成モデルと所要時間、プロバイダーが返した入出力トークン数を記録する。

`/answer` のstatus:

- `answered`: 質問に答える文章と引用IDを返した。
- `summarized`: 質問の一部について、資料で確認できた内容を引用ID付きで返した。
- `evidence_ready`: 根拠は十分と判定したが、生成モデルは未設定。
- `insufficient_evidence`: 根拠不足。回答はnull。
- `conflicting_evidence`: 同じ対象・時点について根拠が矛盾し、回答を検証できなかった。回答はnull。
- `verification_failed`: 生成結果を根拠検査で却下。回答はnull。
- `generation_unavailable`: 既定の生成モデルから利用できる要約を得られなかった。検索で得た資料は返す。

Jevや別途設定した生成サービスの失敗はHTTP 502。検索予算超過はHTTP 422。

## GitHub Webhook

Org Webhookまたは各リポジトリのWebhookを、デプロイ先の `/webhooks/github` に設定する。

- Content type: `application/json`
- Secret: `WEBHOOK_SECRET` と同じ値
- Events: Issues、Issue comments、Pull requests、Pull request reviews、Pull request review comments、Pushes、Repositories、Releases

重複配信は許容する。常にGitHub上の最新状態を取得してupsertする。Issue削除・移管、リポジトリ削除・移管のイベントで索引も削除する。同期失敗は最大5回再試行し、DLQに移る。`/sync/status` のエラーとDLQを監視し、原因解消後に再処理する。同期カーソルは「子ジョブの登録完了」を表すもので、取り込み完了を保証しない。

## 制限と次の評価

- 自動テストのJev・生成・GitHub通信はモック。検索精度と応答時間は質問やデータ量によって変わる。
- 既定で選択枝内20,000文書、選択文書内4,000本文区間まで。超過は明示的に失敗する。文書候補をバッチ単位で評価するため、選択された文書が多いほどAPI呼び出し数が増える。
- `MAX_SCREENED_DOCUMENTS`（最大100,000）、`SUPPORT_THRESHOLD`、`CONFLICT_THRESHOLD` を環境変数で変更可能。
- 1ソース600KB、GitHubコメント等のページネーション100ページが上限。切り捨てず同期エラーにする。Gitツリーがtruncatedの場合も同期エラーにする。非常に大きい文書群・スレッドは追加の分割取り込みが必要。
- PR差分コード全体、GitHub Wiki、添付画像・PDF・外部リンク先、Releaseは取り込まない。
- Webhook停止中に削除されたIssueやアクセス権を失ったリポジトリは、差分巡回だけでは削除を検知できない。該当ソースを管理者が削除するか、DBを再構築して全件同期する。`/admin/purge` 後でも既存の同期ジョブや次回巡回で再登録されるため、恒久的な除外設定ではない。
- ジョブが古いGitHub状態を取得した直後に新しいジョブと競合すると、次の差分巡回まで一時的に古い内容になる場合がある。
- プロンプトインジェクションへの指示分離と署名検証は実装するが、モデルによる誤判定を排除できない。自動でIssue・PRを作成したりコードを書き換えたりする機能はない。

## 検証

```sh
npm run check
npm test
npx wrangler d1 migrations apply trainlcd-decision-rag --local
npx wrangler deploy --dry-run --outdir dist
```

テストは階層探索、共有コンテキストでの順位付け、予算超過、要約の引用と矛盾の検証、PR状態、フィードバックの重複排除、文書削除、Webhook署名・org境界、API認証と公開範囲の再検証を確認する。

## 参考

- Wan et al., [Retriever-Free Retrieval: Navigating Documents with Decision Models](https://arxiv.org/abs/2610.35868), 2026.
- [TypeSafe API](https://docs.typesafe.ai/api/system-one)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
