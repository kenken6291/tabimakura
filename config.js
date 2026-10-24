/**
 * 旅枕 — 設定ファイル
 * GAS_API_URL はここに書くか、画面右上「設定」から入力（ブラウザに保存され、こちらより優先）。
 * Gemini APIキーはフロントに置かず、GASのスクリプトプロパティで管理します。
 */
window.APP_CONFIG = {
  APP_NAME: '旅枕',
  APP_SUBTITLE: 'テーマで巡る、物語の旅',
  VERSION: 'v1.1.1',

  // GASウェブアプリURL（https://script.google.com/macros/s/xxxx/exec）
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbxp_8--PHgph4rMn1BfJrq0gX18S7G_mPqYXgNoOd8t2Ns1qhO7k1vs2u163qUrm-Ss/exec',

  // 最初に開くテーマ
  DEFAULT_THEME_ID: 'okuno-hosomichi',

  // 地図の初期表示
  MAP_CENTER: [37.6, 139.3],
  MAP_ZOOM: 6,

  // 音声：'gemini'（要ログイン）または 'browser'（Web Speech API）
  DEFAULT_TTS_ENGINE: 'gemini',
  DEFAULT_SPEECH_RATE: 0.95,

  // アップロード上限（MB）。画像は長辺1920pxに自動縮小してから送信
  MAX_IMAGE_MB: 15,
  MAX_VIDEO_MB: 20,
  IMAGE_MAX_EDGE: 1920,

  // コメント自動更新間隔（ミリ秒）
  COMMENT_POLL_MS: 15000,

  // 空から辿るモードの1スポット滞在時間（ミリ秒）
  TOUR_STEP_MS: 4500
};
