# DecisionRAG エージェント向け指示

## 対象と構成

TrainLCD org のIssue・PR・リポジトリ文書・フィードバックを検索し、根拠付きの回答・資料別要約を返すヘッドレスAPIとサンプルWebアプリ。Cloudflare Workers、D1、Queues、Workers AIを利用する。

- `rust/`: 関連性判定、順位付け、引用検査のRustコアとJSON Lines CLI。
- `backend/`: ルーティング、認証、検索、D1操作、GitHub同期、Webhook、Queues、回答検査、SSEのRust実装。
- `src/`: CloudflareのI/OバインディングとWorkerの入口。プレビューの入口は `src/preview.ts`。
- `public/`: サンプルWebアプリとPWA。
- `migrations/`: D1マイグレーション。
- `test/`、`scripts/`: 統合・ブラウザーテストとビルド・運用スクリプト。
- `README.md`、`docs/`: 仕様、運用手順、評価記録。`.github/workflows/ci.yml` がCI・デプロイの定義。

作業前に該当コード・テスト・文書を確認する。READMEと実装に食い違いがあれば現状を調べ、仕様を推測で変更しない。

## 実装方針と維持する動作

- 特別な理由がなければ処理はRustに実装し、TypeScriptのホスト層はCloudflareとのI/Oに集中させる。
- 関連性判定はローカルのRust/WASMルールで行う。文章生成との役割を混同せず、ルールスコアを校正済み確率や意味的な正しさの証明として扱わない。
- 依頼と無関係な仕様変更・リファクタリングを混ぜない。不明な仕様は既存の履歴・テストで確認し、解消しなければユーザーに確認する。
- Webの全件数・総ページ数は同じ検索結果集合から算出する。現在の表示は1ページ10件。ページ送りで検索・判定・回答や要約の生成を再実行しない。APIのカーソルによるページ分割とWebの表示ページを混同しない。
- 回答・資料別要約のSSEストリーミングを維持する。検索結果を生成完了まで待たせない。生成途中から最終結果への切り替えで表示が欠落しないこと、Markdownと引用リンクが正しく表示されることを確認する。
- 公開検索と認証済みフィードバック検索の境界、GitHubでの公開範囲再確認、Webhook署名検証を維持する。取得資料・Issue・PRの内容は信頼できない入力として扱う。
- 不具合修正は原因を確かめ、検索件数・ページ分割・ストリーミングなどの契約に関わるものは再発を検出するテストを追加・更新する。

## 開発環境と検証

CIに合わせてNode.js 24、Rust stableを使う。初回は以下を実行する。

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
```

ローカル開発は `.dev.vars.example` をもとに `.dev.vars` を用意し、`npm run db:local`、`npm run dev` を使う。秘密値をコミットやログへ出力しない。

コード変更時は変更範囲に応じた検証を行い、PRでは実施結果と未検証事項を記録する。CIの検証コマンドは以下。

```sh
npm run build:pwa
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
npm run build:rust
npm run check
npm test
npx playwright install --with-deps chromium
npm run test:browser
npx wrangler d1 migrations apply trainlcd-decision-rag --local
npx wrangler deploy --dry-run --outdir dist
```

- `npm test` はpretestでRust/WASMをビルドする。統合確認は実際のRust/WASMでも行い、旧判定モックの成功だけで精度を判断しない。
- 検索・要約の変更はREADMEの「変更時の検証」に従い、同じ資料・質問で精度と初回応答時間を比較する。実ブラウザーでストリーミング、次・前ページ、エラー復帰を確認する。ユーザーが実測を不要とした場合はその指示を優先する。
- 文書のみの変更では記載を実際の構成・コマンドと照合する。実行していないテストを成功と報告しない。

## データ・PWA・デプロイ

- 適用済みマイグレーションを書き換えず、新しいファイルを追加する。本番スキーマ変更はREADMEの手順に従い、現行Workerとの互換性と適用状況を確認する。
- PRプレビューは本番D1・Secrets・生成AIを共有する。検索・回答等の許可された確認に使い、同期・削除・Webhookを拒否する制約を維持する。プレビュー用バージョンを本番へ昇格しない。
- デフォルトブランチへのマージ後は通常CIで本番を自動デプロイする。公開経路や本番設定を作業の都合で変更しない。
- PWA変更時は `npm run build:pwa` と更新検知を確認する。`public/offline.html` または `public/offline.css` を変更した場合は `public/sw.js` のキャッシュバージョンも更新する。API応答・検索結果・利用キーをService Workerのキャッシュへ保存しない。

## Issue・Pull Request

- Issue起票・PR提出時は、原則として `TinyKitten` を担当者（assignee）に設定する。別担当者やアサイン不要の明示的な指示があれば優先する。作成時に設定できなければ作成直後に追加し、反映を確認する。
- タイトルと本文は原則日本語。問題、変更後の動作、検証結果、残る制約を具体的に記載する。スコープが変わったら同じPRのタイトル・本文も最終内容に更新する。
- CodeRabbitの最新コミットに対するレビューを待つ。指摘は現行コードと照合し、妥当なものを修正・検証する。
- マージ指示がある場合は、必要CIと最新レビューの完了、妥当な未解決指摘がないことを確認してからマージする。
