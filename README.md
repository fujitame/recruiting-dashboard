# Akihiro Recruiting CRM

Akihiroのリクルーティング活動を管理する、運用中のWeb CRMです。
このリポジトリでは現行システムの保守・改善を行います。
複数ユーザー対応やiOS製品の開発は、別リポジトリ・別プロジェクトで行います。

## 構成

- `index.html`: 認証、学校一覧・地図、個別CRM、AI文案、Gmail送信、送信予約。
- `supabase/functions`: Gmail連携とAI文案生成。共通の送信保護・ラベル処理は `_shared`。
- `supabase/migrations`: 適用済みDB変更の履歴。古い版も再現・復旧のために保持。
- `supabase/operations`: 稼働状況、外部連携、予約送信の運用情報。
- `tests/followup-safety.cjs`: Gmail通信をモック化した安全性の回帰テスト。

フロント配信: [GitHub Pages](https://fujitame.github.io/recruiting-dashboard/)

## ドキュメント

- [現行構成と整理記録](supabase/operations/system-inventory.md)
- [送信予約のステージと安全性](supabase/operations/followup-safety.md)
- [予約WorkerのCron設定](supabase/operations/followup-batch-worker-cron.sql)

## 保守方針

- 学校内の返信があれば、同校の通常Follow-upを停止する。
- 通常Follow-upは初回送信→#1→#2まで。その後は個別対応。
- Test Modeは実運用の改善確認に利用する。学校900–902への予約は固定テスト受信先へ送る。
- 確認不能な送信結果を自動再送しない。
- データのあるテーブルや共有プロフィール連携は、依存を確認してから廃止する。
- 秘密鍵、OAuthトークン、メール本文をGit・運用ログに保存しない。

## ローカル表示

`python3 -m http.server 4177 --bind 127.0.0.1` で起動し、`http://127.0.0.1:4177/` を開きます。
ローカル表示でも現在のSupabase本番へ接続します。Test Mode OFFで送信・予約すると実際のCoach宛てになります。

安全性テストを実行する場合はNode 24以上で `node tests/followup-safety.cjs` を使います。
