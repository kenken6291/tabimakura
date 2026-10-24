/**
 * 旅枕（たびまくら）— テーマで巡る物語の旅  GASバックエンド
 * Version: v1.0.0
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   SPREADSHEET_ID   : DBのスプレッドシートID（コンテナバインドなら空でOK）
 *   DRIVE_FOLDER_ID  : 投稿写真・動画の保存先フォルダID（空なら自動作成）
 *   GEMINI_API_KEY   : Gemini APIキー（必須：AIガイド・音声）
 *   GEMINI_MODEL     : テキスト生成モデル（既定 gemini-2.5-flash）
 *   GEMINI_TTS_MODEL : 音声生成モデル（既定 gemini-2.5-flash-preview-tts）
 *   TTS_VOICE        : 音声名（既定 Charon）
 *   PEPPER           : パスワードハッシュ用ペッパー（任意の長い文字列）
 *   AI_DAILY_LIMIT   : 1人1日あたりのAI/音声生成回数上限（既定 40）
 *   SHOW_TEMP_PW     : 'true' で仮パスワードを画面にも表示（テスト用。本番は空）
 *   APP_URL          : メール本文に載せるサイトURL（例 https://kenken6291.github.io/tabimakura/）
 *
 * ※ コードを変更したら「デプロイを管理 → 編集 → バージョン：新バージョン」で再デプロイすること。
 */

const APP_VERSION = 'v1.0.0';
const APP_NAME = '旅枕';
const SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const HEADERS = {
  Users:    ['user_id', 'email', 'user_name', 'password_hash', 'salt', 'must_change', 'failed_count', 'locked_until', 'status', 'created_at', 'updated_at'],
  Sessions: ['token', 'user_id', 'created_at', 'expires_at'],
  Themes:   ['theme_id', 'name', 'subtitle', 'description', 'guide_name', 'sort', 'active'],
  Spots:    ['spot_id', 'theme_id', 'order', 'name', 'kana', 'pref', 'lat', 'lng', 'haiku', 'haiku_author', 'season', 'description', 'earth_video_url', 'image_url'],
  Logs:     ['log_id', 'user_id', 'user_name', 'spot_id', 'visited_on', 'note', 'media_type', 'file_id', 'created_at'],
  Comments: ['comment_id', 'spot_id', 'user_id', 'user_name', 'text', 'likes', 'created_at', 'updated_at', 'deleted']
};

/* ===================== ルーター ===================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.action) return json_({ ok: true, app: APP_NAME, version: APP_VERSION });
  return handle_(p.action, p);
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'BAD_REQUEST', message: 'リクエストの形式が正しくありません' });
  }
  return handle_(body.action, body);
}

const ROUTES = {
  ping:           () => ({ version: APP_VERSION, time: now_() }),
  register:       register_,
  login:          login_,
  logout:         logout_,
  me:             me_,
  changePassword: changePassword_,
  resetPassword:  resetPassword_,
  getThemes:      getThemes_,
  getSpots:       getSpots_,
  aiGuide:        aiGuide_,
  tts:            tts_,
  addLog:         addLog_,
  deleteLog:      deleteLog_,
  getSpotLogs:    getSpotLogs_,
  getMyPage:      getMyPage_,
  getComments:    getComments_,
  addComment:     addComment_,
  updateComment:  updateComment_,
  deleteComment:  deleteComment_,
  toggleLike:     toggleLike_
};

function handle_(action, p) {
  try {
    const fn = ROUTES[action];
    if (!fn) fail_('UNKNOWN_ACTION', '不明な操作です: ' + action);
    const result = fn(p || {}) || {};
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    console.error(action, err && err.stack ? err.stack : err);
    return json_({ ok: false, error: err.code || 'ERROR', message: err.message || String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

/* ===================== 共通ユーティリティ ===================== */

function prop_(key, def) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? def : v;
}

function ss_() {
  const id = prop_('SPREADSHEET_ID', '');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function now_() { return new Date().toISOString(); }

function id_(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16); }

// 数式インジェクション・自動型変換を防ぐ（全て文字列として保存）
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@0-9]/.test(s) ? "'" + s : s;
}

function readAll_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const head = HEADERS[name];
  const values = sh.getRange(2, 1, last - 1, head.length).getValues();
  return values.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => {
      const v = r[j];
      o[h] = (v instanceof Date) ? v.toISOString() : v;
    });
    return o;
  });
}

function append_(name, obj) {
  const head = HEADERS[name];
  sheet_(name).appendRow(head.map(h => cell_(obj[h])));
}

function update_(name, row, patch) {
  const head = HEADERS[name];
  const sh = sheet_(name);
  const range = sh.getRange(row, 1, 1, head.length);
  const cur = range.getValues()[0];
  head.forEach((h, j) => {
    if (Object.prototype.hasOwnProperty.call(patch, h)) cur[j] = cell_(patch[h]);
    else cur[j] = (cur[j] instanceof Date) ? cell_(cur[j].toISOString()) : cell_(cur[j]);
  });
  range.setValues([cur]);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function str_(v, max) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/* ===================== パスワード・トークン ===================== */

function hash_(password, salt) {
  const pepper = prop_('PEPPER', 'tabimakura-default-pepper');
  let h = salt + ':' + password + ':' + pepper;
  for (let i = 0; i < 300; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  }
  return h;
}

function randomString_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random());
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      const v = bytes[i] & 255;
      if (v < chars.length * 4) out += chars[v % chars.length];
    }
  }
  return out;
}

function tempPassword_() {
  // 英大文字・小文字・数字を必ず含む10文字
  let pw;
  do { pw = randomString_(10); } while (!(/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)));
  return pw;
}

function validatePassword_(pw) {
  if (pw.length < 8) fail_('WEAK_PASSWORD', 'パスワードは8文字以上にしてください');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) fail_('WEAK_PASSWORD', 'パスワードには英字と数字の両方を含めてください');
  if (pw.length > 64) fail_('WEAK_PASSWORD', 'パスワードは64文字以内にしてください');
}

function createSession_(userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + randomString_(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  append_('Sessions', { token: token, user_id: userId, created_at: now_(), expires_at: expires });
  CacheService.getScriptCache().put('sess_' + token, userId, 21600);
  return token;
}

function findUserById_(userId) {
  return readAll_('Users').find(u => u.user_id === userId) || null;
}

function findUserByEmail_(email) {
  const e = String(email || '').trim().toLowerCase();
  return readAll_('Users').find(u => String(u.email).toLowerCase() === e) || null;
}

function userFromToken_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  let userId = cache.get('sess_' + token);
  if (!userId) {
    const s = readAll_('Sessions').find(x => x.token === token);
    if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
    userId = s.user_id;
    cache.put('sess_' + token, userId, 21600);
  }
  const user = findUserById_(userId);
  if (!user || user.status === 'suspended') return null;
  return user;
}

function requireUser_(p, allowMustChange) {
  const user = userFromToken_(p.token);
  if (!user) fail_('AUTH_REQUIRED', 'ログインが必要です。もう一度ログインしてください');
  if (bool_(user.must_change) && !allowMustChange) fail_('MUST_CHANGE', '仮パスワードのままです。本パスワードを設定してください');
  return user;
}

function publicUser_(u) {
  return { userId: u.user_id, userName: u.user_name, email: u.email, mustChange: bool_(u.must_change) };
}

function sendMail_(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: '【' + APP_NAME + '】' + subject, body: body, name: APP_NAME });
}

function mailFooter_() {
  const url = prop_('APP_URL', '');
  return '\n\n' + (url ? 'サイト: ' + url + '\n' : '') + '※このメールに心当たりがない場合は破棄してください。\n' + APP_NAME + ' ' + APP_VERSION;
}

/* ===================== 認証API ===================== */

function register_(p) {
  const email = str_(p.email, 200).toLowerCase();
  const userName = str_(p.userName, 20);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('INVALID', 'メールアドレスの形式が正しくありません');
  if (!userName) fail_('INVALID', 'ユーザー名を入力してください');

  return withLock_(() => {
    if (findUserByEmail_(email)) fail_('DUPLICATE', 'このメールアドレスは登録済みです。パスワードを忘れた場合は再発行してください');
    const userId = id_('u');
    const temp = tempPassword_();
    const salt = randomString_(16);
    append_('Users', {
      user_id: userId, email: email, user_name: userName,
      password_hash: hash_(temp, salt), salt: salt,
      must_change: true, failed_count: 0, locked_until: '', status: 'active',
      created_at: now_(), updated_at: now_()
    });

    const showOnScreen = prop_('SHOW_TEMP_PW', '') === 'true';
    try {
      sendMail_(email, '仮パスワードのお知らせ',
        userName + ' さん\n\n' + APP_NAME + 'へのご登録ありがとうございます。\n\n仮パスワード: ' + temp +
        '\n\n初回ログイン後、本パスワードの設定をお願いします。' + mailFooter_());
    } catch (err) {
      if (!showOnScreen) {
        const u = findUserByEmail_(email);
        if (u) sheet_('Users').deleteRow(u._row);
        fail_('MAIL_FAILED', 'メールを送信できませんでした。時間をおいて再度お試しください');
      }
    }
    const res = { message: '仮パスワードを ' + email + ' に送りました。メールを確認してログインしてください' };
    if (showOnScreen) res.tempPassword = temp;
    return res;
  });
}

function login_(p) {
  const email = str_(p.email, 200).toLowerCase();
  const password = String(p.password || '');
  const generic = 'メールアドレスまたはパスワードが違います';

  return withLock_(() => {
    const u = findUserByEmail_(email);
    if (!u) fail_('LOGIN_FAILED', generic);
    if (u.status === 'suspended') fail_('SUSPENDED', 'このアカウントは利用停止中です');

    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      const min = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000);
      fail_('LOCKED', 'ログインに続けて失敗したため、あと' + min + '分ロックされています');
    }

    if (hash_(password, u.salt) !== u.password_hash) {
      const count = Number(u.failed_count || 0) + 1;
      const patch = { failed_count: count, updated_at: now_() };
      if (count >= MAX_FAILED) {
        patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        patch.failed_count = 0;
      }
      update_('Users', u._row, patch);
      if (count >= MAX_FAILED) fail_('LOCKED', 'ログインに' + MAX_FAILED + '回失敗したため、' + LOCK_MINUTES + '分間ロックしました');
      fail_('LOGIN_FAILED', generic + '（あと' + (MAX_FAILED - count) + '回でロック）');
    }

    update_('Users', u._row, { failed_count: 0, locked_until: '', updated_at: now_() });
    const token = createSession_(u.user_id);
    return { token: token, user: publicUser_(u) };
  });
}

function logout_(p) {
  if (!p.token) return {};
  CacheService.getScriptCache().remove('sess_' + p.token);
  withLock_(() => {
    const s = readAll_('Sessions').find(x => x.token === p.token);
    if (s) sheet_('Sessions').deleteRow(s._row);
  });
  return {};
}

function me_(p) {
  const u = requireUser_(p, true);
  return { user: publicUser_(u) };
}

function changePassword_(p) {
  const u = requireUser_(p, true);
  const current = String(p.currentPassword || '');
  const next = String(p.newPassword || '');
  if (hash_(current, u.salt) !== u.password_hash) fail_('INVALID', '現在のパスワード（仮パスワード）が違います');
  validatePassword_(next);
  if (current === next) fail_('INVALID', '新しいパスワードは現在と別のものにしてください');

  const salt = randomString_(16);
  withLock_(() => {
    update_('Users', u._row, { password_hash: hash_(next, salt), salt: salt, must_change: false, updated_at: now_() });
  });
  const fresh = findUserById_(u.user_id);
  return { user: publicUser_(fresh), message: 'パスワードを変更しました' };
}

function resetPassword_(p) {
  const email = str_(p.email, 200).toLowerCase();
  const message = '登録があれば、新しい仮パスワードを ' + email + ' に送りました';
  const cache = CacheService.getScriptCache();
  if (cache.get('reset_' + email)) fail_('TOO_MANY', '再発行は1分に1回までです。少し待ってからお試しください');
  cache.put('reset_' + email, '1', 60);

  const u = findUserByEmail_(email);
  if (!u || u.status === 'suspended') return { message: message };

  const temp = tempPassword_();
  const salt = randomString_(16);
  withLock_(() => {
    update_('Users', u._row, {
      password_hash: hash_(temp, salt), salt: salt, must_change: true,
      failed_count: 0, locked_until: '', updated_at: now_()
    });
    // 既存セッションは全て無効化
    const sh = sheet_('Sessions');
    readAll_('Sessions').filter(s => s.user_id === u.user_id).map(s => s._row)
      .sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  });
  sendMail_(email, '仮パスワード再発行のお知らせ',
    u.user_name + ' さん\n\n新しい仮パスワード: ' + temp + '\n\nログイン後、本パスワードを設定してください。' + mailFooter_());
  const res = { message: message };
  if (prop_('SHOW_TEMP_PW', '') === 'true') res.tempPassword = temp;
  return res;
}

/* ===================== テーマ・スポット ===================== */

function getThemes_() {
  const themes = readAll_('Themes')
    .filter(t => bool_(t.active))
    .sort((a, b) => Number(a.sort) - Number(b.sort))
    .map(t => ({ themeId: t.theme_id, name: t.name, subtitle: t.subtitle, description: t.description, guideName: t.guide_name }));
  return { themes: themes };
}

function spotOut_(s) {
  return {
    spotId: s.spot_id, themeId: s.theme_id, order: Number(s.order), name: s.name, kana: s.kana, pref: s.pref,
    lat: Number(s.lat), lng: Number(s.lng), haiku: s.haiku, haikuAuthor: s.haiku_author, season: s.season,
    description: s.description, earthVideoUrl: s.earth_video_url, imageUrl: s.image_url
  };
}

function getSpots_(p) {
  const themeId = str_(p.themeId, 100);
  const spots = readAll_('Spots')
    .filter(s => !themeId || s.theme_id === themeId)
    .sort((a, b) => Number(a.order) - Number(b.order))
    .map(spotOut_);
  const user = userFromToken_(p.token);
  let visited = [];
  if (user) {
    visited = Array.from(new Set(readAll_('Logs').filter(l => l.user_id === user.user_id).map(l => l.spot_id)));
  }
  return { spots: spots, visited: visited };
}

function findSpot_(spotId) {
  const s = readAll_('Spots').find(x => x.spot_id === spotId);
  if (!s) fail_('NOT_FOUND', 'スポットが見つかりません');
  return s;
}

/* ===================== Gemini（AIガイド・TTS） ===================== */

function checkAiQuota_(user) {
  const limit = Number(prop_('AI_DAILY_LIMIT', '40'));
  const key = 'ai_' + user.user_id + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key) || 0);
  if (n >= limit) fail_('QUOTA', '本日のAI案内の上限（' + limit + '回）に達しました。明日またどうぞ');
  cache.put(key, String(n + 1), 86400);
}

function geminiFetch_(model, payload) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) fail_('CONFIG', 'GEMINI_API_KEY が未設定です（スクリプトプロパティを確認）');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) {
    console.error('Gemini error', code, res.getContentText());
    fail_('AI_ERROR', 'AIの呼び出しに失敗しました（' + code + '）' + (body.error && body.error.message ? ': ' + body.error.message : ''));
  }
  return body;
}

function aiGuide_(p) {
  const user = requireUser_(p);
  const spot = findSpot_(str_(p.spotId, 100));
  const question = str_(p.question, 200) || 'この場所の面白い裏話を教えて';
  const theme = readAll_('Themes').find(t => t.theme_id === spot.theme_id) || {};
  checkAiQuota_(user);

  const guideName = theme.guide_name || '案内人';
  const system =
    'あなたは旅の案内人「' + guideName + '」です。旅人（利用者）に寄り添い、丁寧でやわらかな語り口で、少しだけ古風な言い回しを交えて話します。' +
    '回答は日本語で250〜350字程度。音声で読み上げるので、箇条書き・記号・絵文字・URLは使わず、話し言葉の段落で答えてください。' +
    '史実と言い伝え・諸説は区別し、確かでないことは「言い伝えでは」「諸説ありますが」と前置きしてください。作り話はしないでください。' +
    '営業時間や料金など変わりやすい情報は断定せず、現地や公式情報での確認を勧めてください。';

  const context =
    'テーマ: ' + (theme.name || '') + '\n' +
    'スポット: ' + spot.name + '（' + spot.pref + '）\n' +
    (spot.haiku ? '句: ' + spot.haiku + '（' + spot.haiku_author + '）\n' : '') +
    '概要: ' + spot.description + '\n\n' +
    '旅人からの質問: ' + question;

  const model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
  const body = geminiFetch_(model, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: context }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
  });
  const parts = (body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || [];
  const text = parts.map(x => x.text || '').join('').trim();
  if (!text) fail_('AI_ERROR', 'AIから回答が得られませんでした。質問を変えてお試しください');
  return { answer: text, guideName: guideName };
}

function ttsFolder_() {
  const key = 'TTS_CACHE_FOLDER_ID';
  const id = prop_(key, '');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 作り直す */ } }
  const f = uploadRoot_().createFolder('tts_cache');
  PropertiesService.getScriptProperties().setProperty(key, f.getId());
  return f;
}

function tts_(p) {
  const user = requireUser_(p);
  const text = str_(p.text, 1500);
  if (!text) fail_('INVALID', '読み上げる文章がありません');
  const style = p.style === 'haiku'
    ? '俳句を朗読します。五・七・五の切れ目でたっぷり間をとり、静かに、情景が浮かぶように詠んでください：'
    : '旅の語り部として、落ち着いたやわらかな声で、ゆっくり語りかけるように読み上げてください：';
  const voice = str_(p.voice, 40) || prop_('TTS_VOICE', 'Charon');
  const model = prop_('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');

  // 同じ文章・声はDriveにキャッシュして再利用（API節約）
  const keyBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, model + '|' + voice + '|' + style + '|' + text, Utilities.Charset.UTF_8);
  const cacheName = keyBytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('') + '.json';
  const folder = ttsFolder_();
  const hit = folder.getFilesByName(cacheName);
  if (hit.hasNext()) {
    const cached = JSON.parse(hit.next().getBlob().getDataAsString());
    return { audio: cached.audio, mimeType: cached.mimeType, cached: true };
  }

  checkAiQuota_(user);
  const body = geminiFetch_(model, {
    contents: [{ parts: [{ text: style + '\n' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });
  const part = body.candidates && body.candidates[0] && body.candidates[0].content &&
    body.candidates[0].content.parts && body.candidates[0].content.parts.find(x => x.inlineData);
  if (!part) fail_('AI_ERROR', '音声を生成できませんでした');
  const out = { audio: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/L16;rate=24000' };
  try { folder.createFile(cacheName, JSON.stringify(out), 'application/json'); } catch (e) { /* キャッシュ失敗は無視 */ }
  return out;
}

/* ===================== 訪問ログ・メディア（Drive） ===================== */

function uploadRoot_() {
  const id = prop_('DRIVE_FOLDER_ID', '');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder('tabimakura_uploads');
  PropertiesService.getScriptProperties().setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function logOut_(l) {
  return {
    logId: l.log_id, userId: l.user_id, userName: l.user_name, spotId: l.spot_id,
    visitedOn: l.visited_on, note: l.note, mediaType: l.media_type, fileId: l.file_id, createdAt: l.created_at
  };
}

function addLog_(p) {
  const user = requireUser_(p);
  const spot = findSpot_(str_(p.spotId, 100));
  const visitedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(p.visitedOn || '')) ? p.visitedOn
    : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const note = str_(p.note, 300);

  let mediaType = '';
  let fileId = '';
  if (p.file && p.file.base64) {
    const mime = String(p.file.mimeType || '');
    if (!/^(image|video)\//.test(mime)) fail_('INVALID', '写真または動画のみ投稿できます');
    const bytes = Utilities.base64Decode(p.file.base64);
    if (bytes.length > MAX_UPLOAD_BYTES) fail_('TOO_LARGE', 'ファイルが大きすぎます（30MBまで）');
    const ext = (str_(p.file.name, 100).match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0];
    const name = spot.spot_id + '_' + user.user_id + '_' + Date.now() + ext;
    let folder = uploadRoot_();
    const sub = folder.getFoldersByName(spot.spot_id);
    folder = sub.hasNext() ? sub.next() : folder.createFolder(spot.spot_id);
    const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('共有設定に失敗', e); }
    mediaType = mime.indexOf('video/') === 0 ? 'video' : 'image';
    fileId = file.getId();
  }

  const log = {
    log_id: id_('l'), user_id: user.user_id, user_name: user.user_name, spot_id: spot.spot_id,
    visited_on: visitedOn, note: note, media_type: mediaType, file_id: fileId, created_at: now_()
  };
  withLock_(() => append_('Logs', log));
  return { log: logOut_(log), message: spot.name + 'の旅の記録を残しました' };
}

function deleteLog_(p) {
  const user = requireUser_(p);
  const logId = str_(p.logId, 100);
  return withLock_(() => {
    const l = readAll_('Logs').find(x => x.log_id === logId);
    if (!l) fail_('NOT_FOUND', '記録が見つかりません');
    if (l.user_id !== user.user_id) fail_('FORBIDDEN', '自分の記録のみ削除できます');
    if (l.file_id) { try { DriveApp.getFileById(l.file_id).setTrashed(true); } catch (e) { /* 既に無い */ } }
    sheet_('Logs').deleteRow(l._row);
    return { message: '記録を削除しました' };
  });
}

function getSpotLogs_(p) {
  const spotId = str_(p.spotId, 100);
  const logs = readAll_('Logs')
    .filter(l => l.spot_id === spotId && l.file_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 40)
    .map(logOut_);
  return { logs: logs };
}

function getMyPage_(p) {
  const user = requireUser_(p);
  const logs = readAll_('Logs').filter(l => l.user_id === user.user_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(logOut_);
  const commentCount = readAll_('Comments').filter(c => c.user_id === user.user_id && !bool_(c.deleted)).length;
  return { user: publicUser_(user), logs: logs, commentCount: commentCount };
}

/* ===================== コメント ===================== */

function commentOut_(c, userId) {
  const likes = String(c.likes || '').split(',').filter(Boolean);
  return {
    commentId: c.comment_id, spotId: c.spot_id, userId: c.user_id, userName: c.user_name, text: c.text,
    likeCount: likes.length, likedByMe: !!userId && likes.indexOf(userId) >= 0,
    mine: !!userId && c.user_id === userId,
    createdAt: c.created_at, updatedAt: c.updated_at, edited: !!c.updated_at && c.updated_at !== c.created_at
  };
}

function getComments_(p) {
  const spotId = str_(p.spotId, 100);
  const user = userFromToken_(p.token);
  const uid = user ? user.user_id : '';
  const comments = readAll_('Comments')
    .filter(c => c.spot_id === spotId && !bool_(c.deleted))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(c => commentOut_(c, uid));
  return { comments: comments };
}

function addComment_(p) {
  const user = requireUser_(p);
  const spot = findSpot_(str_(p.spotId, 100));
  const text = str_(p.text, 500);
  if (!text) fail_('INVALID', 'コメントを入力してください');
  const t = now_();
  const c = { comment_id: id_('c'), spot_id: spot.spot_id, user_id: user.user_id, user_name: user.user_name,
    text: text, likes: '', created_at: t, updated_at: t, deleted: false };
  withLock_(() => append_('Comments', c));
  return { comment: commentOut_(c, user.user_id) };
}

function ownComment_(user, commentId) {
  const c = readAll_('Comments').find(x => x.comment_id === commentId && !bool_(x.deleted));
  if (!c) fail_('NOT_FOUND', 'コメントが見つかりません');
  if (c.user_id !== user.user_id) fail_('FORBIDDEN', '自分のコメントのみ変更できます');
  return c;
}

function updateComment_(p) {
  const user = requireUser_(p);
  const text = str_(p.text, 500);
  if (!text) fail_('INVALID', 'コメントを入力してください');
  return withLock_(() => {
    const c = ownComment_(user, str_(p.commentId, 100));
    const t = now_();
    update_('Comments', c._row, { text: text, updated_at: t });
    c.text = text; c.updated_at = t;
    return { comment: commentOut_(c, user.user_id) };
  });
}

function deleteComment_(p) {
  const user = requireUser_(p);
  return withLock_(() => {
    const c = ownComment_(user, str_(p.commentId, 100));
    update_('Comments', c._row, { deleted: true, updated_at: now_() });
    return { message: 'コメントを削除しました' };
  });
}

function toggleLike_(p) {
  const user = requireUser_(p);
  const commentId = str_(p.commentId, 100);
  return withLock_(() => {
    const c = readAll_('Comments').find(x => x.comment_id === commentId && !bool_(x.deleted));
    if (!c) fail_('NOT_FOUND', 'コメントが見つかりません');
    let likes = String(c.likes || '').split(',').filter(Boolean);
    const i = likes.indexOf(user.user_id);
    if (i >= 0) likes.splice(i, 1); else likes.push(user.user_id);
    update_('Comments', c._row, { likes: likes.join(',') });
    c.likes = likes.join(',');
    return { comment: commentOut_(c, user.user_id) };
  });
}

/* ===================== 初期セットアップ（エディタから1回実行） ===================== */

function setup() {
  Object.keys(HEADERS).forEach(name => sheet_(name));
  const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('PEPPER')) sp.setProperty('PEPPER', randomString_(40));
  uploadRoot_();

  if (readAll_('Themes').length === 0) {
    append_('Themes', {
      theme_id: 'okuno-hosomichi', name: '奥の細道', subtitle: '芭蕉と曾良、百五十日の旅路',
      description: '元禄2年（1689年）、松尾芭蕉は門人・曾良を伴い江戸深川を出立。東北・北陸を巡り大垣で旅を結んだ約2,400kmの紀行をたどります。',
      guide_name: '旅の供・曾良', sort: 1, active: true
    });
  }
  if (readAll_('Spots').length === 0) {
    const T = 'okuno-hosomichi';
    const B = '松尾芭蕉';
    const rows = [
      ['深川・採荼庵跡', 'ふかがわ', '東京都江東区', 35.6807, 139.7988, '草の戸も　住替る代ぞ　ひなの家', B, '春', '旅立ちを前に芭蕉が住まいを人に譲り、門人・杉山杉風の別宅「採荼庵」に移った地。ここから舟で隅田川をさかのぼりました。'],
      ['千住', 'せんじゅ', '東京都足立区・荒川区', 35.7464, 139.7966, '行春や　鳥啼魚の　目は泪', B, '春', '舟を下りた芭蕉が見送りの人々と別れた旅の起点。千住大橋のたもとに矢立初めの碑が立ちます。'],
      ['日光', 'にっこう', '栃木県日光市', 36.7580, 139.5990, 'あらたふと　青葉若葉の　日の光', B, '夏', '東照宮に参詣し、地名「日光」に掛けて陽光を讃えた句を残しました。'],
      ['雲巌寺（黒羽）', 'うんがんじ', '栃木県大田原市', 36.8728, 140.1453, '木啄も　庵はやぶらず　夏木立', B, '夏', '黒羽に長く逗留した芭蕉は、参禅の師・仏頂和尚が修行した山居の跡を訪ねました。'],
      ['白河の関', 'しらかわのせき', '福島県白河市', 37.0444, 140.2550, '卯の花を　かざしに関の　晴着かな', '河合曾良', '夏', '古来、多くの歌人が詠んだみちのくの入口。芭蕉はここで旅心が定まったと記し、曾良が句を詠みました。'],
      ['須賀川', 'すかがわ', '福島県須賀川市', 37.2860, 140.3720, '風流の　初やおくの　田植うた', B, '夏', '旧知の相楽等躬のもとに滞在。みちのくで初めて聞いた田植え歌に風流の始まりを見出しました。'],
      ['松島', 'まつしま', '宮城県宮城郡松島町', 38.3700, 141.0600, '松島や　鶴に身をかれ　ほととぎす', '河合曾良', '夏', '旅の大きな目的地のひとつ。絶景を前に芭蕉は句を詠まず、曾良の句が記されています。'],
      ['平泉・高館', 'ひらいずみ・たかだち', '岩手県西磐井郡平泉町', 38.9939, 141.1180, '夏草や　兵どもが　夢の跡', B, '夏', '源義経最期の地とされる高館に登り、奥州藤原氏の栄華と戦の跡を偲んで涙したと記しています。'],
      ['中尊寺金色堂', 'ちゅうそんじ', '岩手県西磐井郡平泉町', 38.9870, 141.0990, '五月雨の　降のこしてや　光堂', B, '夏', '数百年の風雨に耐えて輝きを残す金色堂を、五月雨さえ避けて降ったかのようだと詠みました。'],
      ['尿前の関', 'しとまえのせき', '宮城県大崎市', 38.7400, 140.7000, '蚤虱　馬の尿する　枕もと', B, '夏', '出羽への山越えで関守に怪しまれ、大雨で封人の家に足止め。旅の苦労をユーモラスに詠んだ一句。'],
      ['尾花沢', 'おばなざわ', '山形県尾花沢市', 38.6000, 140.4060, '涼しさを　我宿にして　ねまる也', B, '夏', '紅花問屋の鈴木清風に厚くもてなされ、十日ほど滞在しました。'],
      ['立石寺（山寺）', 'りっしゃくじ', '山形県山形市', 38.3125, 140.4372, '閑さや　岩にしみ入る　蝉の声', B, '夏', '人々に勧められて立ち寄った岩山の寺。奥の細道で最もよく知られた句のひとつが生まれました。'],
      ['最上川（大石田）', 'もがみがわ', '山形県北村山郡大石田町', 38.5930, 140.3730, '五月雨を　あつめて早し　最上川', B, '夏', '舟運で栄えた大石田で川下りを待ち、増水した最上川の勢いを詠みました。'],
      ['羽黒山', 'はぐろさん', '山形県鶴岡市', 38.7020, 139.9850, '有難や　雪をかほらす　南谷', B, '夏', '出羽三山を巡拝。羽黒山・月山・湯殿山でそれぞれ句を残しています。'],
      ['酒田', 'さかた', '山形県酒田市', 38.9140, 139.8370, '暑き日を　海にいれたり　最上川', B, '夏', '最上川の河口、北前船で栄えた港町。日本海に沈む夕日を雄大に詠みました。'],
      ['象潟（蚶満寺）', 'きさかた', '秋田県にかほ市', 39.2133, 139.9083, '象潟や　雨に西施が　ねぶの花', B, '夏', '旅の北限。当時は松島と並ぶ多島の潟湖でしたが、のちの地震で隆起し、今は田の中に島々が残ります。'],
      ['出雲崎', 'いずもざき', '新潟県三島郡出雲崎町', 37.5300, 138.7100, '荒海や　佐渡によこたふ　天河', B, '秋', '日本海の向こうの佐渡と、夜空に横たわる天の川を一句に収めた雄大な句。'],
      ['市振', 'いちぶり', '新潟県糸魚川市', 36.9850, 137.6600, '一家に　遊女もねたり　萩と月', B, '秋', '親不知の難所を越えた宿で、伊勢参りの遊女と同宿した一夜を詠みました。'],
      ['金沢', 'かなざわ', '石川県金沢市', 36.5610, 136.6560, 'あかあかと　日は難面も　あきの風', B, '秋', '会うのを楽しみにしていた俳人・一笑の早世を知り、追善の句会に臨みました。'],
      ['多太神社（小松）', 'ただじんじゃ', '石川県小松市', 36.4120, 136.4440, 'むざんやな　甲の下の　きりぎりす', B, '秋', '老武者・斎藤実盛の遺品と伝わる甲を拝し、その最期を悼みました。'],
      ['那谷寺', 'なたでら', '石川県小松市', 36.3330, 136.4290, '石山の　石より白し　秋の風', B, '秋', '奇岩が連なる古刹。白い岩肌と秋風の清らかさを重ねて詠みました。'],
      ['山中温泉', 'やまなかおんせん', '石川県加賀市', 36.2450, 136.3770, '山中や　菊はたおらぬ　湯の匂', B, '秋', '温泉を楽しみ、ここで体調を崩した曾良と別れることになりました。'],
      ['敦賀・気比神宮', 'つるが・けひじんぐう', '福井県敦賀市', 35.6540, 136.0750, '月清し　遊行のもてる　砂の上', B, '秋', '遊行上人が参道に砂を運んだという「お砂持ち」の故事を聞き、月明かりの参道を詠みました。'],
      ['大垣（結びの地）', 'おおがき', '岐阜県大垣市', 35.3650, 136.6150, '蛤の　ふたみにわかれ　行秋ぞ', B, '秋', '約150日の旅の終着。門人たちに迎えられたのち、芭蕉はすぐ伊勢へ舟で旅立ちました。']
    ];
    rows.forEach((r, i) => append_('Spots', {
      spot_id: 'oku-' + ('0' + (i + 1)).slice(-2), theme_id: T, order: i + 1, name: r[0], kana: r[1], pref: r[2],
      lat: r[3], lng: r[4], haiku: r[5], haiku_author: r[6], season: r[7], description: r[8], earth_video_url: '', image_url: ''
    }));
  }
  console.log('セットアップ完了。DRIVE_FOLDER_ID=' + sp.getProperty('DRIVE_FOLDER_ID'));
}

/** Gemini接続テスト（エディタから実行） */
function testGemini() {
  const body = geminiFetch_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), {
    contents: [{ role: 'user', parts: [{ text: '「閑さや」の句を一行で紹介して' }] }]
  });
  console.log(JSON.stringify(body).slice(0, 500));
}

/** メール送信の権限承認用（エディタから1回実行） */
function authorizeMail() {
  console.log('残りメール送信数: ' + MailApp.getRemainingDailyQuota());
}

/** 期限切れセッションの掃除（時間主導トリガーで1日1回推奨） */
function cleanupSessions() {
  withLock_(() => {
    const sh = sheet_('Sessions');
    readAll_('Sessions').filter(s => new Date(s.expires_at).getTime() < Date.now())
      .map(s => s._row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  });
}
