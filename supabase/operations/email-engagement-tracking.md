# Follow-upのメール反応計測

作業日: 2026-10-13。Akihiroの現行CRM用。

## 対象と画面

- 導入後にCRMから送信するFollow-up 1、Follow-up 2、個別の会話Follow-upが対象。初回メール・過去の送信分には遡及しない。
- 一覧の「メール反応」は初期状態で折りたたむ。Test Modeと本番の集計を分ける。
- 個別CRMには送信ステージと「検知なし」「開封の可能性あり」「Profileアクセス検知」を表示する。
- 計測結果は、CRMの連絡状況・次のアクション・Follow-up回数・予約対象・Gmailラベルを変更しない。

画像の取得は開封の目安であり、読まれた証拠ではない。画像の非表示・プロキシ・キャッシュによって実際の閲覧を検知できない場合がある。自分で送信済みメールを開く操作、転送先の閲覧、自動スキャンも含まれ得る。共有メールアドレスでは閲覧者を区別できない。「検知なし」は未読の証明ではない。

## 送信と記録

1. 従来の学校全体の返信確認とFollow-upステージ確認を通す。
2. サーバーで推測困難な計測トークンを作り、DBにはSHA-256ハッシュだけを保存する。予約ではitem IDを署名し、同じ予約で同じトークンを使う。
3. 承認済み本文の固定Profile URLだけを計測URLに置換する。転送先は常に `https://fujitame.github.io/profile/`。
4. 同一本文のtext/plainとtext/htmlをmultipart/alternativeで送信する。HTMLには1px画像を付ける。件名・宛先・元スレッドを維持する。
5. Gmailの保存済み本文を読み返して、実際に送ったtext/plain本文と一致することを確認する。その後CRM・履歴・予約・ラベルを更新する。

送信後の確認や記録に失敗した場合は `send_unknown` とし、自動再送しない。判明したGmail message IDは保存する。通常Follow-upはcontactとstageの一意制約でも重複を防ぐ。送信不明を解消する場合はGmailの実メールとCRMを照合し、ステージを進めるか未送信を確定する。計測行の削除だけで再送可能に戻さない。

## 公開エンドポイントとデータ

`recruiting-email-events` はログインなしでメールの画像・リンクから呼び出すため、JWT検証を無効にしている。GET/HEADのみ。64桁のトークンが該当行と一致したGETだけが記録される。HEADは記録しない。任意の転送先は受け付けない。

- データ: 所有者・contact・予約item・ステージ・送信結果・Gmail ID・最初/最後の反応日時・集約回数。
- メール本文・IPアドレス・User-AgentはDBに保存しない。User-Agentとprefetchヘッダーは既知の自動アクセスの分類にだけ利用する。
- Profileの既知の自動アクセスは別に記録する。画像取得自体は常に「開封の目安」とする。
- 同じ種類の書込は10分間まとめる。トークン受付期限は120日。期限切れでもProfileリンクは固定ページへ遷移する。
- RLS: 認証済み所有者だけSELECT可能。anonにはテーブル読取権限なし。記録RPCはservice_roleだけ実行可能。
- 外部の有料計測サービスは使わない。Supabaseの関数・DB利用量は既存の契約枠に含まれる。無料枠が無制限という意味ではない。

## Gmail認証の保守

Googleのrefresh tokenが失効すると予約送信と返信同期は動作できない。Workerは送信予定の予約をclaimする前に認証を確認し、失効中は未送信の予約をscheduledのまま保持する。既に送信不明になった予約は再認証だけでは再送しない。

OAuth Playgroundで再認証する場合:

1. CRMで利用するGoogle CloudプロジェクトのAudienceを確認する。External / TestingでGmailスコープを使うトークンは通常7日で失効する。
2. 個人利用の継続運用ではIn productionに変更してから新しいトークンを取得する。失効済みの古いトークンは更新設定だけでは復旧しない。
3. Playground右上の設定で「Use your own OAuth credentials」を有効にし、CRMと同じOAuthクライアントを使用する。redirect URIは `https://developers.google.com/oauthplayground`。OfflineとConsent Screenを使用する。
4. CRMのGmailアカウント `fujiakihiro8@gmail.com` で、送信・スレッド読取・ラベル変更を行う既存スコープを再認可する。
5. 新しいRefresh tokenをSupabaseのEdge Functions Secretsの `GOOGLE_OAUTH_REFRESH_TOKEN` に直接保存する。Client IDとSecretを変更した場合は、それらも同じクライアントの値へ揃える。
6. トークン・Secret・パスワードをチャット、ソース、ログ、スクリーンショットへ出さない。Test Modeの固定宛先で本文・送信結果を確認してから本番予約へ進む。

Playground標準のOAuth設定では24時間後にrefresh tokenが自動取消される。独自クライアントの利用で回避する。In productionでも、利用者による取消・Gmailパスワード変更等で失効し得るため、永久に有効とは保証しない。

参考: [Playground](https://developers.google.com/oauthplayground/)、[Google OAuthの失効条件](https://developers.google.com/identity/protocols/oauth2#expiration)、[個人利用の審査免除](https://support.google.com/cloud/answer/13464323?hl=en)。汎用アプリの認証・公開要件は別プロジェクトで検討する。

## 確認状況

- `node tests/followup-mime.cjs`: MIMEの空行・Unicode本文・スレッドヘッダー・空本文の拒否。
- `node tests/followup-safety.cjs`: FU1/FU2・CRM/履歴/ラベル・同校のDB/Gmail返信による停止・OAuth失効時の未送信予約保持。Gmail呼出はmock。
- `node tests/email-engagement.cjs`: トークン・ハッシュ・Profile置換・multipart・本文読戻し・送信不明の保護。Gmail呼出はmock。
- 本番DBの一時データでRLS・RPC権限・10分集約・既知の自動アクセスの区分・受付期限を確認。
- 公開関数でGIF/固定302/HEAD/不正event/不正methodを確認。
- 現行HTMLのマークアップ・CSS・描画関数を使ったローカル表示例で、一覧の初期折りたたみ・展開・個別CRMの小さな表示を確認。実アカウントへログインした画面の確認ではない。
- 再認証後、サーバーでのOAuth更新・送信アカウント `fujiakihiro8@gmail.com`・ラベル24件の読取を確認。返信同期は追跡105スレッド、失敗0。
- 固定宛先 `fujitame@gmail.com` に計測付きmultipartメールと、同じ共通MIME生成によるplain返信を実送信。Gmail保存済み本文の一致、Unicode保持、ラベルの書込/読戻し、画像GIF・Profile固定302・自動アクセス区分を確認。検証用2通ではCRM回数を更新していない。
- Sender5経路を反映: 初回v23、個別返信v18、通常Follow-up v20、会話Follow-up v17、予約Worker v12。デプロイしたソースとローカルファイルの一致を確認。WorkerはHTTP200・claim 0・送信0・不明0。未認証のSender/予約7経路はHTTP401。
- フロントはこの記録を含む保守PRでmainへ反映する。実ログインした予約UIからの送信を今回新たに行ったわけではない。
- 前回の公開関数確認用の、Gmail IDのない一時計測行2件は利用者の明示許可に従い削除済み。実送信したTest計測行1件は保持。確認専用関数 `recruiting-tracking-check` は削除済み。

## 全送信経路の本文監査（2026-10-13）

個別通常Follow-up・会話Follow-up・個別返信に、ヘッダーと本文を区切る空行まで `.filter(Boolean)` で除去する古いコードが残っていた。予約送信だけの修正では全経路を直せていなかった。今回は初回を含む5送信経路のMIME生成を共通の `buildReplyRaw` に統一した。

- CRM履歴の実運用194通をGmailで読戻し: 初回92通、Follow-up100通、個別返信2通。全194通に本文あり。一時的なHTTP403で読めなかった55通は同時読取数を減らして再確認し、すべて成功。メール本文やトークンは監査記録へ転載しない。
- Test Modeの過去3通（2026-10-07 20:20 JST）に本文なしを確認。旧不具合修正前の固定テスト宛先向け。これらの再送や過去履歴の書換えはしない。
- 初回・個別返信にもGmailの本文一致確認を追加。受理後の読戻し失敗は再送を促すエラーにせず、本文未検証の警告とGmail IDを返す。初回は次の自動Follow-up予定を停止。個別返信はCRM次アクションと履歴に確認が必要なことを残す。
- 初回の送信後CRM更新失敗は、送信受理済みとGmail IDを応答に含める。初回・返信の受理後の記録失敗では、画面の送信ボタンを再度有効にしない。
- `node tests/gmail-initial-mime.cjs` と `node tests/gmail-reply-mime.cjs` は実際のエンドポイントコードでUTF-8/MIME/本文読戻し/適格性/ラベル失敗/記録失敗の分岐を確認。Gmail・認証・DBはmock。
- 本番DBのトランザクション内で、同じcontactの同じ通常Follow-upステージの重複を一意制約が拒否し、別ステージを受け付けることを確認。確認データはrollback済み。

監査対象はCRM履歴にGmail IDがあるメール。Gmail内の全メール、受信側での表示や到達、履歴未記録メールまで保証するものではない。ネットワーク断でGmailの送信応答自体が届かない場合も、先にGmailを確認してから手動対応する。
