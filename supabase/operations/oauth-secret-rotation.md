# Gmail OAuthシークレット更新の影響範囲

確認日: 2026-10-13。利用者が新しいSecret・Refresh tokenを保存し、サーバーからの認証と実送信を確認済み。秘密値は記録しない。

## 更新先

既存のGoogle OAuthクライアントにAdd Secretで新しいシークレットを追加する。Client IDは維持する。

| 場所 | 設定 |
| --- | --- |
| OAuth Playground | Use your own OAuth credentialsを有効にし、同じClient IDと新しいClient secretを入力 |
| Supabaseプロジェクト `cjrabdfdtrufbpjmqddh` のEdge Function Secrets | `GOOGLE_OAUTH_CLIENT_SECRET` を新しい値へ更新 |
| 同じSupabase Secrets | 公開中へ切替後に再認証して取得した `GOOGLE_OAUTH_REFRESH_TOKEN` を保存 |

新しいシークレットとRefresh tokenは同じ保存操作で更新する。取得値はチャット・スクリーンショット・Gitへ出さず、作成時にパスワードマネージャー等へ保管する。

## 共通設定を使う稼働中の8関数

デプロイ済みの各関数と依存ファイルを読み、すべてが `GOOGLE_OAUTH_CLIENT_SECRET` を環境変数から取得することを確認した。

| 関数 | 影響する機能 |
| --- | --- |
| `recruiting-gmail-initial-send` | 初回送信 |
| `recruiting-gmail-followup-send` | 個別の通常Follow-up |
| `recruiting-gmail-reply-send` | Coachへの個別返信 |
| `recruiting-gmail-conversation-followup-send` | 会話Follow-up |
| `recruiting-gmail-replies` | 定期・手動の返信同期 |
| `recruiting-gmail-label-sync` | Gmailラベル同期 |
| `recruiting-gmail-followup-batch-prepare` | 送信予約案のGmail確認 |
| `recruiting-gmail-followup-batch-worker` | 予約送信とラベル再試行 |

確認専用の `recruiting-tracking-check` も同じ共通設定で検証し、削除済み。

Supabaseの共通Secretの更新はこれらにまとめて反映される。関数ごとにSecretを入力したり、コードへ値を書いたりする必要はない。Secret更新だけでの再デプロイも不要。

## その他の依存

- 稼働中Cronは返信同期10分ごとと予約Worker1分ごと。Gmailの認証は呼出先関数で行う。
- VaultにはWorkerのURL・呼出用Secretと返信検知の呼出用Secretがあり、GoogleのClient secretは保存されていない。これらは別の認証設定。
- CRM画面はSupabase Authのメール・パスワードでログインする。Gmail連携用Secretは画面に直接保存されない。
- 現行の文面下書きは `GEMINI_API_KEY` を使う。Google OAuth Client secretと別の設定。
- 公開ProfileはSupabaseへの問い合わせ登録を行う。公開配信元ソースに、Google OAuth Client secret・Gmail API・OAuth token更新への参照は見つからない。
- 調査対象はこのCRMのSupabaseプロジェクトと公開Profile。別の外部アプリで同じOAuthクライアントを使っている場合の依存は、この調査では確定できない。

## 旧Secretを無効化する前に

1. 新しいSecret・Refresh tokenをSupabaseへ保存する。
2. Gmail認証と送信アカウントを確認する。
3. 返信読取・ラベル取得と、固定テスト宛先での送信を確認する。
4. 同じOAuthクライアントを使う別アプリがある場合は、そちらの設定も新しいSecretへ更新する。
5. 移行確認後に9月28日作成の旧Secretを無効にする。

今回の確認: コード・デプロイ済み依存・Cron・Vault名の読取、サーバー環境変数を使ったOAuth更新、Gmailアカウント・ラベル読取、返信同期、固定テスト宛先への実送信2通・本文読戻し・ラベル更新を実施。Google Secret値をチャットやソースへ出していない。

旧Secretの無効化は未実施。認証成功だけでは、Google側で新旧のどちらを入力したかは識別できない。利用者による新値の保存確認後に旧Secretを無効化し、必要に応じて認証を再確認する。

参考: [GoogleのSecretローテーション](https://support.google.com/cloud/answer/15549257?hl=en)、[SupabaseのSecret更新](https://supabase.com/docs/guides/functions/secrets#production-secrets)。
