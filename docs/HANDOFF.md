# Akihiro Recruiting CRM — 開発引き継ぎ

更新：2026-11-26（JST）。コードの基準：[`main` / `7f3b5ee`](https://github.com/fujitame/recruiting-dashboard/commit/7f3b5eed0c94e4d3888060aae4f0dd7040e89dfd)。この文書は開発用。実際の予約・返信・送信状況、デプロイ済み関数、Cronや実行フラグは作成時に再照会していない。運用判断では、確認時点の実データと認可を別に確かめる。

## 1. 目的と作業の引き継ぎ

暁廣の2027年秋の米大学男子サッカー編入を支援する、所有者向けの実運用CRM。候補校の比較から、学校別の文案、送信結果、返信、次の対応までをつなぐ。利用者への説明は日本語、コーチに確認して送る文面は本人の自然な英語とする。成功の基準は、利用者が「何を確認し、何をしたら送られるか」を読み取れ、CRMとGmailの記録を説明できること。汎用化・マルチユーザー化・iOSはこの作業に混ぜない。

### Antigravity AppとRemote Agents

- Mac miniはローカルの作業・実機確認の拠点。すでに利用中の `recruiting-dashboard-latest` はローカル作業用。コードの共有元は GitHub の `fujitame/recruiting-dashboard`。MacBook Airで同じリモート会話を開くには、同じGoogleアカウントの同じRemote Projectを選ぶ。
- **Remote Agents**はGoogle側で実行。Remote ProjectのResourcesにGitHubリポジトリを追加し、そのリポジトリを作業対象にする。Mac miniの未push変更やローカル設定は見えない。逆に、**Remote Control**でMac miniという接続先を選ぶ場合はMac mini上のセッションで、母艦が稼働している必要がある。ブラウザで開けるだけでは方式を特定できないため、プロジェクトと接続先表示で確認する。
- ルートの [AGENTS.md](../AGENTS.md) は常時のワークスペースルール。本書は必要時の参照文書で、全文インライン展開はしない。GitHubの既定ブランチに入ったら、両端末の同じRemote Projectの新規会話で「読んだ `AGENTS.md` のパスと、参照先の文書、現在のコミットを教えて」と読み取りだけで確認する。見つからなければ対象リポジトリ、ブランチ、作業ディレクトリを確認する。ChatGPTの会話履歴やMacの認証情報を移す必要はない。
- 「相談して方針を決める→実装とテストをまとめて進める→結果を見て本番反映を判断」の流れを優先。開始時に `git status --short --branch` と最新 `origin/main` を確認し、作業は別ブランチ。MacとRemoteで未共有の変更を同じブランチに重ねない。PRには目的・利用者の見え方・検証・未確認事項を書く。

仕様の参照：[Google: Rules](https://antigravity.google/docs/rules/) ／ [Google: Remote Agents](https://antigravity.google/docs/remote-agents)。

## 2. アーキテクチャと責務

| 層 | 現行の役割と主な入口 |
| --- | --- |
| GitHub Pages・静的フロント | [`index.html`](../index.html)：Supabase Auth、候補校Table/Map、コーチ詳細・返信・過去の予約。 [`activity.html`](../activity.html) は親画面からiframeで開く活動画面で、[`activity.js`](../activity.js) と `activity.css` が集計・絞り込み・予約前確認を担当。依存ライブラリをCDNから取得する箇所あり。既存アプリにビルド工程は不要。 |
| 共通フロント補助 | `recruiting-status.js`：保留等の状態判定。 `recruiting-schedule-time.js`：学校の現地時刻と予約日時。 `recruiting-email-format.js`、`campaign-draft-review.js`：メールの表示形式と文案レビュー。 |
| Supabase Postgres・Auth・RLS | 選手・学校・Research、所有者に紐づくコーチ記録、活動・文案・送信キュー・照合を保持。権限と整合性はRLS、RPC、トリガーでも守る。適用済みMigrationは履歴であり、後ろのMigrationや実運用SQLが定義を更新することがある。 |
| Supabase Edge Functions | [`recruiting-campaign-outreach`](../supabase/functions/recruiting-campaign-outreach/index.ts) は活動のpreview/schedule/cancel/reconcile等、[`recruiting-campaign-worker`](../supabase/functions/recruiting-campaign-worker/index.ts) は予約処理。 `recruiting-gmail-replies` は返信取得、個別の返信送信・会話Follow-upと固定宛先の旧予約処理は別入口。 `_shared/` にGmail周辺・判定・文面処理がある。 `supabase/config.toml` だけで実稼働関数の全数を決めない。 |
| Gmail API・Google OAuth | 実送信、スレッド読取、返信取得、ラベル。OAuthと送信はサーバーで扱う。Gmailが実際のメールの証跡、CRMが承認・予約・業務状態の記録。両者をMessage-ID／GmailメッセージID・スレッド・確認内容で照合する。 |
| Gemini API・選手Profile | GeminiはResearchや会話を踏まえて文案・考察を作る。生成は送信承認ではない。別リポジトリの[公開Profile](https://fujitame.github.io/profile/)は選手情報と問い合わせ受付を共有。 |
| 定期処理・配信 | GitHub Pagesはフロント、Supabaseの定期処理は返信同期・予約処理。GmailのブラウザやMacが開いていることを送信の前提にしない。コードのマージとEdge Function・DB・Cronの反映状態は別々に確認する。 |

**設計の理由：** Gmail・DB間に一つのトランザクションは張れない。画面だけで送信可否を判定せず、予約時と実行直前に同じ制約を確かめる。Gmail受理後の未知状態は照合へ回す。過去の履歴や累積の進捗は保全しつつ、「今回の活動」の予約・送信・返信・反応は別の範囲として扱う。

### ChatGPTの契約を停止する場合の依存関係

- CRMとProfileの `main`（CRM `7f3b5ee`、Profile `fe1b8c9`）と、確認時点のデプロイ済みSupabase Edge Functions 17件を読み取りで確認。直接のOpenAI API呼び出し・OpenAI APIキー参照は見つからなかった。稼働ソースの初回文案・通常Follow-up・個別返信・返信後Follow-upの4関数は、いずれも `GEMINI_API_KEY` でGemini Developer APIを呼ぶ。公開Profileの問い合わせはSupabase RPCとEmailJS、CRMの送信・返信同期はGmail APIが担当する。**確認したアプリ経路にOpenAIからのAPI移行は不要。**
- [ChatGPTの契約とOpenAI APIの請求](https://help.openai.com/ja-jp/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)は別。OpenAI API組織の契約・使用明細や、この2リポジトリ外のサービスまでは確認対象外。Antigravityは開発環境であり、CRM本番のGemini APIの契約・鍵を代替しない。Gemini文案が使えない場合は [Gemini APIの料金・利用枠](https://ai.google.dev/gemini-api/docs/pricing)、Google側の対応モデル、Supabase側の鍵設定をそれぞれ確認する。鍵の値は共有しない。
- **ChatGPT側の外付け定期監視とSupabase側の予約・返信同期は別。** ChatGPTで運用している再アプローチ等の定期タスクや接続権限は、GitHubやRemote Projectに自動移管されない。契約変更前に継続要否、直近の実行結果、未処理の対象と今後の承認範囲を非公開の運用記録で確認する。必要ならAntigravity等へ引き継ぎ、まず読み取り専用で試し、旧監視と新監視から重複して予約・送信しない切替を計画する。正確な送信時刻を管理するのは既存のSupabase予約キューであり、AIの監視スケジュールへ置き換えない。

## 3. 主要データと導線

| データ | 変更時の注意 |
| --- | --- |
| `player_profile`、`recruiting_universities`、`recruiting_program_research` | 選手マスター、学校・コーチ情報、出典付きResearch。ハイライト差し替えはProfileだけでなく初回・AI返信等の文案経路と計測リンクも確認する。受信した引用文や過去メールのURLを新規文案の正としない。Researchは出典・確認日・事実／推測／未確認を分ける。学年やDF人数は卒業・退団・空き枠・奨学金の確定数ではない。 |
| `recruiting_contacts`、`recruiting_contact_history`、`recruiting_school_pipeline` | コーチごとの連絡状況・履歴、学校単位の進捗。コーチの返信と、採用の関心・オファー・キャンプ案内を混同しない。 `recruiting_records` はお気に入りや互換参照が残るため、古い名前だけで廃止しない。 |
| `recruiting_inbound_leads`、`recruiting_reply_drafts` | Profile問い合わせと個別返信の下書き。共有の問い合わせRPCと所有者境界を維持。下書きはコーチ・スレッド・元返信・revisionで識別し、新しい返信や別画面の編集を上書きしない。Gmail上の送信実績とは区別する。 |
| `recruiting_campaigns`、`recruiting_campaign_contacts`、`recruiting_campaign_messages`、`recruiting_campaign_draft_reviews`、`recruiting_campaign_deliveries` | 活動、対象、段階別文案・確認、実送信キュー。共有宛先は同校内では1通にまとめ、文面・日時の不一致は保留。別校との宛先重複は要確認。活動内で初回/FU1/FU2を管理し、累積カウンターをリセットしたり今回の段階に流用したりしない。 |
| `recruiting_activity_records`、`recruiting_campaign_issues`、`recruiting_campaign_label_tasks`、`recruiting_campaign_send_control` | 活動への履歴の紐づけ、要確認、ラベル再同期、アカウント単位の送出制御。活動を日付だけで推定しない。共有宛先では実メール1通の証跡を保ち、各コーチへの反映は重複させない。 |
| `recruiting_followup_batches`、`recruiting_followup_batch_items`、`recruiting_email_tracking` | 旧予約・固定宛先テストの記録と、送信に紐づく計測。旧予約の表示や状態を現キャンペーンの新規本番予約の入口として復活させない。 |

- 候補校は学校比較と累積の状況。「連絡先・履歴」はHC/AC別の詳細、「送信準備」は状態に応じて今回の活動・個別対応等へ進む。Mapのボタン文言はPR #48の対象外。学校名からの評価シートとコーチ詳細は別の導線。評価シート一覧は [`school-reports.html`](../school-reports.html)。
- 対象未返信校の通常メールは「活動状況・送信準備」。返信が到着したコーチは「返信・個別対応」。返信分析・返信方針からAI返信案または手動案を作成し、AI案は和訳、手動案は件名・宛名・署名を初期表示する。確認画面で本文・CC・連絡状況を確認し、実際の元メールに基づきGmail作成画面へ進む。この一連の操作と実送信は区別する。返信後の会話Follow-upは通常の回数に加えず、最新のGmailスレッドで新着がないことを確認する。
- 「閲覧・動画の反応」は画像取得、Profile・YouTubeリンク、実装が記録できたProfile上の操作等を区別する。画像はキャッシュ・プロキシ、リンクは自動スキャンを含み得る。YouTubeリンククリックは再生・視聴完了の証拠ではない。共有アドレスの反応を特定のHC/AC個人に断定せず、反応を採用関心、未検知を未読と扱わない。 `recruiting-email-events` と計測・個別の回帰テストを改修前に読む。

## 4. 守るべき送信・データ運用

1. **承認の対象を限定する。** 文案生成、保存、予約前チェック、送信前チェック、実行許可、実送信は別。開発依頼だけで予約・許可フラグ・本番DB・Gmailを操作しない。本番UIのローカル表示も同じバックエンドにつながる。Test Modeの学校ID 900–902は既存の固定宛先にサーバー側で分離し、ログインやモード表示だけで安全と判断しない。通常の検証はモックを使う。
2. **同一校の返信で停止する。** 対象コーチだけでなく、他のスタッフの返信、CRMとGmailの既知スレッド、受付問い合わせ、個別対応・除外の状態も確認する。返信者不明は先頭コーチへ付けず要確認。予約後の返答でも止める。Gmail再確認と実送信の間の競合を完全に除去できないため、送信直前の確認を外さず、既に受理された実績は保存する。
3. **送信不明は再送しない。** `scheduled` は予約、`processing` は処理中、`held` は保留、`send_unknown` は結果要照合、`sent` は送信確認。日時案は予約ではない。通信切断・読戻し不一致・記録失敗・途中中断では、「Gmailと送信結果を照合」で送信済みラベル、ID、宛先、件名、本文、元スレッド等を確かめる。不明を未送信と断定しない。ラベルだけのエラーはラベル再試行。重複防止、Workerリース、送出間隔、アカウント停止を回避しない。
4. **宛先・内容・時刻を固定して確認する。** 文案と送信日時は保存したスナップショット／承認内容を使い、変更や別画面の競合は再確認する。FUは同一活動の直前の送信済みスレッドを参照。学校のIANAタイムゾーンと入力した現地時刻を確認し、未設定や時刻解釈不明なら止める。JSTと学校現地時刻を区別する。通常の目安は送信から1週間、利用者は木曜現地午前を好むが、自動的に次の送信を承認する規則ではない。
5. **募集運用とコードを分ける。** 現行方針として、新規再アプローチで返信済み・個別対応・対象外の学校を除く。Portalオープン直後・米国のThanksgiving・年末年始は送らない方針。初回・Follow-up件名の 🇯🇵 も運用方針で、実際の確認済み文案に適用する。具体的な日程・コーチ・除外・承認済み範囲は当該活動で確認し、過去のまとめ・過去の送信許可を新しい活動へ持ち越さない。
6. **共有資産と秘密を守る。** 本番OAuthやサービス権限の秘密値は秘密管理側に置く。Repo・チャット・ログへ貼らない。Migration、RLS、RPCや既存履歴はProfileを含む呼出元を追ってから変更。公開計測／問い合わせのエンドポイントを他のDB権限の入口に広げない。

## 5. 現時点で分かっている完了事項

- [PR #48](https://github.com/fujitame/recruiting-dashboard/pull/48) は `c8f0db2` にマージ済み。PCのTable Viewとモバイル候補校カードの表示名を「送信準備」「連絡先・履歴」に整理。利用者が本番で見切れなしを確認。クリック処理と地図ポップアップは変更対象外。
- [PR #49](https://github.com/fujitame/recruiting-dashboard/pull/49) は `7f3b5ee` にマージ済み。旧Follow-upテスト用DBモックに `.order()`・`.limit()` を補い、キャンペーン配信なしのfixtureを明示。既存の検証と本番コードは維持。作業時の報告で Node 24系の `followup-safety.cjs` と `coach-flow.cjs` が合格。両作業ブランチはGitHubで削除済み。
- [段階別改善記録](crm-improvement-stages.md) には活動の絞り込み、返信下書き保存、予約前チェック、共有宛先集約、安全停止、照合、活動別の表示が記録されている。同文書の「実行無効」「Cron未登録」「0件」は当時の記録。後続のアカウント単位ペーシング・リースは [`docs/campaign-send-pacing.sql`](campaign-send-pacing.sql) に記録。現在の稼働や未送信件数はこれらから推定しない。

## 6. 次のロードマップ・技術上の課題

以下は提案。運用中の送信や予約を動かす指示ではない。

| 優先 | 残タスクと完了条件 |
| --- | --- |
| 1 | **Antigravityで引き継ぎの読込を確認。** Mac miniのAppとMacBook Airのブラウザから同じRemote Project／会話を開き、最新 `main`、ルートルール、テスト結果を日本語で報告できること。テスト専用fixtureを使い、実行権限の追加や本番書き込みは不要。 |
| 2 | **予約・照合の分かりやすさを改善。** 現地時刻、どの活動／段階か、コーチ数と実宛先数、予約／処理中／保留／結果不明／送信済みを混同しない表示を検証。必要なら隔離データで予約から次のFU判定まで通す。Safari／実機スマホの操作確認は、過去の幅指定の確認と区別する。 |
| 3 | **個別対応・文案・計測の回帰防止。** 返信元の切替、保存済み原稿との競合、Gmail遷移、CCのON/OFF、送信済みの次アクション、学校別Research・最新ハイライトを検証。画像取得・Profile・YouTubeの数字が何を示すか、学校とHC/ACの集計で説明できる状態を維持する。未確認の動作を既知バグと決めつけない。 |
| 4 | **安全な保守。** 長い `index.html` は表示と状態判定から小さく分割し、送信ガード改修とは別PRにする。Gmail処理の重複、Geminiの候補モデル・JSON解釈、CDN／Deno依存の版管理、共有Profileと古いテーブルの依存を順に調べる。既存の権限警告の棚卸しは古いスナップショットを現状とせず、現有の公開窓口・RLS・RPC権限を読み取りで再確認してから設計する。 |

## 7. 変更前後の検証

リポジトリルートで Node.js 24以上。GmailやDBに接続しない回帰テストを先に実施する。

| 変更箇所 | 主な検証コマンド（すべて `node tests/<名前>`） |
| --- | --- |
| 基本・個別導線 | `followup-safety.cjs`、`coach-flow.cjs` |
| 活動の準備・送信制御・照合 | `campaign-preparation.cjs`、`campaign-worker.cjs`、`campaign-send-control.cjs`、`campaign-reconciliation.cjs`、`campaign-labels.cjs`、`legacy-campaign-routing.cjs` |
| 活動表示・返信下書き | `activity-disposition.cjs`、`activity-scope-ui.cjs`、`reply-draft-storage.cjs` |
| MIME・反応計測 | `followup-mime.cjs`、`email-engagement.cjs` |

- 見た目・クリック導線はPC幅とスマホ幅、可能ならSafariで確認。最初は [`tests/responsive-crm.html`](../tests/responsive-crm.html)、[`tests/activity-fixture.html`](../tests/activity-fixture.html) 等の表示用fixtureを使う。ローカルの実アプリを起動する場合は `python3 -m http.server 4177 --bind 127.0.0.1`。 `127.0.0.1` でもSupabaseは本番を向く。
- [`tests/campaign-outreach.sql`](../tests/campaign-outreach.sql) 等は隔離DBで、権限とトランザクション境界を確認してから実行。本番に流す手順として扱わない。テストもPRも実送信や運用データ変更の承認にならない。
- PR前に `git diff --check`、対象の回帰テスト、必要ならPC／スマホの表示確認。報告では「テスト合格」「fixtureで確認」「実環境で確認」を分ける。Pages、DB、Edge Functionの変更は必要なものだけ個別に計画する。

## 8. 参照先と読み方

- [README](../README.md)：入口、ローカル起動と基本方針。
- [CRM改善の段階](crm-improvement-stages.md)：11月のUI・返信下書き・活動キュー・回帰確認。各記述の日付に注意。
- [構成・整理記録](../supabase/operations/system-inventory.md)：起源・旧経路・共有資産の背景。当時の関数数やCronは現況として扱わない。
- [旧Follow-up予約の安全性](../supabase/operations/followup-safety.md)／[返信後のAI Follow-up](../supabase/operations/contextual-ai-followup.md)：旧予約と個別会話を区別する資料。
- [メール反応計測の運用記録](../supabase/operations/email-engagement-tracking.md)：計測の初期設計。対象ステージやイベントの最新定義は実装と照合。
- ドキュメントとコードが食い違う場合は、確認したコミット、当時の意図、現行のコード、実稼働の状態を分けて記録する。公開可能な情報だけを本書に追記する。
