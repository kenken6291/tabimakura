# 旅枕（たびまくら）— テーマで巡る、物語の旅  v1.0.0

「奥の細道」をはじめ、テーマごとの旅路を地図・朗読・AI案内・空撮映像でたどり、訪問記録（御朱印帳）とコメントで旅人どうしが交流する Web アプリです。

```
tabimakura/
├── index.html     画面（オープニング／地図／一覧／詳細・認証・御朱印帳・設定モーダル）
├── style.css      デザイン（夜の藍＋山吹の道筋、詳細は和紙の頁、訪問は朱印）
├── config.js      GAS URL・バージョン・各種上限
├── app.js         フロント処理一式
└── gas/Code.gs    GAS バックエンド（GitHub には置かなくてOK）
```

---

## 1. スプレッドシート設計

`setup()` を実行すると、下記シートとヘッダーが自動作成され、「奥の細道」24スポットが登録されます。値はすべて文字列として保存されます（数式インジェクション対策）。

### Users（会員）
| 列 | 内容 |
|---|---|
| user_id | `u_xxxxxxxx` |
| email | 小文字化したメールアドレス（ログインID） |
| user_name | 表示名（20字まで） |
| password_hash | SHA-256（salt＋PEPPER、300回ストレッチ） |
| salt | ユーザーごとのソルト |
| must_change | TRUE＝仮パスワード状態（本パスワード設定まで他の操作不可） |
| failed_count | 連続ログイン失敗回数 |
| locked_until | ロック解除日時（5回失敗で15分ロック） |
| status | `active` / `suspended`（手で書き換えると利用停止） |
| created_at / updated_at | ISO日時 |

### Sessions（ログインセッション）
| 列 | 内容 |
|---|---|
| token | セッショントークン |
| user_id | 会員ID |
| created_at / expires_at | 有効期限は30日（CacheService にも6時間キャッシュ） |

### Themes（旅のテーマ）
| 列 | 内容 |
|---|---|
| theme_id | 例 `okuno-hosomichi` |
| name / subtitle / description | 表示名・副題・説明 |
| guide_name | AI案内人の名前（例 `旅の供・曾良`） |
| sort | 並び順 |
| active | TRUE で表示 |

### Spots（スポット）
| 列 | 内容 |
|---|---|
| spot_id | 例 `oku-01` |
| theme_id | Themes.theme_id |
| order | 旅路の順番（地図の道筋もこの順で結ぶ） |
| name / kana / pref | 名称・よみ・所在地 |
| lat / lng | 緯度・経度 |
| haiku / haiku_author / season | 句・作者・季節（空欄可） |
| description | 解説（朗読にも使用） |
| earth_video_url | Google Earth Studio 映像（Drive共有リンク / YouTube / mp4直リンク）。空欄なら航空写真で舞い降りる演出 |
| image_url | 予備（未使用） |

### Logs（訪問記録）
| 列 | 内容 |
|---|---|
| log_id / user_id / user_name / spot_id | 記録ID・会員・スポット |
| visited_on | 訪れた日 `YYYY-MM-DD` |
| note | ひとこと（300字） |
| media_type | `image` / `video` / 空 |
| file_id | Drive ファイルID（スポット別サブフォルダに保存・リンク共有で閲覧可） |
| created_at | 登録日時 |

### Comments（旅人の声）
| 列 | 内容 |
|---|---|
| comment_id / spot_id / user_id / user_name | |
| text | 本文（500字） |
| likes | いいねした user_id のカンマ区切り |
| created_at / updated_at | |
| deleted | TRUE＝削除済（論理削除） |

---

## 2. GAS のセットアップ

1. 新しいスプレッドシートを作り、**拡張機能 → Apps Script** を開く。
2. `Code.gs` の中身を全て貼り替えて保存。
3. **プロジェクトの設定 → スクリプト プロパティ** に追加：

   | キー | 値 |
   |---|---|
   | `GEMINI_API_KEY` | Gemini APIキー（必須） |
   | `APP_URL` | `https://kenken6291.github.io/tabimakura/` |
   | `GEMINI_MODEL` | 任意（既定 `gemini-2.5-flash`） |
   | `GEMINI_TTS_MODEL` | 任意（既定 `gemini-2.5-flash-preview-tts`） |
   | `TTS_VOICE` | 任意（既定 `Charon`。`Kore` `Puck` なども可） |
   | `AI_DAILY_LIMIT` | 任意（既定 40回／人・日） |
   | `SHOW_TEMP_PW` | テスト中だけ `true`（仮パスワードを画面にも表示）。本番は削除 |

   `PEPPER` と `DRIVE_FOLDER_ID` は `setup()` が自動で作ります。モデル名が古くなったら、ここを書き換えるだけで切り替えられます。
4. エディタで関数 `setup` を選んで **実行** → 権限を承認。シート・初期データ・Drive フォルダ `tabimakura_uploads` ができます。
5. 続けて `authorizeMail`（メール送信の承認）、`testGemini`（Gemini 接続確認）を実行。
6. **デプロイ → 新しいデプロイ → 種類：ウェブアプリ**
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**
   - 表示された `https://script.google.com/macros/s/…/exec` をコピー。
7. （推奨）**トリガー** で `cleanupSessions` を「時間主導・日タイマー」で追加。

> ⚠️ `Code.gs` を直したら、**デプロイを管理 → 編集（鉛筆）→ バージョン：新バージョン → デプロイ** を必ず行ってください。保存だけでは公開中のURLに反映されません。

---

## 3. GitHub Pages への配置

1. リポジトリ `tabimakura` を作成し、`index.html` `style.css` `config.js` `app.js` をルートに置く（`gas/` は置かなくてOK）。
2. `config.js` の `GAS_API_URL` に手順2-6のURLを貼る（または公開後に画面右上の「設定」から入力）。
3. **Settings → Pages → Branch: main / root** で公開 → `https://kenken6291.github.io/tabimakura/`
4. 設定画面の「接続テスト」で `接続できました（サーバー v1.0.0）` と出ればOK。

---

## 4. 動作確認の流れ

1. 「旅立つ」→ 地図に24か所と道筋が出る／「空から辿る」で順に空撮風に巡る。
2. 「ログイン → はじめての方は会員登録」→ メールの仮パスワードでログイン → 本パスワード設定画面へ自動遷移。
3. スポットを開く → 「句を朗読で聞く」（Gemini TTS、失敗時はブラウザ音声に自動切替）、案内人に質問、写真付きで「参詣を記録する」→ 朱印が付き、御朱印帳に反映。
4. コメントの投稿・編集・削除・いいね（15秒ごとに自動更新）。

---

## 5. 空撮映像（Google Earth Studio）の登録

1. Earth Studio でスポット上空のアニメーションを作り、mp4 で書き出し。
2. Drive にアップロード → 共有「リンクを知っている全員（閲覧者）」→ リンクをコピー。
3. Spots シートの `earth_video_url` に貼る（YouTube 限定公開のURLでも可）。
   次に詳細を開くとボタンが「空撮映像を見る」に変わります。

## 6. 新しいテーマを増やす

Themes に1行（例 `tokaido` / 東海道五十三次 / 案内人名）、Spots に `theme_id` を合わせて行を追加するだけで、ヘッダーのテーマ選択に現れます。

---

## 7. 補足・制限

- 初期スポットの座標はおおよその位置です。現地の句碑などに合わせたい場合は lat/lng を修正してください。
- 写真は送信前に長辺1920pxへ縮小。動画は20MBまで（GASの受信上限のため。長い動画は短く切ってください）。
- 地図は国土地理院（淡色・航空写真）と OpenStreetMap。
- Gemini の音声は Drive の `tts_cache` に保存して再利用するので、同じ句の再生は API を消費しません。
- AI の回答は史実と違う場合があるため、画面に注意書きを出しています。
