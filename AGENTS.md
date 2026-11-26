# AGENTS.md — Akihiro Recruiting CRM

このリポジトリは、暁廣の2027年秋の米大学男子サッカー編入を支援する運用中のCRM。候補校比較、コーチとの連絡・返信・予約、学校別Research、閲覧反応を管理する。所有者向けの現行サービスを保守する。汎用化・複数ユーザー対応・iOS化は別プロジェクト。

**詳細な開発経緯や残タスクは `docs/HANDOFF.md` を参照すること。** 新規セッションの最初と、送信・返信・計測・Profile連携を扱う前に、該当箇所を読む。

## 構成

- `index.html`：GitHub Pagesで配信するHTML/CSS/JavaScript。候補校、地図、認証、個別CRM、返信・旧予約履歴。
- `activity.html` / `activity.js` / `activity.css`：活動単位の集計・文案・送信準備・予約／照合。共通の状態・日時・文面処理はルートのJS。
- `supabase/functions/`：Deno/TypeScriptのEdge Functions。Gmail API/OAuth、Gemini文案、予約処理・返信同期。共通ロジックは `_shared/`。
- `supabase/migrations/`：DB変更履歴。適用済みのものは書き換えない。`supabase/operations/` と `docs/` に運用資料、`tests/` に回帰テストと表示用fixture。公開Profileは別リポジトリでDB連携がある。

## 開発の進め方

- 日本語で相談する。最初に現在の画面・コードと期待する動作をすり合わせる。方針が決まったら、作業ブランチの作成、実装、関係するテスト、差分の確認をまとめて進める。通常の作業に逐次確認は不要。PRを頼まれたら作業ブランチからドラフトPRを作る。GitHubの最新 `main` を起点とし、未コミットの作業は上書きしない。
- ローカルの `python3 -m http.server 4177 --bind 127.0.0.1` も本番Supabaseに接続する。見た目や操作の検証はまずモック／fixture。Test Modeは分離環境ではない。実メール（固定テスト宛先を含む）、予約、送信可否フラグ変更、本番DB更新、Gmailへの書き込み、マージ・本番デプロイは、対象と操作を明示した承認があるときだけ行う。
- 通常の一括送信は「活動状況・送信準備」の経路を使う。学校の別コーチを含め返信があれば当該校の通常送信・Follow-upを止め、個別対応に回す。既存予約・未確定の送信・宛先／スレッド変更・取得失敗では安全側に止める。UIの候補判定でサーバー側ガードを置き換えない。
- 送信不明は自動再送しない。Gmail送信済みとCRMを照合し、ラベル失敗はラベルだけを再同期する。キュー行の削除や状態の書き換えで再送可能に戻さない。通常は初回→Follow-up #1→#2まで。個別返信・返信後の個別Follow-upは別の導線で扱う。
- 秘密値、OAuthトークン、個人連絡先、実メール本文、追跡トークン、運用中データをGit・PR・チャット・ログに貼らない。公開リポジトリには一般化した例だけを載せる。

## テスト

リポジトリ直下で Node.js 24以上。基本の回帰確認：

```sh
node tests/followup-safety.cjs
node tests/coach-flow.cjs
git diff --check
```

活動の送信・照合を変更したら `tests/campaign-worker.cjs`、`tests/campaign-send-control.cjs`、`tests/campaign-reconciliation.cjs`、`tests/campaign-preparation.cjs` 等から影響範囲を追加する。SQLテストは承認された隔離DBで行う。テストと実送・本番確認は報告で区別する。
