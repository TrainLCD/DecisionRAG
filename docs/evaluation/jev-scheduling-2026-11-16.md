# Jevバッチ待機方式の修正（#59）

## 対象と変更

基点: `69ea539eaa77435ff0ec42f704085d10dacefeac`。
実装: `b1527e4`。4件ずつの `join_all` を、上限4の `buffer_unordered` に変更。
完了した枠を補充し、最後に元のバッチ順へ戻してからスコアで安定ソートする。
候補、バッチ境界、リクエスト本文、モデル、閾値、予算は変更していない。
API呼出し数や入力トークン数を減らす修正ではない。

## ローカル検証

- `cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace --locked`: 成功。
- 追加の制御可能な非同期Hostテスト: 8バッチ中、最初の4件のうち2件目だけを完了させると5件目を開始。同時実行の最大は4。全件同点でも元の順序を維持し、8呼出し・入力80・出力8の利用量を保持。
- `npm run build:pwa`、`npm run build:rust`、`npm run check`: 成功。
- `npm test`: 実WASMを含む157件、UI等31件が成功。
- `node --test scripts/evaluation/*.test.mjs`: 10件成功。
- ローカルD1マイグレーション3件、`wrangler deploy --dry-run`: 成功。
- ブラウザーテスト: 環境のソケット作成制限によりChromiumが起動失敗（`socket() failed: Operation not permitted`）。ブラウザー検証成功とは扱わない。

## 実サービスの比較状況

基点の本番デプロイに対応するバージョンURLで「バス対応の網羅率」を1回検索。
候補3,382件、40ヒット、応答内elapsed_msは14,349ms、クライアント全体は21,758ms。
文書選択219回・7,316ms、集計判定1回・57ms、対象照合35回・1,148ms、本文評価12回・349ms。
ユーザー画像の原質問は不明であり、画像の19,042msとの同条件比較ではない。

変更後のプレビューは未作成。リモートpushが自動承認審査で拒否されたため、実サービス上の短縮幅、同一資料による実モデル精度比較、プレビューのSSE・ページ送り・エラー復帰、CI・CodeRabbitレビューは未確認。
ローカル回帰テストのみを根拠に、本番の19秒を解消したとは扱わない。
