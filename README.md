# TrainLCD DecisionRAG

TrainLCD org の Issue・PR・リポジトリ文書・ユーザーフィードバックを、Jevで階層的に探索するヘッドレスAPI。Cloudflare Workers + D1 + Queues、TypeScript製。

検索方式は **[Retriever-Free Retrieval: Navigating Documents with Decision Models](https://arxiv.org/abs/2610.35868) の §3・Algorithm 1 に基づく階層ナビゲーション**。Embedding、ベクトルDB、BM25、FTSによる候補の事前絞り込みは行わない。D1は文書・階層・本文区間の保存に用いる。

## 検索方法

1. `リポジトリ × 種類` の枝を、説明付きでJevに提示する。
2. 同じコンテキスト内で各枝をNoul質問として評価し、上位6枝を展開する。
3. 選んだ枝の**全ての文書タイトル**をページ単位で評価し、全体の上位12文書を残す。
4. 文書の本文区間を共有コンテキストで評価し、上位20区間を残す。
5. 最終候補を同じコンテキストで再評価し、Choiceの確率で並べ替えて上位10区間を返す。

これは論文手法をGitHubの構造に適用した初期実装であり、論文ベンチマークの再現ではない。大きな候補集合は最大60候補・70,000文字単位に分割する。候補間の比較条件を揃えるため、最終候補を共有コンテキストで再評価する。本文は見出し・段落を優先し、最大2,400文字の区間に分割する。論文の公開コーパスに対する精度・時間をTrainLCDに対して保証するものではない。

`/answer` では検索後に別途Jevで根拠の十分性・矛盾を判定する。これは検索本体とは別の追加機能。十分な根拠がある場合だけ任意の生成モデルに渡し、引用ID検査とJevによる生成結果検査を通った文章を返す。生成モデル未設定なら `evidence_ready` と根拠だけ返す。

## 情報源と同期

| 対象 | 内容 |
|---|---|
| org内Issue | 本文、全コメント、状態、ラベル、投稿者 |
| org内PR | 本文、会話、レビュー、インラインレビュー、変更ファイル名、マージ日時、マージ先ブランチ |
| 各リポジトリ文書 | デフォルトブランチの `.md`, `.mdx`, `.rst`, `.adoc`, `.txt`。vendor/build等を除外 |
| `TrainLCD/Issues` | 同じIssueを重複登録せず `feedback` として保存 |

初回 `POST /sync` でorg内のアクセス可能なリポジトリを列挙し、Queuesで分割取り込みする。6時間ごとのCronとWebhookで更新する。Issue/PRの差分巡回には10分の重複期間を設ける。文書のURLはコミットSHA固定。文書削除は完全なツリー取得後に反映し、古いコミットのジョブは破棄する。

**マージとリリースは別扱い。** 現段階ではRelease・ビルド配信状況を取り込まないため `release_status: unknown` を保存する。PRのマージだけを根拠に「公開版で修正済み」と断定しないよう評価・生成の両方に指示する。これはモデルの無誤答を保証する仕組みではない。

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

- `API_TOKEN`: 自分専用APIのBearerトークン。十分長いランダム値を設定する。
- `WEBHOOK_SECRET`: GitHub Webhookと同じ値。
- `GITHUB_TOKEN`: org内対象リポジトリのMetadata・Contents・Issues・Pull requestsの読み取り権限が必要。リポジトリ作成・書き込み権限は不要。
- `TYPESAFE_API_KEY`: Jevのキー。[公式APIドキュメント](https://docs.typesafe.ai/api/system-one)を参照。

任意の文章生成を使う場合は、`ANSWER_MODEL`・`ANSWER_BASE_URL` を設定し、`wrangler secret put ANSWER_API_KEY` を実行する。OpenAI互換の `/chat/completions` とJSON object出力に対応するプロバイダーを想定する。根拠の本文がJevへ、生成有効時は生成プロバイダーにも送信される。

`workers_dev` は既定で `false`。利用するホスト名のrouteを設定するか、意図して `true` に変更してから `npm run deploy` を実行する。検索・同期・管理APIはBearer認証が必須。サンプル画面と `/health` は認証なしで開ける。WebhookはHMAC-SHA256署名検証が必須。複数ユーザー向けのACLは実装していないため、このAPIトークンを他者に配布しないこと。

ローカル開発:

```sh
cp .dev.vars.example .dev.vars
# .dev.varsの値を自分のキーに設定する
npm run db:local
npm run dev
```

`.dev.vars`、`.env`、ローカルD1データはgit対象外。

## サンプルWebアプリ

`npm run dev` で表示されるローカルURLの `/` を開き、設定した `API_TOKEN` で接続する。サンプルはWorkerと同じオリジンから配信され、利用キーはページのメモリ内でのみ保持する。検索モードは「資料を探す」と「資料から回答する」から選べる。ヘッダーのメニューから取り込み状況を確認できる。

### 本番の自動デプロイ

既存の `trainlcd-decision-rag` Worker を対象にする。有効化の前に、公開中の Worker のソースをデフォルトブランチへ取り込み、D1、Queues、Cron の設定が `wrangler.jsonc` と一致することを確認する。

1. GitHub Actions の `production` 環境に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を Secrets として登録する。デプロイ先ブランチはデフォルトブランチに限定する。
2. 同じ環境の Variables に、既存の本番 D1 の ID を `DECISIONRAG_D1_DATABASE_ID` として登録する。
3. リポジトリの Actions Variables に `DECISIONRAG_DEPLOY_ENABLED=true` を設定する。

有効化後は、デフォルトブランチが更新されると CI を実行し、成功した最新コミットを Wrangler でデプロイする。Worker に登録済みの環境変数と Secrets を使用する。

## API

| Method | Path | 役割 |
|---|---|---|
| GET | `/health` | プロセスの生存確認。外部サービス疎通は確認しない |
| POST | `/sync` | 全リポジトリの同期をキューに登録 |
| GET | `/sync/status` | 同期ジョブ、失敗、ソース数、最終同期カーソル |
| POST | `/search` | 階層探索による根拠・出典・Jev判定トレース |
| POST | `/answer` | 根拠の評価と、任意の生成・検証 |
| POST | `/admin/purge` | `{"repo":"TrainLCD/Example"}` の索引を削除 |
| POST | `/webhooks/github` | GitHubイベント受信。署名必須 |

```sh
curl "$RAG_URL/sync" -X POST -H "Authorization: Bearer $RAG_API_TOKEN"
curl "$RAG_URL/search" \
  -H "Authorization: Bearer $RAG_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"query":"地下で位置更新が止まる問題について、どんな対応が議論された？"}'
```

`/search`・`/answer` の入力は `{"query":"..."}` のみ。1〜1,500文字。

レスポンスには `evidence`（引用ID、ソースID、本文区間、URL、repo、状態等のmetadata、関連度）、`trace`（ステージ、候補数、モデル、呼び出し数、使用トークン、時間）、`elapsed_ms` を含む。検索はソース間の網羅的な調査を保証せず、各階層の上位予算により枝刈りする。

`/answer` のstatus:

- `answered`: 文章と引用IDを返した。
- `evidence_ready`: 根拠は十分と判定したが、生成モデルは未設定。
- `insufficient_evidence`: 根拠不足。回答はnull。
- `conflicting_evidence`: 同じ対象・時点について矛盾。回答はnull。
- `verification_failed`: 生成結果を根拠検査で却下。回答はnull。

外部APIの失敗はHTTP 502。検索予算超過はHTTP 422。これらを根拠不足や成功と置き換えない。

## GitHub Webhook

Org Webhookまたは各リポジトリのWebhookを、デプロイ先の `/webhooks/github` に設定する。

- Content type: `application/json`
- Secret: `WEBHOOK_SECRET` と同じ値
- Events: Issues、Issue comments、Pull requests、Pull request reviews、Pull request review comments、Pushes、Repositories

重複配信は許容する。常にGitHub上の最新状態を取得してupsertする。Issue削除・移管、リポジトリ削除・移管のイベントで索引も削除する。同期失敗は最大5回再試行し、DLQに移る。`/sync/status` のエラーとDLQを監視し、原因解消後に再処理する。同期カーソルは「子ジョブの登録完了」を表すもので、取り込み完了を保証しない。

## 制限と次の評価

- Jevキーと実データを使った精度・速度・料金の評価は未実施。テストのJev・生成・GitHub通信はモック。しきい値は暫定値であり、日本語の実質問で調整する。
- 既定で選択枝内20,000文書、選択文書内4,000本文区間まで。超過は明示的に失敗する。文書候補はページ単位で評価するため、大きい枝ほどAPI呼び出し数が増える。論文の実験と同じ速度は見込まない。
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

テストは階層探索、共有候補コンテキスト、予算超過、根拠不足での生成停止、引用検証、PR状態、フィードバックの重複排除、文書削除、Webhook署名・org境界、API認証を検証する。

## 参考

- Wan et al., [Retriever-Free Retrieval: Navigating Documents with Decision Models](https://arxiv.org/abs/2610.35868), 2026.
- [TypeSafe API](https://docs.typesafe.ai/api/system-one)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
