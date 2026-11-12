# Rustでのローカル判定への移行

## 実装した範囲

- `rust/lib.rs` / `rust/rules.rs`: 正規化、日英用語対応、間接的な技術の手掛かり、未知の日本語名、技術識別子と番号の一致、関連度と安定した順位付け、同一検索範囲内の参照文書の1段展開、引用検査、原文抽出。
- `backend/src/`: HTTPルーティング、認証、Webhook HMAC、公開範囲、D1 SQLとスナップショット、GitHub同期、リリース祖先判定、Queue再試行、暗号化カーソル、検索、生成レスポンス検査、SSE解析。
- `src/host.ts` / `src/worker.ts`: CloudflareバインディングとWeb APIのI/Oだけを接続する薄いホスト。ドメイン処理はRust/WASMを呼ぶ。
- 判定はCPUのみ。モデル重みの取得・推論サーバー・GPU・Decision APIキーは不要。
- 文書は540件単位で読み込み、64候補ずつ採点する。全許可範囲を走査し、予算超過は422。選択後の文書に属する本文区間を、本文取得の前に合算する。4,000区間を超えた場合は422 `passage_screening_budget_exceeded` とし、文書やヒット件数を黙って切り詰めない。取得中に件数が変わった場合も既存の取得側ガードで拒否する。
- Webの10件ずつのページ送り、全件数、総ページ数、ページ送り時に検索・生成を繰り返さない仕様は変更しない。APIの旧カーソルモードは既存の20区間単位を維持する。

## 判定の意味

これは学習済みモデルの再現ではない。ルールのバージョンは `rust-rules-v1`。スコアは校正された確率ではなく、概念のカバー率と見出し一致による順位・選別の指標。CLIでは各候補の `matched` / `missing` を返す。既存APIの `relevance` と内部の `probability` は互換名として残す。

意味の近い文だからといって裏付け済みとしない。原文の文全体と一致する主張は出典への帰属だけを確認する。知らない引用IDや検出可能な否定・条件の反転、対象の違う数値の流用は拒否する。言い換えは引用先との関連性とローカルルールで扱い、意味的な支持を証明できない場合も、矛盾と同一視して一律に削除せず `semantic_status: unknown` として返す。回答の完全性と意味的な矛盾検出は `unknown`。旧数値フィールドの0を「矛盾が存在しない確率」と解釈してはいけない。

生成した回答が検証を通らない場合は、根拠中の最大400文字の一文をそのまま「資料の記載」として返す。要約対象は従来どおり上位20区間。生成サービスのない構成でもこの引用を返す。文章生成用のWorkers AIまたは外部生成サービスは残る。生成途中のdraftは従来どおり仮表示であり、最終resultに置き換える。

語句の類似やルールを通過したことは、意味的な裏付けの証明ではない。`semantic_status: unknown` は回答の完全性や意味的な矛盾がないことを保証しない。一般的な矛盾、因果関係、時間・バージョンをまたぐ解決状況を完全に判定するものではない。

## 検証と実測

2026-11-12、現行本番の公開検索から取得した測位35区間とウィジェット4区間、公開PR #7403の本文1区間を保存。全40区間の再現可能な入力は `test/fixtures/public-passages.json`。

- 旧API: 「地下鉄で位置更新が止まる問題」35件、サーバー13,911ms、HTTP全体24,519ms。「ウィジェットの駅番号の表示」4件、HTTP全体17,263ms。
- 「バスの乗換案内と音声読み上げ」は503 `decision_capacity_exceeded` となり比較不能。
- ネイティブRustとWASMの6質問の結果が一致。40区間の採点中央値は約3ms。詳細は `evaluation/rust-local.json`。
- SQLiteでD1を模した実API経路では、測位27件・中央値約16ms、ウィジェット3件・約12ms、バス2件・約12ms。詳細は `evaluation/rust-local-api.json`。
- 複数観点の質問に対して1語だけで採用しないよう改訂した結果、旧APIの測位35区間のうち27区間、ウィジェット4区間のうち3区間を採用する。旧結果との完全一致は保証しない。

**上記は旧検索の返した資料を多く含む偏った小規模コーパス**。旧モデルの結果を正解ラベルとはみなさない。語彙調整にもこの資料を使用したため、未知の質問での精度保証ではない。全本番索引の再現率・適合率・Workers CPU時間・ピークメモリは未測定。ローカルAPIの計測はリモートD1、GitHubの公開範囲確認、文章生成、ネットワークを含まず、本番との単純な速度倍率は出さない。

Rustのテストでは日英の照合、番号境界、未知の駅名、同点順序、参照範囲、否定・条件・配信済みの捏造拒否を確認。新しい統合テストは本物のWASMで全41件の保持、Decision通信0回、公開範囲の隔離、SSEと引用への復帰、繰り返しのメモリ確保を確認する。

既存のモデルモックを利用するテストは `test/legacy-judge.ts` へ隔離し、`test/reference/` に保存した旧実装のテスト用注入で認証・同期・ストリーム・既存API契約を検証する。本番コードから旧判定器への参照はない。旧モデル専用のテストはRust精度の証拠には含めない。

実ブラウザー検証を試みたが、Chromiumが `socket() failed: Operation not permitted` で起動できなかった。Playwright用ブラウザー取得も破損アーカイブで失敗した。jsdomで実際のHTML/JSを実行する既存のページ送り・ストリーム回帰検証は成功したが、実ブラウザーでのプレビュー確認の代わりとは扱わない。

## 再現方法

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
npm run build:rust
npm run check
npm test
npx wrangler deploy --dry-run --outdir dist
cargo build --release --bin decision-rag
node scripts/evaluate-local.mjs
node --loader ./scripts/wasm-test-loader.mjs scripts/benchmark-local-api.mjs
```

ネイティブCLIは標準入力・標準出力のJSON Lines。通信は行わない。

```sh
printf '%s\n' '{"op":"score","query":"バックグラウンドの測位","candidates":[{"id":"one","description":"Continue GPS location updates in background"}]}' | target/release/decision-rag
```

ローカル画面確認用（実資料の抜粋、GitHub公開範囲を固定したテスト環境、生成AIなし）:

```sh
node --loader ./scripts/wasm-test-loader.mjs scripts/local-fixture-server.mjs
# http://127.0.0.1:8787
```

## 本番切り替え前に残ること

全索引と未知の質問での比較、正解ラベルを持つ否定例の充実、Workers上のCPUとメモリ計測、実ブラウザーのプレビュー確認。生成文を原文引用へ戻す挙動の確認も必要。自動マージ・本番切り替えは行っていない。

## Rustヘッドレス実装の検証

`test/rust-api.test.ts`、`test/rust-sync.test.ts`、`test/local-decision.test.ts`、`test/preview.test.ts` は本番と同じRust/WASMを実行する。認証・公開範囲・結果全件保持・カーソル改竄と期限・更新検知・Webhook署名・pending review除外・リリース祖先・文書スナップショット・Queue再試行・読み取り専用プレビューを検証する。旧TypeScript実装は `test/reference/` に隔離し、本番にはバンドルしない。

`npm run test:browser` は実Rust/WASMとSQLiteのフィクスチャサーバーを使い、ChromiumでSSE、総件数、10件ずつのページ送り、再検索・再生成なし、0件検索を確認する。CIにスクリーンショットと結果JSONを保存する。

カーソルのAES-GCM暗号形式は旧実装と互換だが、索引リビジョンの正規化が変わるため切り替え前の有効カーソルは409で検索やり直しになる。Webのページ送りはカーソルを使わないため影響しない。

合成索引の走査ベンチマーク（`scripts/benchmark-index.mjs`）では、末尾だけが一致する20,000文書を省略なく検索できた。ローカルSQLite・同一WASM isolateで約789ms、WASM線形メモリ約66.6MiB。ホストJS・SQLiteのメモリおよびリモートI/Oは含まない。詳細は `evaluation/rust-index.json`。

## 本番索引で見つかった誤検出と修正

最初の読み取り専用プレビューで公開3,342文書を検索すると、測位の質問に393区間を返した。旧APIの35区間は全て含んだが、画面上の位置・URLのlocation・レビュー中の単独GPS言及も拾っていた。そこで「位置」「location」を無条件の測位別名から外し、複数観点の質問では2つ以上の特徴を必要とするよう修正した。引用された文やコード中の単語だけで意味的関連性を保証しない。

取得した393区間を再投入するオフライン確認では49区間となり、旧APIから8区間が外れた。これは完全索引の再実行でも正解ラベル付きの精度評価でもない。差分は `evaluation/full-index-smoke.json`。旧結果を保持するためだけの例外ルールは追加しない。

CI上のChromiumでは、実Rust/WASM + SQLiteでSSEと10件ずつのページ送り、再生成なし、0件検索が成功した（run 43192158719）。ローカルのブラウザー起動制限と区別して扱う。

改訂後の本番索引プレビュー（d7d0b9a）では同じ質問に40区間、サーバー計測5,454ms、Decision API呼び出し0回を確認した。取得済み393区間のオフライン確認49件とは入力・文書選別が異なる。旧検索と同じ結果や意味的精度の保証としては扱わない。

文書候補の抜粋では複数観点の一致を必須にせず、本文区間の最終判定で適用する。長い文書の冒頭や間引き抜粋に検索語が揃わないだけで候補全体を捨てることを防ぐ。チケット番号の厳密一致条件はどちらの段階でも維持する。
