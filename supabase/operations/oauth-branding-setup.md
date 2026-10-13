# Google OAuthブランディングの入力

対象: Akihiroの現行CRM。2026-10-13。

## 入力値

| 項目 | 値 |
| --- | --- |
| アプリ名 | Akihiro Recruiting Dashboard |
| ユーザーサポートメール | fujiakihiro8@gmail.com |
| アプリケーションのホームページ | https://fujitame.github.io/recruiting-dashboard/about.html |
| アプリケーションプライバシーポリシーリンク | https://fujitame.github.io/recruiting-dashboard/privacy.html |
| アプリケーション利用規約リンク | https://fujitame.github.io/recruiting-dashboard/terms.html |

Profileの紹介ページではなく、Gmailと連携するCRMの説明ページを使う。3ページはログイン不要で、ホームページからポリシーと規約へ直接リンクする。CRMのログイン画面とフッターにも案内リンクを置く。

## 公開とドメイン

3ページがGitHub Pagesで公開されたことを確認してから入力する。承認済みドメインの候補は `fujitame.github.io`。URLや `/recruiting-dashboard/` をこのドメイン欄に入れない。`github.io` 全体を自分の所有ドメインとして登録しない。

Google Cloudでドメインを受け付けるか、Google Search Consoleの所有権確認が必要かは、実際の検証結果で判断する。現在の公開URLの用意だけでブランド審査やドメイン所有権の検証が完了したとは扱わない。共有ホストで認められない場合は、自分で管理する独自ドメインを検討する。

Google Cloudのブランディング設定を保存し、AudienceからIn productionへの切替を再実行する。個人利用の審査免除と、公開ページ・ドメイン等のブランディング要件は分けて確認する。

## Gmail再認証

ステータスの変更だけでは失効済みRefresh tokenは復旧しない。OAuth Playgroundで同じOAuthクライアント・Gmailアカウントの認可をやり直し、新しい値をSupabaseの `GOOGLE_OAUTH_REFRESH_TOKEN` に直接保存する。Secret、トークン、パスワードをチャットやGitへ記録しない。

## 文面の根拠と未確認事項

- Gmail返信同期は本文の抜粋・ID・日時をCRMへ記録する。
- 下書き補助では、返信内容・履歴の抜粋等をGemini APIへ送るため、プライバシーポリシーでこの送信を開示する。
- Gemini APIプロジェクトの課金状態は、この作業では確認できていない。外部サービスによる製品改善利用が常に無いとは記載しない。GoogleのLimited Useへの適合判断には、この契約・設定の確認も必要。
- メール反応の計測は別ブランチで作業中。ポリシーでは機能利用時の取扱いを開示する。

参考: [ブランディング設定](https://support.google.com/cloud/answer/15549049?hl=en)、[OAuth公開要件](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)、[Google APIデータポリシー](https://developers.google.com/terms/api-services-user-data-policy)、[Gemini APIの規約](https://ai.google.dev/gemini-api/terms)。
