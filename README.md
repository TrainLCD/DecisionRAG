# TrainLCD DecisionRAG

TrainLCD org の Issue・PR・リポジトリ文書・ユーザーフィードバックを検索するヘッドレスAPI。関連性の判定、順位付け、参照文書の選択、引用検査を **Rust/WASMのローカルルール**で実行する。Decisionの外部API、モデル重み、GPUは不要。

ヘッドレス側のルーティング・認証・検索・D1操作・GitHub同期・リリース判定・Webhook・Queues・回答検査・SSE処理は `backend/` のRust実装。`src/host.ts` と `src/worker.ts` はCloudflareのI/Oバインディングだけを担当する。判定コアはネイティブのJSON Lines CLIとしても動作する。

## 検索方法

1. 公開範囲を確認してからD1の文書候補を読む。540文書ずつ読み込み、許可された範囲を全件走査する。`MAX_SCREENED_DOCUMENTS`を超えれば422で終了し、部分的な走査を成功扱いしない。
2. RustでNFKC正規化、日英の用語対応、技術識別子、番号、未知の日本語名を照合する。語のカバー率と見出しの一致を重み付けする。語彙と間接的な手掛かりは `rust/rules.rs` と `rust/lib.rs` に置く。
3. 上位30文書とスコア0.5超の文書を残し、検索範囲内の明示的な同一リポジトリ参照を1段だけたどる。従来のAIによる粗いグループ選別は行わない。
4. 本文区間をRustで独立採点し、0.5超を関連本文とする。同点は元の順番を維持する。APIの `relevance` および内部互換名 `probability` は**ルールスコアであり、校正された確率ではない**。
5. Webは全関連本文を取得後に10件ずつ表示する。全件数・総ページ数は同じ結果集合から算出し、ページ送りでは検索・判定・文章生成を再実行しない。

`/answer` の文章生成接続とSSEは維持する。ローカル検査は引用ID、原文一致、用語の対応、否定・条件・推測表現、数値、原因・配信・変更の断定を検査する。原文と完全一致しないだけで回答を削除せず、引用先と関連があり明示的なルール違反が見つからない言い換えも返す。語句の類似は意味の証明ではないため、`verification.method=local_support_rules`、`semantic_status=unknown` とし、`reasons`で原文一致・ルールによる支持・意味的支持の未確定を区別する。回答の完全性と意味的な矛盾検出も`unknown`である。引用先不明・関連なし・検出可能な否定反転や根拠のない配信断定などは除外し、残る回答がなければ原文を「資料の記載」として引用する。

検索結果は以前のモデルと一致するとは限らない。実資料40区間での再現可能な比較と未検証範囲は [rust-local-decisions.md](docs/rust-local-decisions.md) を参照。

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

Node.js 24以降とRust stableが必要。テストは `node:sqlite` を使う。

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
cargo test --workspace --locked
npm run build:rust
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
```

- `API_TOKEN`: フィードバック検索・同期・管理用のBearerトークン。十分長いランダム値を設定する。
- `WEBHOOK_SECRET`: GitHub Webhookと同じ値。
- `GITHUB_TOKEN`: org内対象リポジトリのMetadata・Contents・Issues・Pull requestsの読み取り権限が必要。リポジトリ作成・書き込み権限は不要。
- 判定はRust/WASM内で完結する。`AI` は文章生成にのみ使用する。`SCREENING_MODEL`、`TYPESAFE_API_KEY`、`JEV_MODEL` は本番の判定では参照しない。

既定の文章生成には Cloudflare Workers AI の `AI` バインディングを使う。別の生成サービスを使う場合は、`ANSWER_MODEL`・`ANSWER_BASE_URL` を設定し、`wrangler secret put ANSWER_API_KEY` を実行する。OpenAI互換の `/chat/completions` とJSON object出力に対応するプロバイダーを想定する。サンプルWebアプリではSSEストリーミング（`stream: true`、`stream_options.include_usage: true`）への対応も必要となる。非ストリーミングへのフォールバックはなく、未対応のプロバイダーではWebアプリの回答が失敗する場合がある。Acceptヘッダーを省略したJSON APIは引き続き非ストリーミングで動作する。根拠の本文は設定された文章生成サービスにのみ送信される。検索だけではAIサービスへの通信は発生しない。

`workers_dev` は既定で `false`。利用するホスト名のrouteを設定するか、意図して `true` に変更してから `npm run deploy` を実行する。公開資料の検索・回答は認証なしで使える。フィードバック検索、同期、管理APIはBearer認証が必須。WebhookはHMAC-SHA256署名検証が必須。複数ユーザー向けのACLは実装していないため、このAPIトークンを他者に配布しないこと。

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

### PR プレビュー

同一リポジトリの PR は CI 成功後、`Preview PR` ジョブで本番 Worker の未公開バージョンをアップロードする。Actions のジョブ Summary にある **Open preview** から確認できる。URL は各アップロードに固定され、`pr-番号` のエイリアスも発行する。本番トラフィックの切り替えは行わない。

本番 D1、Cloudflare 登録済みの変数・Secrets、生成 AI を共有する。画面は PR のコードと静的ファイルで動作する。プレビュー専用の `src/preview.ts` は検索・回答・ヘルスチェック・認証済み同期状況の参照だけを許可し、同期、削除、Webhook は 403 を返す。Queue バインディングと Cron を除外し、既存 Worker の検証に必要なバックグラウンドハンドラーは処理を実行せず拒否する。リモートマイグレーションは実行しない。未適用のスキーマ変更に依存する PR は、本番スキーマとの互換性が必要になる。

既存の `production` GitHub Environment の Cloudflare Secrets と D1 ID、および `DECISIONRAG_DEPLOY_ENABLED=true` を再利用するため、キーの複製は不要。Environment のブランチ制限を設定する場合は、プレビュー対象の `refs/pull/*/merge` も許可する必要がある。本番ジョブ自体は引き続きデフォルトブランチだけで実行する。Cloudflare の既存 Worker では Version URLs（旧 Preview URLs）を有効にする。無効な場合、URL が取得できずジョブは失敗する。

本番資源へのアクセスを伴うため、fork と Dependabot の PR は対象外。同一リポジトリ内の信頼する変更に使用する。更新禁止はアプリの入口での制約であり、D1 自体の読み取り専用権限ではない。検索・回答の API 使用量とレート制限は本番と共有される。PR を閉じても発行済みの Version URL は自動削除されない。プレビュー用バージョンを手動で本番に昇格せず、マージ後の通常 CI に本番デプロイを任せる。

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
| POST | `/search` | 階層探索による根拠・出典・Rust判定トレース |
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

レスポンスには `evidence`（引用ID、ソースID、本文区間、URL、repo、状態等のmetadata、関連度）、`hit_count`（選択文書の中で関連ありと判定した本文区間の総数）、`trace`（ステージ、候補数、モデル、呼び出し数、使用トークン、時間）、`elapsed_ms` を含む。`timings` には公開範囲の確認、D1取得、Rust判定、回答生成、検索完了までの時間をミリ秒で記録する。`storage_ms` は検索中の辞書・文書候補・本文件数・本文のD1ホスト呼び出しを合計した経過時間（バインディングや直列化のオーバーヘッドを含む）。DB取得を伴うtraceは `elapsed_ms` を段階全体の時間として保持し、`storage_ms` と `local_ms` に分ける。`model_ms` はDB待ちを除いた判定ステージの時間を集計する。Workersの時計の更新粒度により同期処理が0msになる場合があり、厳密なCPU時間ではない。公開範囲を確認してからD1の候補を読み込む。検索はルールに基づく選別であり、意味的な網羅性は保証しない。予算超過は422として返す。

既定の生成モデルは1回の呼び出しで、質問への直接の回答（最大3文）だけを生成し、`answer` に返す。各チケット・資料別の要約は生成せず、`ticket_summaries` も返さない。生成に使用する根拠は上位20区間に限るが、検索結果の一覧は維持する。ローカル判定は回答の完全性を認定しないため、成功時も原則 `summarized` を返す。生成に失敗した場合や利用できる回答がない場合は `generation_unavailable` と検索結果を返し、資料別の抽出要約にはフォールバックしない。`generate_answer` ステージには、生成モデルと所要時間、プロバイダーが返した入出力トークン数を記録する。

サンプルWebアプリの回答はストリーミングで表示する。`POST /answer` に `Accept: text/event-stream` を指定すると、検索完了時の `sources`、生成途中の `draft`、出典検証後の `result` をSSEで返す。`draft` の `answer` は生成途中の文字列配列で、未検証の仮表示にのみ使う。回答の各文と引用IDの受信が完了した段階で、その文の引用リンクも表示する。未完・未知の引用IDは補完しない。`answer_citations` は各文の受信済み引用ID配列で、生成途中のリンク化はこの一覧に限定する。同一資料を連続して引用するピルは先頭の1つにまとめる（本文の引用IDと根拠一覧は保持する）。最終 `result` は従来のJSON応答と同じ構造であり、仮表示を必ず置き換える。途中の `error` イベントや `result` のない切断では仮表示を破棄する。ページ分割時は、そのページの検索完了後に生成を開始する。Acceptヘッダーを省略したAPI利用は従来のJSON応答を維持する。

### ページ分割

`/search`・`/answer` に `paginated: true` を指定すると、`pagination` に `page`、`total_pages`、`next_cursor` を返す。続きは同じ `query`・`include_feedback`・認証条件と `cursor: next_cursor` を送る。`next_cursor: null` が最終ページ。`total_pages` は評価前の本文区間を20件ずつ分けたページ数で、ページによって関連本文が0件になることもある。`hit_count`、回答は現在のページだけを対象とする。省略時のAPIは従来どおり選択文書の全本文を評価する。

カーソルは `API_TOKEN` を鍵として暗号化・認証し、初回検索から15分で失効する。公開リポジトリ一覧を取得する検索条件（認証なし、または `include_feedback` を明示した検索）では、継続時にもGitHubで最新の公開範囲を確認する。Bearer認証で `include_feedback` を省略する互換モードは索引全体を対象とし、公開範囲の変更を再確認しない。初回検索の計画に保存された文書について、本文・メタデータや公開範囲の変化で読み込まれる区間が変わった場合は `409 search_results_changed` を返し、再検索を求める。新たに公開された文書や、初回の計画で選択されなかった文書の追加・変更は検出せず、それだけでは409を返さない。不正・期限切れ・検索条件不一致のカーソルは `400 invalid_search_cursor`。`API_TOKEN` の変更でも既存カーソルは無効になる。

Webアプリの「前へ」は表示済みページをメモリから復元する。新しい検索・接続解除・再読み込みで破棄する。次ページでエラーが起きた場合は前の結果を残し、再試行できる。

`/answer` のstatus:

- `answered`: 質問に答える文章と引用IDを返した。
- `summarized`: 質問の一部について、資料で確認できた内容を引用ID付きで返した。
- `evidence_ready`: 根拠は十分と判定したが、生成モデルは未設定。
- `insufficient_evidence`: 根拠不足。回答はnull。
- `conflicting_evidence`: 同じ対象・時点について根拠が矛盾し、回答を検証できなかった。回答はnull。
- `verification_failed`: 生成結果を根拠検査で却下。回答はnull。
- `generation_unavailable`: 既定の生成モデルから利用できる回答を得られなかった。検索で得た資料は返す。

検索予算超過・WASM入力上限はHTTP 422、ローカル実行失敗は `503 local_decision_failed`。Decisionプロバイダーの容量不足・クォータ・レート制限は発生しない。公開検索のレート制限と文章生成サービスのエラー処理は維持する。SSE開始後の例外は `error` イベントになる。既定生成モデルが失敗した場合、利用可能な根拠から引用を返す。別途設定した外部生成サービスの接続エラーは従来どおり通知する。

## GitHub Webhook

Org Webhookまたは各リポジトリのWebhookを、デプロイ先の `/webhooks/github` に設定する。

- Content type: `application/json`
- Secret: `WEBHOOK_SECRET` と同じ値
- Events: Issues、Issue comments、Pull requests、Pull request reviews、Pull request review comments、Pushes、Repositories、Releases

重複配信は許容する。常にGitHub上の最新状態を取得してupsertする。Issue削除・移管、リポジトリ削除・移管のイベントで索引も削除する。同期失敗は最大5回再試行し、DLQに移る。`/sync/status` のエラーとDLQを監視し、原因解消後に再処理する。同期カーソルは「子ジョブの登録完了」を表すもので、取り込み完了を保証しない。

## 制限と次の評価

- 新規統合テストは実際のRust/WASMを実行する。既存の通信・ページ分割契約テストは `test/legacy-judge.ts` の旧判定モックを注入する。旧モデル専用テストの成功はローカル判定の精度証明ではない。
- 既定で選択枝内20,000文書、選択文書内4,000本文区間まで。超過は明示的に失敗する。文書候補をバッチ単位で評価するため、選択された文書が多いほどAPI呼び出し数が増える。
- `MAX_SCREENED_DOCUMENTS`（最大100,000）、`SUPPORT_THRESHOLD`、`CONFLICT_THRESHOLD` を環境変数で変更可能。
- 1ソース600KB、GitHubコメント等のページネーション100ページが上限。切り捨てず同期エラーにする。Gitツリーがtruncatedの場合も同期エラーにする。非常に大きい文書群・スレッドは追加の分割取り込みが必要。
- PR差分コード全体、GitHub Wiki、添付画像・PDF・外部リンク先、Releaseは取り込まない。
- Webhook停止中に削除されたIssueやアクセス権を失ったリポジトリは、差分巡回だけでは削除を検知できない。該当ソースを管理者が削除するか、DBを再構築して全件同期する。`/admin/purge` 後でも既存の同期ジョブや次回巡回で再登録されるため、恒久的な除外設定ではない。
- ジョブが古いGitHub状態を取得した直後に新しいジョブと競合すると、次の差分巡回まで一時的に古い内容になる場合がある。
- プロンプトインジェクションへの指示分離と署名検証は実装するが、モデルによる誤判定を排除できない。自動でIssue・PRを作成したりコードを書き換えたりする機能はない。

## 検証

```sh
npm run build:rust
npm run check
npm test
npx wrangler d1 migrations apply trainlcd-decision-rag --local
npx wrangler deploy --dry-run --outdir dist
```

テストは階層探索、共有コンテキストでの順位付け、予算超過、回答の引用と矛盾の検証、PR状態、フィードバックの重複排除、文書削除、Webhook署名・org境界、API認証と公開範囲の再検証を確認する。

## 参考

- Wan et al., [Retriever-Free Retrieval: Navigating Documents with Decision Models](https://arxiv.org/abs/2610.35868), 2026.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)


### PWA

HTTPSで開き、iOSでは共有メニューの「ホーム画面に追加」、Android・PCではブラウザーのインストール操作で追加できます。検索・回答には通信が必要です。初回オンライン起動後は、圏外での起動時に接続案内を表示します。

新バージョンは起動時、画面への復帰時、オンライン復帰時、表示中は1時間ごとに確認します。「更新する」を押した画面だけを再読み込みします。入力内容・検索結果・メモリ上の利用キーは更新時に消去されます。Service Workerはオフライン案内のHTML/CSSのみを保存し、API応答・検索結果・利用キーは保存しません。

`public/offline.html` / `public/offline.css` の変更時は `public/sw.js` のキャッシュバージョンを変更してください。他のフロントエンド変更でも更新を検知できるよう、CIはデプロイ前に公開ファイルの内容からService Workerのリビジョンを生成します。ローカルからデプロイする場合もnpmのdeployスクリプトを使用してください。


回答生成には最大20区間を渡し、検索順位に沿って各資料の先頭候補を優先してから同じ資料の追加区間を補う。検索結果の順位・全件数・引用IDは変えない。資料の更新日時・PRのマージ日時・文書のコミット情報を渡し、過去の制約と現在の対応範囲を区別するよう指示する。更新日時は実装・公開日時を意味せず、GTFSファイルの存在だけでもアプリへの対応・配信は証明しない。検索結果は網羅的な一覧ではないため、資料不足から「特定事業者のみ」「全国対応／非対応」と断定しない。これは生成指示の改善であり、資料間の意味的な矛盾を決定的に検出する保証ではない。

## 変更時の検証

検索・回答の変更は、PR作成前に本番と同じ資料・質問で精度と初回応答時間を実測する。テスト成功だけを動作確認とせず、プレビューの実ブラウザーでストリーミング、次・前ページ、エラーからの復帰を確認し、比較条件と取りこぼしを記録する。変更後に判定結果が変わった場合は再検証する。

## 同期由来の検索辞書

資料を保存すると `vocabulary` ジョブを登録し、Workers AI で本文区間ごとに略称・別名の候補を抽出する。検索中には抽出モデルを呼ばない。既存資料・未完了の抽出はリポジトリ同期時の `vocabulary_scan` で補完する。抽出に失敗しても資料の保存は維持し、通常の同期ジョブと同じ再試行・エラー監視を使う。Workers AI の `AI` バインディングが必要で、回答生成の外部プロバイダー設定とは独立している。

候補は原文の完全一致引用、両方の語、明示的な定義形式（`Wayfinder (WF)`、`X abbreviated as Y` など）をRustで確認して自動採用する。関連語の共起、推測した翻訳、否定・仮定を含む本文区間は採用しない。この保守的な形式チェックでも意味の正しさは保証しない。全区間の抽出が完了してから有効にし、資料の本文・タイトル変更時は古い対応を即座に無効化する。削除・purgeでも根拠と一緒に削除する。資料ID・URL・本文区間番号・内容リビジョン・根拠引用・採用日時を保存する。

固定辞書は維持し、DBの対応を検索スコアにだけ追加する。検索ごとに現在の公開範囲で辞書の根拠資料も絞り込み、非公開資料や対象外フィードバックの語彙を公開検索へ使用しない。展開は1段のみで、未知の識別子の直接一致を維持する。1検索で128組を超える候補は422 `vocabulary_expansion_budget_exceeded`。回答検証・実装済み・リリース済みの判定には動的辞書を渡さない。検索に関係する辞書の変更はページ継続時に409 `search_results_changed`となり、再検索を求める。

管理APIはいずれもBearer認証が必須で、PRプレビューでは禁止する。

| Method | Path | 内容 |
|---|---|---|
| GET | `/admin/vocabulary` | 根拠付きの対応一覧（先頭100件）と抽出進捗 |
| POST | `/admin/vocabulary/list` | `kind: entries / blocks / audit`、`offset`で続きを取得。`next_offset: null`が最終 |
| POST | `/admin/vocabulary` | `term`・`alias`・`blocked`・`reason`で対応を無効化／解除 |

誤った組み合わせは `{"term":"WF","alias":"Wayfinder","blocked":true,"reason":"別の意味だった"}` のように無効化する。組み合わせはNFKC・小文字化・順序統一して管理し、再抽出されてもブロックは残す。解除は同じ組み合わせに `blocked:false` と理由を指定する。変更履歴はaudit一覧で確認できる。候補一覧はオフセット方式なので、同期中に全件を確認するときは同期終了後に取り直す。

導入時は `0003_search_vocabulary.sql` を既存の本番マイグレーション手順で適用してからマージする。既存Workerとの互換性を維持する追加スキーマである。未適用のPRプレビューでは固定辞書だけで検索できるが、自動辞書の動作確認にはマイグレーション済みDBが必要。コード導入後の通常同期で既存資料も順次抽出する。初回は本文区間ごとに生成API使用量が発生する。
