/* 旅枕 — フロントエンド  (config.js の後に読み込み) */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const KEY = { session: 'tabimakura_session', settings: 'tabimakura_settings', departed: 'tabimakura_departed', helpHidden: 'tabimakura_help_hidden' };

  const state = {
    token: null, user: null,
    themes: [], themeId: null, spots: [], visited: new Set(), myLogs: [],
    map: null, layers: {}, markers: {}, route: null,
    currentSpot: null, aiAnswers: [], comments: [], commentTimer: null, editingComment: null,
    tour: null, audio: null, speakingBtn: null, ttsCache: new Map(),
    settings: {}
  };

  /* ============ 小道具 ============ */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const spotById = (id) => state.spots.find(s => s.spotId === id);

  function toast(msg, type = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = msg;
    $('#toast').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.innerHTML = `${esc(label || '処理中')}<span class="loading-dots"></span>`; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }

  /* ============ 設定・セッション ============ */
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY.settings) || '{}'); } catch (e) { s = {}; }
    state.settings = {
      gasUrl: s.gasUrl || '',
      ttsEngine: s.ttsEngine || CFG.DEFAULT_TTS_ENGINE || 'gemini',
      speechRate: Number(s.speechRate || CFG.DEFAULT_SPEECH_RATE || 1)
    };
  }
  function saveSettings() {
    try { localStorage.setItem(KEY.settings, JSON.stringify(state.settings)); } catch (e) { /* 保存不可 */ }
  }
  const gasUrl = () => (state.settings.gasUrl || CFG.GAS_API_URL || '').trim();

  function loadSession() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        const s = JSON.parse(store.getItem(KEY.session) || 'null');
        if (s && s.token) { state.token = s.token; state.user = s.user; return; }
      } catch (e) { /* 無視 */ }
    }
  }
  function saveSession(token, user, remember) {
    state.token = token; state.user = user;
    const data = JSON.stringify({ token, user });
    try {
      if (remember === undefined) remember = !!localStorage.getItem(KEY.session);
      localStorage.removeItem(KEY.session); sessionStorage.removeItem(KEY.session);
      (remember ? localStorage : sessionStorage).setItem(KEY.session, data);
    } catch (e) { /* 保存不可 */ }
    updateUserUI();
  }
  function clearSession() {
    state.token = null; state.user = null; state.visited = new Set(); state.myLogs = [];
    try { localStorage.removeItem(KEY.session); sessionStorage.removeItem(KEY.session); } catch (e) { /* 無視 */ }
    updateUserUI();
  }
  const loggedIn = () => !!(state.token && state.user && !state.user.mustChange);

  /* ============ API ============ */
  async function api(action, data = {}) {
    const url = gasUrl();
    if (!url) {
      openSettings();
      throw new Error('GAS のURLが未設定です。設定画面で入力してください');
    }
    const body = Object.assign({ action }, data);
    if (state.token && !body.token) body.token = state.token;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    } catch (e) {
      throw new Error('サーバーに接続できませんでした。通信状況かGASのURLを確認してください');
    }
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('サーバーの応答を読み取れませんでした（GASのデプロイ設定を確認してください）'); }
    if (!json.ok) {
      if (json.error === 'AUTH_REQUIRED') { clearSession(); refreshVisited(); }
      if (json.error === 'MUST_CHANGE') openAuth('change', { forced: true });
      const err = new Error(json.message || json.error || 'エラーが発生しました');
      err.code = json.error;
      throw err;
    }
    return json;
  }

  /* ============ 起動 ============ */
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    loadSettings();
    loadSession();
    const ver = CFG.VERSION || 'v1.0.0';
    $('#versionLabel').textContent = ver;
    $('#settingsVersion').textContent = ver;

    initSplash();
    initMap();
    bindUI();
    updateUserUI();

    if (!gasUrl()) {
      toast('最初に「設定」から GAS のURLを入力してください', 'error', 6000);
      return;
    }
    if (state.token) verifySession();
    await loadThemes();
  }

  async function verifySession() {
    try {
      const r = await api('me');
      saveSession(state.token, r.user);
      if (r.user.mustChange) openAuth('change', { forced: true });
      else loadMyLogs();
    } catch (e) {
      if (e.code !== 'AUTH_REQUIRED') console.warn(e);
      else toast('ログインの有効期限が切れました。もう一度ログインしてください');
    }
  }

  /* ============ オープニング ============ */
  function initSplash() {
    const splash = $('#splash');
    if (sessionStorage.getItem(KEY.departed)) { splash.remove(); return; }
    $('#btnDepart').addEventListener('click', () => {
      try { sessionStorage.setItem(KEY.departed, '1'); } catch (e) { /* 無視 */ }
      if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) { /* 無視 */ } }
      splash.classList.add('leave');
      setTimeout(() => {
        splash.remove();
        state.map && state.map.invalidateSize();
        let hidden = false;
        try { hidden = !!localStorage.getItem(KEY.helpHidden); } catch (e) { /* 無視 */ }
        if (!hidden) openHelp();
      }, 950);
    });
  }

  /* ============ 地図 ============ */
  function initMap() {
    const map = L.map('map', { zoomControl: true, attributionControl: true }).setView(CFG.MAP_CENTER || [37.6, 139.3], CFG.MAP_ZOOM || 6);
    const gsiAttr = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
    state.layers.pale = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18, attribution: gsiAttr });
    state.layers.photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { maxZoom: 18, attribution: gsiAttr });
    state.layers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
    state.layers.pale.addTo(map);
    L.control.layers({ '淡色地図': state.layers.pale, '航空写真': state.layers.photo, 'OpenStreetMap': state.layers.osm }, null, { position: 'topleft' }).addTo(map);
    state.map = map;
    window.addEventListener('resize', () => map.invalidateSize());
  }

  function setBaseLayer(name) {
    const map = state.map;
    Object.entries(state.layers).forEach(([k, layer]) => {
      if (k === name) { if (!map.hasLayer(layer)) layer.addTo(map); }
      else if (map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function pinIcon(spot) {
    const cls = ['pin'];
    if (state.visited.has(spot.spotId)) cls.push('visited');
    if (state.currentSpot && state.currentSpot.spotId === spot.spotId) cls.push('active');
    return L.divIcon({ className: '', html: `<div class="${cls.join(' ')}"><span>${spot.order}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], tooltipAnchor: [0, -30] });
  }

  function renderMap(fit = true) {
    const map = state.map;
    Object.values(state.markers).forEach(m => map.removeLayer(m));
    state.markers = {};
    if (state.route) { map.removeLayer(state.route); state.route = null; }
    const pts = [];
    state.spots.forEach(s => {
      if (!isFinite(s.lat) || !isFinite(s.lng)) return;
      const m = L.marker([s.lat, s.lng], { icon: pinIcon(s), title: s.name, keyboard: true })
        .bindTooltip(s.name, { className: 'pin-tip', direction: 'top' })
        .on('click', () => openSpot(s.spotId));
      m.addTo(map);
      state.markers[s.spotId] = m;
      pts.push([s.lat, s.lng]);
    });
    if (pts.length > 1) {
      state.route = L.polyline(pts, { color: '#e3a82f', weight: 3, opacity: .9, className: 'route-line', interactive: false }).addTo(map);
    }
    if (fit && pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }

  function refreshPins() {
    state.spots.forEach(s => { const m = state.markers[s.spotId]; if (m) m.setIcon(pinIcon(s)); });
  }

  /* ============ テーマ・スポット ============ */
  async function loadThemes() {
    try {
      const r = await api('getThemes');
      state.themes = r.themes || [];
      const sel = $('#themeSelect');
      sel.innerHTML = state.themes.map(t => `<option value="${esc(t.themeId)}">${esc(t.name)}</option>`).join('');
      const def = state.themes.find(t => t.themeId === CFG.DEFAULT_THEME_ID) || state.themes[0];
      if (!def) { $('#themeName').textContent = 'テーマがまだありません'; return; }
      sel.value = def.themeId;
      await selectTheme(def.themeId);
    } catch (e) {
      $('#themeName').textContent = '読み込めませんでした';
      toast(e.message, 'error', 6000);
    }
  }

  async function selectTheme(themeId) {
    stopTour();
    state.themeId = themeId;
    const t = state.themes.find(x => x.themeId === themeId) || {};
    $('#themeName').textContent = t.name || '';
    $('#themeSubtitle').textContent = t.subtitle || '';
    $('#themeDesc').textContent = t.description || '';
    $('#spotList').innerHTML = '<li class="spot-item"><span></span><p class="spot-pref">旅路を読み込み中<span class="loading-dots"></span></p></li>';
    try {
      const r = await api('getSpots', { themeId });
      state.spots = r.spots || [];
      state.visited = new Set(r.visited || []);
      renderMap(true);
      renderList();
      renderProgress();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function refreshVisited() {
    if (!state.themeId) return;
    try {
      const r = await api('getSpots', { themeId: state.themeId });
      state.visited = new Set(r.visited || []);
    } catch (e) { state.visited = new Set(); }
    refreshPins(); renderList(); renderProgress();
  }

  function renderList() {
    const cur = state.currentSpot && state.currentSpot.spotId;
    $('#spotList').innerHTML = state.spots.map(s => {
      const v = state.visited.has(s.spotId);
      return `<li class="spot-item${v ? ' visited' : ''}${cur === s.spotId ? ' active' : ''}" data-id="${esc(s.spotId)}" tabindex="0">
        <span class="spot-no">${s.order}</span>
        <div>
          <p class="spot-name">${esc(s.name)}${v ? '<span class="spot-badge">参詣済</span>' : ''}</p>
          <p class="spot-pref">${esc(s.pref)}</p>
          ${s.haiku ? `<p class="spot-haiku">${esc(s.haiku)}</p>` : ''}
        </div>
      </li>`;
    }).join('') || '<li class="spot-item"><span></span><p class="spot-pref">このテーマにはまだスポットがありません</p></li>';
  }

  function renderProgress() {
    const box = $('#progressBox');
    if (!loggedIn() || !state.spots.length) { box.hidden = true; return; }
    const total = state.spots.length;
    const done = state.spots.filter(s => state.visited.has(s.spotId)).length;
    box.hidden = false;
    $('#progressFill').style.width = (done / total * 100) + '%';
    $('#progressText').textContent = done >= total
      ? `全${total}か所を巡りました。旅の結び、おめでとうございます`
      : `${total}か所のうち${done}か所を巡りました。結びの地まであと${total - done}か所`;
  }

  /* ============ スポット詳細 ============ */
  function openSpot(spotId) {
    const s = spotById(spotId);
    if (!s) return;
    stopTour();
    state.currentSpot = s;
    state.aiAnswers = [];
    state.comments = [];
    state.editingComment = null;
    refreshPins();
    $$('.spot-item').forEach(li => li.classList.toggle('active', li.dataset.id === spotId));
    renderSpotBody();
    openModal('spotModal');
    loadComments();
    loadAlbum();
    clearInterval(state.commentTimer);
    state.commentTimer = setInterval(() => { if (!state.editingComment && !document.hidden) loadComments(true); }, CFG.COMMENT_POLL_MS || 15000);
  }

  function renderSpotBody() {
    const s = state.currentSpot;
    const visited = state.visited.has(s.spotId);
    const theme = state.themes.find(t => t.themeId === s.themeId) || {};
    const guide = theme.guideName || '案内人';
    const chips = ['面白い裏話を教えて', 'ここで起きた出来事は？', s.haiku ? '句の意味をやさしく教えて' : null, '今訪ねるなら見どころは？'].filter(Boolean);

    $('#spotBody').innerHTML = `
      <header class="spot-hero">
        <div>
          <p class="meta">第${s.order}の地　${esc(s.pref)}${s.season ? '　' + esc(s.season) + 'の句' : ''}</p>
          <h2 id="spotTitle">${esc(s.name)}</h2>
          <p class="kana">${esc(s.kana)}</p>
          <p class="desc">${esc(s.description)}</p>
          <div id="sealSlot">${visited ? '<span class="visited-seal">参詣</span>' : ''}</div>
        </div>
        ${s.haiku ? `<p class="haiku-tate">${esc(s.haiku)}<small>${esc(s.haikuAuthor)}</small></p>` : ''}
      </header>

      <div class="media-actions">
        ${s.haiku ? '<button class="btn btn-ink" data-act="read-haiku">句を朗読で聞く</button>' : ''}
        <button class="btn btn-ink" data-act="read-desc">解説を聞く</button>
        <button class="btn btn-ghost" data-act="aerial">${s.earthVideoUrl ? '空撮映像を見る' : '空から近づく'}</button>
        <button class="btn btn-ghost" data-act="route">ここへの道順</button>
      </div>

      <section class="section">
        <h3>${esc(guide)}に尋ねる</h3>
        <p class="hint">この地のことを何でも聞いてください。答えは読み上げることもできます。</p>
        ${loggedIn() ? `
          <div class="chips">${chips.map(c => `<button class="chip" data-act="ask-chip">${esc(c)}</button>`).join('')}</div>
          <form class="ask-row" id="askForm">
            <input type="text" name="q" maxlength="200" placeholder="例：この句が詠まれた日の天気は？" aria-label="質問">
            <button class="btn btn-ink" type="submit">尋ねる</button>
          </form>
          <div class="ai-answers" id="aiAnswers"></div>
        ` : loginCta('ログインすると案内人に質問できます')}
      </section>

      <section class="section">
        <h3>旅の記録</h3>
        ${loggedIn() ? `
          <p class="hint">訪れた日と一言、写真や動画を残せます。写真・動画は下の思い出アルバムに公開されます。</p>
          <form class="log-form" id="logForm">
            <label class="field">訪れた日<input type="date" name="visitedOn" value="${today()}" max="${today()}"></label>
            <label class="field">ひとこと（300字まで）<textarea name="note" maxlength="300" placeholder="旅の感想や、その日の出来事"></textarea></label>
            <div class="file-pick">
              <input type="file" name="file" accept="image/*,video/*" aria-label="写真または動画">
              <div id="logPreview"></div>
            </div>
            <div class="btn-row"><button class="btn btn-shu" type="submit">${visited ? '記録を追加する' : '参詣を記録する'}</button></div>
          </form>
          <div class="my-logs" id="myLogs"></div>
        ` : loginCta('ログインすると訪問を記録して御朱印を集められます')}
      </section>

      <section class="section">
        <h3>みんなの思い出アルバム</h3>
        <div class="album" id="album"><p class="empty">読み込み中…</p></div>
      </section>

      <section class="section">
        <h3>旅人の声</h3>
        <ul class="comments" id="comments"><li class="empty">読み込み中…</li></ul>
        ${loggedIn() ? `
          <form class="comment-form" id="commentForm">
            <textarea name="text" maxlength="500" placeholder="この地の感想や、旅のヒントを残しましょう" aria-label="コメント"></textarea>
            <div class="btn-row"><button class="btn btn-ink" type="submit">声を残す</button></div>
          </form>` : loginCta('ログインするとコメントを残せます')}
      </section>`;

    renderMyLogs();
  }

  function loginCta(text) {
    return `<div class="login-cta"><span>${esc(text)}</span><button class="btn btn-ink btn-sm" data-act="login">ログイン</button></div>`;
  }

  function onSpotClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const s = state.currentSpot;
    const act = btn.dataset.act;
    if (act === 'read-haiku') speak(`${s.haikuAuthor}。${s.haiku}`, 'haiku', btn);
    else if (act === 'read-desc') speak(`${s.name}。${s.description}`, 'guide', btn);
    else if (act === 'aerial') showAerial(s);
    else if (act === 'route') window.open(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, '_blank', 'noopener');
    else if (act === 'login') openAuth('login');
    else if (act === 'ask-chip') askGuide(btn.textContent);
    else if (act === 'read-ai') { const a = state.aiAnswers[Number(btn.dataset.idx)]; if (a) speak(a.answer, 'guide', btn); }
    else if (act === 'del-log') deleteLog(btn.dataset.id, btn);
    else if (act === 'media') openMedia(btn.dataset.type, btn.dataset.file);
    else if (act === 'like') toggleLike(btn.dataset.id);
    else if (act === 'edit-c') editComment(btn.dataset.id);
    else if (act === 'del-c') deleteComment(btn.dataset.id);
    else if (act === 'save-c') saveComment(btn.dataset.id, btn);
    else if (act === 'cancel-c') { state.editingComment = null; renderComments(); }
  }

  function onSpotSubmit(e) {
    const form = e.target;
    e.preventDefault();
    if (form.id === 'askForm') { const q = form.q.value.trim(); if (q) { askGuide(q); form.q.value = ''; } }
    else if (form.id === 'logForm') submitLog(form);
    else if (form.id === 'commentForm') addComment(form);
  }

  /* ============ 空撮 ============ */
  function showAerial(s) {
    if (s.earthVideoUrl) { openVideo(s.earthVideoUrl); return; }
    // Earth Studio 映像が未登録のときは、航空写真で上空から舞い降りる演出
    closeModal('spotModal');
    toast('空撮映像は準備中です。航空写真で上空から近づきます');
    const map = state.map;
    setBaseLayer('photo');
    map.flyTo([s.lat, s.lng], 8, { duration: 1.6 });
    map.once('moveend', () => {
      setTimeout(() => map.flyTo([s.lat, s.lng], 16, { duration: 3.2 }), 300);
    });
  }

  function videoEmbed(url) {
    const u = String(url).trim();
    const drive = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{10,})/);
    if (drive) return `<iframe src="https://drive.google.com/file/d/${drive[1]}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    const yt = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
    if (yt) return `<iframe src="https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
    return `<video src="${esc(u)}" controls autoplay playsinline></video>`;
  }

  function openVideo(url) {
    stopAudio();
    $('#videoBody').innerHTML = videoEmbed(url);
    openModal('videoModal');
  }

  function openMedia(type, fileId) {
    stopAudio();
    $('#videoBody').innerHTML = type === 'video'
      ? `<iframe src="https://drive.google.com/file/d/${esc(fileId)}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe>`
      : `<img src="https://drive.google.com/thumbnail?id=${esc(fileId)}&sz=w1920" alt="投稿写真">`;
    openModal('videoModal');
  }

  /* ============ 音声（Gemini TTS / ブラウザ） ============ */
  function stopAudio() {
    if (state.audio) { state.audio.pause(); state.audio = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (state.speakingBtn) { state.speakingBtn.classList.remove('playing'); if (state.speakingBtn.dataset.label) state.speakingBtn.textContent = state.speakingBtn.dataset.label; state.speakingBtn.disabled = false; }
    state.speakingBtn = null;
  }

  async function speak(text, style, btn) {
    if (state.speakingBtn === btn) { stopAudio(); return; }
    stopAudio();
    const useGemini = state.settings.ttsEngine === 'gemini' && loggedIn();
    if (useGemini) {
      const key = style + '|' + text;
      try {
        let url = state.ttsCache.get(key);
        if (!url) {
          busy(btn, true, '声を用意しています');
          const r = await api('tts', { text, style });
          url = audioUrl(r.audio, r.mimeType);
          state.ttsCache.set(key, url);
          busy(btn, false);
        }
        playUrl(url, btn);
        return;
      } catch (e) {
        busy(btn, false);
        toast('Geminiの声を使えなかったため、ブラウザの声で読み上げます（' + e.message + '）', 'error', 5000);
      }
    }
    speakBrowser(text, btn);
  }

  function markPlaying(btn) {
    if (!btn) return;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = '止める';
    btn.classList.add('playing');
    state.speakingBtn = btn;
  }

  function playUrl(url, btn) {
    const audio = new Audio(url);
    audio.playbackRate = state.settings.speechRate || 1;
    state.audio = audio;
    markPlaying(btn);
    audio.addEventListener('ended', stopAudio);
    audio.play().catch(() => { stopAudio(); toast('音声を再生できませんでした。もう一度押してください', 'error'); });
  }

  function speakBrowser(text, btn) {
    if (!('speechSynthesis' in window)) { toast('このブラウザは読み上げに対応していません', 'error'); return; }
    const u = new SpeechSynthesisUtterance(text.replace(/　/g, '、 '));
    u.lang = 'ja-JP';
    u.rate = state.settings.speechRate || 1;
    const ja = speechSynthesis.getVoices().find(v => /ja/i.test(v.lang));
    if (ja) u.voice = ja;
    u.onend = stopAudio;
    u.onerror = stopAudio;
    markPlaying(btn);
    speechSynthesis.speak(u);
  }

  // Gemini TTS は PCM(L16) を返すので WAV ヘッダを付ける
  function audioUrl(b64, mimeType = '') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!/L16|pcm/i.test(mimeType)) return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'audio/wav' }));
    const rate = Number((mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
    const buf = new ArrayBuffer(44 + bytes.length);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + bytes.length, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, bytes.length, true);
    new Uint8Array(buf, 44).set(bytes);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /* ============ AIガイド ============ */
  async function askGuide(question) {
    const s = state.currentSpot;
    const box = $('#aiAnswers');
    if (!box) return;
    const holder = document.createElement('div');
    holder.innerHTML = `<p class="ai-q">問：${esc(question)}</p><p class="ai-a">案内人が思い出しています<span class="loading-dots"></span></p>`;
    box.prepend(holder);
    $$('#askForm button, .chip').forEach(b => b.disabled = true);
    try {
      const r = await api('aiGuide', { spotId: s.spotId, question });
      if (state.currentSpot !== s) return;
      const idx = state.aiAnswers.push({ question, answer: r.answer }) - 1;
      holder.innerHTML = `<p class="ai-q">問：${esc(question)}</p>
        <p class="ai-a">${esc(r.answer)}</p>
        <div class="ai-a-foot"><span>${esc(r.guideName)}の話（AIによる案内です。史実は資料でご確認ください）</span>
        <button class="btn btn-ghost btn-sm" data-act="read-ai" data-idx="${idx}">読み上げる</button></div>`;
    } catch (e) {
      holder.innerHTML = `<p class="ai-q">問：${esc(question)}</p><p class="ai-a">${esc(e.message)}</p>`;
    } finally {
      $$('#askForm button, .chip').forEach(b => b.disabled = false);
    }
  }

  /* ============ 旅の記録 ============ */
  async function loadMyLogs() {
    if (!loggedIn()) { state.myLogs = []; return; }
    try {
      const r = await api('getMyPage');
      state.myLogs = r.logs || [];
      if (state.currentSpot) renderMyLogs();
    } catch (e) { console.warn(e); }
  }

  function logCard(l, opts = {}) {
    const media = l.fileId
      ? `<button data-act="media" data-type="${esc(l.mediaType)}" data-file="${esc(l.fileId)}" aria-label="拡大して見る">${l.mediaType === 'video'
          ? '<span>▶ 動画を再生</span>'
          : `<img src="https://drive.google.com/thumbnail?id=${esc(l.fileId)}&sz=w600" alt="" loading="lazy">`}</button>`
      : '<span>写真なし</span>';
    const spotName = opts.showSpot ? (spotById(l.spotId) || {}).name || '' : '';
    return `<div class="log-card">
      <div class="thumb">${media}</div>
      <div class="cap">
        ${spotName ? `<p><strong>${esc(spotName)}</strong></p>` : ''}
        <p class="by">${esc(l.visitedOn)}${opts.showUser ? '　' + esc(l.userName) : ''}</p>
        ${l.note ? `<p>${esc(l.note)}</p>` : ''}
        ${opts.deletable ? `<button class="del" data-act="del-log" data-id="${esc(l.logId)}">この記録を削除</button>` : ''}
      </div>
    </div>`;
  }

  function renderMyLogs() {
    const box = $('#myLogs');
    if (!box || !state.currentSpot) return;
    const mine = state.myLogs.filter(l => l.spotId === state.currentSpot.spotId);
    box.innerHTML = mine.map(l => logCard(l, { deletable: true })).join('');
  }

  async function loadAlbum() {
    const s = state.currentSpot;
    try {
      const r = await api('getSpotLogs', { spotId: s.spotId });
      if (state.currentSpot !== s) return;
      const box = $('#album');
      if (!box) return;
      box.innerHTML = (r.logs || []).map(l => logCard(l, { showUser: true })).join('')
        || '<p class="empty">まだ写真がありません。最初の一枚を残してみませんか。</p>';
    } catch (e) {
      const box = $('#album'); if (box) box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    }
  }

  function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
      r.readAsDataURL(blob);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
  }

  async function filePayload(file) {
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) throw new Error('写真または動画を選んでください');
    if (isImage && file.type !== 'image/gif') {
      try {
        const url = URL.createObjectURL(file);
        const img = await loadImage(url);
        URL.revokeObjectURL(url);
        const edge = CFG.IMAGE_MAX_EDGE || 1920;
        const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
        if (blob) return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg', base64: await readAsBase64(blob) };
      } catch (e) { /* HEICなど縮小できない形式はそのまま送る */ }
    }
    const limit = (isVideo ? CFG.MAX_VIDEO_MB || 20 : CFG.MAX_IMAGE_MB || 15) * 1024 * 1024;
    if (file.size > limit) throw new Error(`${isVideo ? '動画' : '写真'}は${Math.round(limit / 1048576)}MBまでです。短く切るか画質を下げてください`);
    return { name: file.name, mimeType: file.type, base64: await readAsBase64(file) };
  }

  function onFilePicked(e) {
    if (e.target.name !== 'file') return;
    const f = e.target.files[0];
    const pv = $('#logPreview');
    if (!pv) return;
    pv.innerHTML = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    pv.innerHTML = f.type.startsWith('video/') ? `<video class="preview" src="${url}" muted playsinline></video>` : `<img class="preview" src="${url}" alt="選んだ写真">`;
  }

  async function submitLog(form) {
    const s = state.currentSpot;
    const btn = form.querySelector('button[type=submit]');
    const wasVisited = state.visited.has(s.spotId);
    busy(btn, true, '記録しています');
    try {
      const data = { spotId: s.spotId, visitedOn: form.visitedOn.value, note: form.note.value.trim() };
      const f = form.file.files[0];
      if (f) data.file = await filePayload(f);
      const r = await api('addLog', data);
      state.myLogs.unshift(r.log);
      state.visited.add(s.spotId);
      form.reset(); form.visitedOn.value = today(); $('#logPreview').innerHTML = '';
      renderMyLogs(); refreshPins(); renderList(); renderProgress();
      $('#sealSlot').innerHTML = '<span class="visited-seal">参詣</span>';
      btn.dataset.label = '記録を追加する';
      toast(wasVisited ? r.message : `${s.name}の御朱印をいただきました`);
      if (r.log.fileId) loadAlbum();
    } catch (e) {
      toast(e.message, 'error', 5000);
    } finally { busy(btn, false); }
  }

  async function deleteLog(logId, btn) {
    if (!confirm('この記録を削除しますか？写真・動画も削除されます。')) return;
    busy(btn, true, '削除中');
    try {
      await api('deleteLog', { logId });
      state.myLogs = state.myLogs.filter(l => l.logId !== logId);
      const visitedNow = new Set(state.myLogs.map(l => l.spotId));
      state.spots.forEach(s => { if (!visitedNow.has(s.spotId)) state.visited.delete(s.spotId); });
      refreshPins(); renderList(); renderProgress();
      if (state.currentSpot) {
        renderMyLogs(); loadAlbum();
        if (!state.visited.has(state.currentSpot.spotId)) $('#sealSlot').innerHTML = '';
      }
      if (!$('#mypageModal').hidden) renderMypage();
      toast('記録を削除しました');
    } catch (e) { busy(btn, false); toast(e.message, 'error'); }
  }

  /* ============ コメント ============ */
  async function loadComments(silent) {
    const s = state.currentSpot;
    if (!s) return;
    try {
      const r = await api('getComments', { spotId: s.spotId });
      if (state.currentSpot !== s) return;
      const next = r.comments || [];
      if (silent && JSON.stringify(next) === JSON.stringify(state.comments)) return;
      state.comments = next;
      renderComments();
    } catch (e) {
      if (!silent) { const ul = $('#comments'); if (ul) ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
    }
  }

  function renderComments() {
    const ul = $('#comments');
    if (!ul) return;
    if (!state.comments.length) { ul.innerHTML = '<li class="empty">まだ声はありません。最初のひとことをどうぞ。</li>'; return; }
    ul.innerHTML = state.comments.map(c => {
      const editing = state.editingComment === c.commentId;
      return `<li class="comment${c.mine ? ' mine' : ''}">
        <div class="comment-head"><strong>${esc(c.userName)}</strong><span>${fmtDate(c.createdAt)}${c.edited ? '（編集済）' : ''}</span></div>
        ${editing
          ? `<textarea id="edit-${esc(c.commentId)}" maxlength="500" rows="3">${esc(c.text)}</textarea>
             <div class="comment-actions"><button data-act="save-c" data-id="${esc(c.commentId)}">保存</button><button data-act="cancel-c">やめる</button></div>`
          : `<p class="comment-text">${esc(c.text)}</p>
             <div class="comment-actions">
               <button class="like${c.likedByMe ? ' on' : ''}" data-act="like" data-id="${esc(c.commentId)}" aria-pressed="${c.likedByMe}" ${loggedIn() ? '' : 'disabled'}>♥ ${c.likeCount}</button>
               ${c.mine ? `<button data-act="edit-c" data-id="${esc(c.commentId)}">編集</button><button data-act="del-c" data-id="${esc(c.commentId)}">削除</button>` : ''}
             </div>`}
      </li>`;
    }).join('');
  }

  async function addComment(form) {
    const text = form.text.value.trim();
    if (!text) return;
    const btn = form.querySelector('button');
    busy(btn, true, '送信中');
    try {
      const r = await api('addComment', { spotId: state.currentSpot.spotId, text });
      state.comments.push(r.comment);
      form.text.value = '';
      renderComments();
    } catch (e) { toast(e.message, 'error'); } finally { busy(btn, false); }
  }

  function editComment(id) {
    state.editingComment = id;
    renderComments();
    const ta = $('#edit-' + CSS.escape(id));
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  async function saveComment(id, btn) {
    const ta = $('#edit-' + CSS.escape(id));
    const text = ta ? ta.value.trim() : '';
    if (!text) { toast('コメントが空です', 'error'); return; }
    btn.disabled = true;
    try {
      const r = await api('updateComment', { commentId: id, text });
      state.comments = state.comments.map(c => c.commentId === id ? r.comment : c);
      state.editingComment = null;
      renderComments();
    } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
  }

  async function deleteComment(id) {
    if (!confirm('このコメントを削除しますか？')) return;
    try {
      await api('deleteComment', { commentId: id });
      state.comments = state.comments.filter(c => c.commentId !== id);
      renderComments();
      toast('コメントを削除しました');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function toggleLike(id) {
    if (!loggedIn()) { openAuth('login'); return; }
    try {
      const r = await api('toggleLike', { commentId: id });
      state.comments = state.comments.map(c => c.commentId === id ? r.comment : c);
      renderComments();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ============ 空から辿る ============ */
  function startTour() {
    if (state.tour) { stopTour(); return; }
    if (!state.spots.length) return;
    closeAllModals();
    state.tour = { i: 0, timer: null };
    $('#tourCaption').hidden = false;
    $('#btnTour span').textContent = '止める';
    if (document.body.classList.contains('view-list')) switchView('map');
    tourStep();
  }

  function tourStep() {
    const t = state.tour;
    if (!t) return;
    if (t.i >= state.spots.length) { stopTour(); toast('旅路を辿り終えました'); return; }
    const s = state.spots[t.i];
    $('#tourNo').textContent = `第${s.order}の地　${s.pref}`;
    $('#tourName').textContent = s.name;
    $('#tourHaiku').textContent = s.haiku || '';
    state.map.flyTo([s.lat, s.lng], 11, { duration: 2.4 });
    const m = state.markers[s.spotId];
    if (m) setTimeout(() => state.tour && m.openTooltip(), 2400);
    t.i++;
    t.timer = setTimeout(tourStep, CFG.TOUR_STEP_MS || 4500);
  }

  function stopTour() {
    if (!state.tour) return;
    clearTimeout(state.tour.timer);
    state.tour = null;
    $('#tourCaption').hidden = true;
    $('#btnTour span').textContent = '空から辿る';
  }

  /* ============ 御朱印帳 ============ */
  async function openMypage() {
    if (!loggedIn()) { openAuth('login'); toast('御朱印帳はログインすると使えます'); return; }
    $('#mypageBody').innerHTML = '<p class="empty">帳面を開いています<span class="loading-dots"></span></p>';
    openModal('mypageModal');
    try {
      const r = await api('getMyPage');
      state.myLogs = r.logs || [];
      state.commentCount = r.commentCount || 0;
      renderMypage();
    } catch (e) { $('#mypageBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  }

  function renderMypage() {
    const total = state.spots.length;
    const done = state.spots.filter(s => state.visited.has(s.spotId)).length;
    const theme = state.themes.find(t => t.themeId === state.themeId) || {};
    const logs = state.myLogs.filter(l => spotById(l.spotId));
    $('#mypageBody').innerHTML = `
      <p class="stamp-stats"><b>${done}</b><span>／ ${total} か所（${esc(theme.name || '')}）　残したコメント ${state.commentCount || 0} 件</span></p>
      <div class="stamps">
        ${state.spots.map((s, i) => {
          const on = state.visited.has(s.spotId);
          return `<button class="stamp${on ? ' on' : ''}" style="--r:${((i * 37) % 21) - 10}deg" data-id="${esc(s.spotId)}" title="${esc(s.name)}">
            <span class="tate">${esc(s.name.replace(/（.*?）/g, ''))}</span></button>`;
        }).join('')}
      </div>
      <h3>旅の記録</h3>
      ${logs.length ? `<div class="my-logs">${logs.map(l => logCard(l, { showSpot: true, deletable: true })).join('')}</div>` : '<p class="empty">まだ記録がありません。地図のスポットを開いて「参詣を記録する」から始めましょう。</p>'}`;
  }

  function onMypageClick(e) {
    const stamp = e.target.closest('.stamp');
    if (stamp) { closeModal('mypageModal'); openSpot(stamp.dataset.id); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'del-log') deleteLog(btn.dataset.id, btn);
    if (btn.dataset.act === 'media') openMedia(btn.dataset.type, btn.dataset.file);
  }

  /* ============ 認証UI ============ */
  const EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_SHUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function initPwToggles() {
    $$('.pw-toggle').forEach(b => {
      b.innerHTML = EYE_OPEN;
      b.addEventListener('click', () => {
        const input = b.parentElement.querySelector('input');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.innerHTML = show ? EYE_SHUT : EYE_OPEN;
        b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      });
    });
  }

  let authForced = false;
  function openAuth(view, opts = {}) {
    authForced = !!opts.forced;
    $$('#authModal .auth-view').forEach(f => {
      f.hidden = f.dataset.view !== view;
      $('.form-msg', f).textContent = '';
      $('.form-msg', f).classList.remove('ok');
    });
    $('#authClose').hidden = authForced;
    const form = $(`#authModal [data-view="${view}"]`);
    if (view === 'change') {
      $('#changeNote').textContent = authForced
        ? '仮パスワードでログインしました。旅を始める前に、ご自身のパスワードを設定してください。'
        : '現在のパスワードと新しいパスワードを入力してください。';
      if (opts.current) form.currentPassword.value = opts.current;
    }
    if (opts.email && form.email) form.email.value = opts.email;
    if (opts.message) { $('.form-msg', form).innerHTML = opts.message; $('.form-msg', form).classList.add('ok'); }
    $$('input[type=text][name*=assword]', form).forEach(i => i.type = 'password');
    $$('.pw-toggle', form).forEach(b => { b.innerHTML = EYE_OPEN; b.setAttribute('aria-label', 'パスワードを表示'); });
    openModal('authModal');
    const first = $$('input:not([type=checkbox])', form).find(i => !i.value);
    setTimeout(() => (first || $('button[type=submit]', form)).focus(), 50);
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const msg = $('.form-msg', form);
    const btn = $('button[type=submit]', form);
    msg.textContent = ''; msg.classList.remove('ok');
    const view = form.dataset.view;
    busy(btn, true);
    try {
      if (view === 'login') {
        const email = form.email.value.trim(), password = form.password.value;
        if (!email || !password) throw new Error('メールアドレスとパスワードを入力してください');
        const r = await api('login', { email, password });
        saveSession(r.token, r.user, form.remember.checked);
        form.password.value = '';
        if (r.user.mustChange) { openAuth('change', { forced: true, current: password }); return; }
        closeModal('authModal');
        toast(`${r.user.userName}さん、ようこそ`);
        afterLogin();
      } else if (view === 'register') {
        const userName = form.userName.value.trim(), email = form.email.value.trim();
        if (!userName || !email) throw new Error('ユーザー名とメールアドレスを入力してください');
        const r = await api('register', { userName, email });
        form.reset();
        let m = esc(r.message);
        if (r.tempPassword) m += `<br>（テスト表示）仮パスワード：<span class="temp-pw">${esc(r.tempPassword)}</span>`;
        openAuth('login', { email, message: m });
      } else if (view === 'forgot') {
        const email = form.email.value.trim();
        if (!email) throw new Error('メールアドレスを入力してください');
        const r = await api('resetPassword', { email });
        let m = esc(r.message);
        if (r.tempPassword) m += `<br>（テスト表示）仮パスワード：<span class="temp-pw">${esc(r.tempPassword)}</span>`;
        openAuth('login', { email, message: m });
      } else if (view === 'change') {
        const cur = form.currentPassword.value, p1 = form.newPassword.value, p2 = form.newPassword2.value;
        if (!cur || !p1) throw new Error('すべての欄を入力してください');
        if (p1 !== p2) throw new Error('新しいパスワード（確認）が一致しません');
        if (p1.length < 8 || !/[A-Za-z]/.test(p1) || !/[0-9]/.test(p1)) throw new Error('英字と数字を含む8文字以上にしてください');
        const r = await api('changePassword', { currentPassword: cur, newPassword: p1 });
        saveSession(state.token, r.user);
        form.reset();
        const wasForced = authForced;
        authForced = false;
        closeModal('authModal');
        toast('パスワードを設定しました。よい旅を');
        if (wasForced) afterLogin();
      }
    } catch (err) {
      msg.textContent = err.message;
    } finally { busy(btn, false); }
  }

  function afterLogin() {
    refreshVisited();
    loadMyLogs();
    if (state.currentSpot && !$('#spotModal').hidden) renderSpotBody(), renderComments();
  }

  async function logout() {
    hideUserMenu();
    const token = state.token;
    clearSession();
    refreshVisited();
    if (!$('#spotModal').hidden) { renderSpotBody(); renderComments(); }
    closeModal('mypageModal');
    toast('ログアウトしました');
    if (token) { try { await api('logout', { token }); } catch (e) { /* 無視 */ } }
  }

  function updateUserUI() {
    const label = $('#userLabel');
    const btn = $('#btnUser');
    if (state.user && state.token) {
      label.textContent = state.user.userName;
      btn.classList.add('logged');
      $('#userMenuName').textContent = state.user.email;
    } else {
      label.textContent = 'ログイン';
      btn.classList.remove('logged');
    }
    renderProgress();
  }

  function hideUserMenu() { $('#userMenu').hidden = true; }

  /* ============ 設定UI ============ */
  function openSettings() {
    const f = $('#settingsForm');
    f.gasUrl.value = state.settings.gasUrl || '';
    f.querySelectorAll('[name=ttsEngine]').forEach(r => r.checked = r.value === state.settings.ttsEngine);
    f.speechRate.value = state.settings.speechRate;
    $('#rateOut').textContent = '×' + Number(state.settings.speechRate).toFixed(2);
    $('.form-msg', f).textContent = '';
    openModal('settingsModal');
  }

  async function onSettingsSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const before = gasUrl();
    state.settings.gasUrl = f.gasUrl.value.trim();
    state.settings.ttsEngine = (f.querySelector('[name=ttsEngine]:checked') || {}).value || 'gemini';
    state.settings.speechRate = Number(f.speechRate.value);
    saveSettings();
    state.ttsCache.clear();
    closeModal('settingsModal');
    toast('設定を保存しました');
    if (gasUrl() && gasUrl() !== before) {
      if (state.token) verifySession();
      loadThemes();
    }
  }

  async function pingGas() {
    const f = $('#settingsForm');
    const msg = $('.form-msg', f);
    const url = f.gasUrl.value.trim() || CFG.GAS_API_URL;
    msg.classList.remove('ok');
    if (!url) { msg.textContent = 'URLを入力してください'; return; }
    msg.textContent = '接続を確かめています…';
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping' }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.message);
      msg.textContent = `接続できました（サーバー ${j.version}）`;
      msg.classList.add('ok');
    } catch (e) {
      msg.textContent = '接続できませんでした。URLと「アクセスできるユーザー：全員」の設定を確認してください';
    }
  }

  /* ============ 使い方 ============ */
  function openHelp() {
    hideUserMenu();
    let hidden = false;
    try { hidden = !!localStorage.getItem(KEY.helpHidden); } catch (e) { /* 無視 */ }
    $('#helpHide').checked = hidden;
    openModal('helpModal');
    $('#helpModal .help-sheet').scrollTop = 0;
  }

  function saveHelpPref() {
    try {
      if ($('#helpHide').checked) localStorage.setItem(KEY.helpHidden, '1');
      else localStorage.removeItem(KEY.helpHidden);
    } catch (e) { /* 保存不可 */ }
  }

  /* ============ モーダル管理 ============ */
  function openModal(id) {
    const m = $('#' + id);
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    const m = $('#' + id);
    if (!m || m.hidden) return;
    if (id === 'authModal' && authForced) return;
    m.hidden = true;
    if (id === 'spotModal') {
      clearInterval(state.commentTimer);
      stopAudio();
      state.currentSpot = null;
      refreshPins();
      $$('.spot-item.active').forEach(li => li.classList.remove('active'));
    }
    if (id === 'videoModal') $('#videoBody').innerHTML = '';
    if (id === 'helpModal') saveHelpPref();
    if ($$('.modal').every(x => x.hidden)) document.body.style.overflow = '';
  }

  function closeAllModals() { ['videoModal', 'helpModal', 'settingsModal', 'mypageModal', 'spotModal', 'authModal'].forEach(closeModal); }

  function switchView(view) {
    document.body.classList.toggle('view-list', view === 'list');
    $$('.mtab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    if (view === 'map') setTimeout(() => state.map.invalidateSize(), 50);
  }

  /* ============ イベント登録 ============ */
  function bindUI() {
    initPwToggles();

    $('#themeSelect').addEventListener('change', e => selectTheme(e.target.value));
    $('#btnTour').addEventListener('click', startTour);
    $('#btnTourStop').addEventListener('click', stopTour);
    $('#btnMypage').addEventListener('click', openMypage);
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnHelp').addEventListener('click', openHelp);
    $('#helpModal .help-toc').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      const target = $(a.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#btnUser').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.user && state.token) $('#userMenu').hidden = !$('#userMenu').hidden;
      else openAuth('login');
    });
    $('#userMenu').addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      hideUserMenu();
      if (act === 'mypage') openMypage();
      if (act === 'change') openAuth('change', { forced: !!(state.user && state.user.mustChange) });
      if (act === 'logout') logout();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#userMenu')) hideUserMenu(); });

    $('#spotList').addEventListener('click', e => {
      const li = e.target.closest('.spot-item[data-id]');
      if (!li) return;
      const s = spotById(li.dataset.id);
      if (s && window.matchMedia('(min-width: 861px)').matches) state.map.flyTo([s.lat, s.lng], 12, { duration: 1.2 });
      openSpot(li.dataset.id);
    });
    $('#spotList').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { const li = e.target.closest('.spot-item[data-id]'); if (li) { e.preventDefault(); openSpot(li.dataset.id); } }
    });

    const spotBody = $('#spotBody');
    spotBody.addEventListener('click', onSpotClick);
    spotBody.addEventListener('submit', onSpotSubmit);
    spotBody.addEventListener('change', onFilePicked);

    $('#mypageBody').addEventListener('click', onMypageClick);

    $$('#authModal .auth-view').forEach(f => f.addEventListener('submit', onAuthSubmit));
    $$('#authModal [data-goto]').forEach(b => b.addEventListener('click', () => {
      const email = (b.closest('form').email || {}).value;
      openAuth(b.dataset.goto, { email });
    }));

    $('#settingsForm').addEventListener('submit', onSettingsSubmit);
    $('#settingsForm').speechRate.addEventListener('input', e => { $('#rateOut').textContent = '×' + Number(e.target.value).toFixed(2); });
    $('#btnPing').addEventListener('click', pingGas);

    $$('.modal').forEach(m => m.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) closeModal(m.id);
    }));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const open = ['videoModal', 'helpModal', 'settingsModal', 'authModal', 'mypageModal', 'spotModal'].find(id => !$('#' + id).hidden);
      if (open) closeModal(open);
      else stopTour();
    });

    $$('.mtab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

    if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }
})();
