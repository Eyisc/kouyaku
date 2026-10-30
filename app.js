/*
 * 口譯 v1.2 — my own live interpreter (中文 ⇄ 日本語 ⇄ English).
 * Speech: OpenAI gpt-realtime-translate over WebRTC, one session per direction.
 * Typing: OpenAI Responses API. The phrasebook and 繁體 conversion work offline.
 * The API key lives only in this phone's localStorage and is only sent to api.openai.com.
 */
(() => {
  'use strict';

  // During an update a cached older page can meet this newer script: reload once to get the new page.
  if (!document.getElementById('phraseView') || !document.getElementById('typer')) {
    try {
      if (!sessionStorage.getItem('ky.reloaded')) {
        sessionStorage.setItem('ky.reloaded', '1');
        setTimeout(() => location.reload(), 800);
      }
    } catch (e) { /* ignore */ }
    return;
  }
  try { sessionStorage.removeItem('ky.reloaded'); } catch (e) { /* ignore */ }

  const VERSION = '1.2.1';
  const API = 'https://api.openai.com/v1';
  const MODEL = 'gpt-realtime-translate';
  const SOURCE_MODEL = 'gpt-realtime-whisper';
  const TEXT_MODELS = ['gpt-6.1-terra', 'gpt-5.4-mini']; // typed translation: the first one this account can use
  const PRICE = { translate: 0.034, source: 0.017 };    // USD per connected minute (checked 2026-10-30)
  const HOLD_MS = 450;                                   // pressing longer than this = hold-to-talk
  const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.48 4.48 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>';

  /* ---------- helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (ts) => {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  class AppError extends Error {
    constructor(message, code, detail) {
      super(message);
      this.code = code || 'error';
      this.detail = detail || '';
    }
  }

  /* ---------- storage & settings ---------- */
  const K = {
    key: 'ky.key', settings: 'ky.settings', history: 'ky.history', usage: 'ky.usage',
    zh: 'ky.zhcode', textModel: 'ky.textmodel', mine: 'ky.myphrases',
  };
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked or full */ }
    },
    del(k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    },
  };

  const DEFAULTS = {
    mode: 'talk',          // 'talk' (對話) | 'listen' (聆聽) | 'phrases' (常用句)
    myLang: 'zh',          // my language: their words come back in it ('zh' | 'en')
    theirLang: 'ja',       // the other person's language: my words go out in it ('ja' | 'en')
    handsFree: false,      // talk mode without buttons (experimental)
    speakJa: true,         // play the translation that is meant for them
    speakMine: true,       // play the translation that is meant for me
    listenSpeak: false,    // listen mode: play audio (earphones recommended)
    showSource: true,      // source-language subtitles (also helps the auto-stop)
    autoBig: true,         // after "我說", show the translation full screen
    trad: true,            // show Chinese in Traditional characters
    micType: 'near_field', // 'near_field' phone near mouth | 'far_field' phone on table
    silenceMs: 1500,       // tap mode: stop after this much silence
    idleMin: 2,            // hang up after this many idle minutes
  };
  const settings = Object.assign({}, DEFAULTS, store.get(K.settings, {}));
  if (!['talk', 'listen', 'phrases'].includes(settings.mode)) settings.mode = 'talk';
  if (![1000, 1500, 2200].includes(Number(settings.silenceMs))) settings.silenceMs = DEFAULTS.silenceMs;
  const saveSettings = () => store.set(K.settings, settings);
  let apiKey = String(store.get(K.key, '') || '');

  const LANGS = {
    ja: { name: '日本語', word: '日文', tag: 'ja', tts: 'ja-JP' },
    en: { name: 'English', word: '英文', tag: 'en', tts: 'en-US' },
    zh: { name: '中文', word: '中文', tag: 'zh-Hant', tts: 'zh-TW' },
  };
  const langName = (l) => (LANGS[l] ? LANGS[l].name : l);
  const langTag = (l) => (LANGS[l] ? LANGS[l].tag : l);
  // 'mine' = I speak → their language. 'theirs' / 'listen' = they speak → my language.
  // The spoken language is detected automatically, so these only choose the output.
  const targetOf = (dir) => (dir === 'mine' ? settings.theirLang : settings.myLang);
  const sourceOf = (dir) => (dir === 'mine' ? settings.myLang : settings.theirLang);
  const PAIRS = ['zh-ja', 'zh-en', 'en-ja']; // "my language-their language"
  if (!PAIRS.includes(`${settings.myLang}-${settings.theirLang}`)) {
    settings.myLang = DEFAULTS.myLang;
    settings.theirLang = DEFAULTS.theirLang;
  }
  const INTRO = {
    ja: 'すみません、翻訳アプリを使っています。このスマホに向かって、ゆっくり話していただけますか。',
    en: "Excuse me, I'm using a translation app. Could you please speak slowly toward this phone?",
  };
  // Chinese is shown (and read aloud) in Traditional characters with Taiwan wording.
  const showText = (text, lang) => (lang === 'zh' && settings.trad && typeof window.toTrad === 'function' ? window.toTrad(text) : text);
  const guessLang = (text) => {
    if (/[぀-ヿ]/.test(text)) return 'ja';
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const cjk = (text.match(/[㐀-鿿]/g) || []).length;
    return latin > cjk ? 'en' : 'zh';
  };

  /* ---------- OpenAI calls ---------- */
  const diag = { lastError: '', variant: '', textModel: '' };
  const secretCache = new Map(); // "lang|mic|source" -> { value, exp }
  let variantFloor = 0;           // after a config is rejected, start from the simpler one
  let sourceWarned = false;
  let zhCode = String(store.get(K.zh, '') || '');             // 'zh-TW' if OpenAI accepts it, otherwise 'zh'
  let textModel = String(store.get(K.textModel, '') || '');

  async function timedFetch(url, opts, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
    } catch (e) {
      const timeout = e && e.name === 'AbortError';
      throw new AppError(timeout ? '連線逾時，請檢查網路' : '連不上 OpenAI，請檢查網路', 'network', String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  }

  async function httpError(r, what) {
    let body = '';
    try { body = await r.text(); } catch (e) { /* ignore */ }
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body);
      if (j && j.error) detail = j.error.message || j.error.code || detail;
    } catch (e) { /* not JSON */ }
    const name = what || '口譯模型';
    const map = {
      400: '請求被拒絕（設定不被接受）',
      401: 'API 金鑰無效或已被刪除',
      403: `這把金鑰沒有權限使用${name}（檢查專案的模型權限）`,
      404: `找不到${name}（帳號可能還不能用）`,
      429: '額度不足、超過預算上限，或請求太頻繁',
    };
    const base = map[r.status] || (r.status >= 500 ? 'OpenAI 伺服器暫時有問題，稍後再試' : '連線失敗');
    return new AppError(`${base}（${r.status}）`, 'http' + r.status, detail);
  }

  function sessionVariants(lang, mic, source) {
    const input = { noise_reduction: { type: mic } };
    const withSource = Object.assign({}, input);
    if (source) withSource.transcription = { model: SOURCE_MODEL };
    const sess = (inp) => ({ model: MODEL, audio: Object.assign(inp ? { input: inp } : {}, { output: { language: lang } }) });
    return [
      { name: 'full', body: { session: sess(withSource), expires_after: { anchor: 'created_at', seconds: 3600 } } },
      { name: 'no-expiry', body: { session: sess(withSource) } },
      { name: 'no-source', body: { session: sess(input) } },
      { name: 'minimal', body: { session: sess(null) } },
    ];
  }

  async function getSecret(lang, mic, source, opts) {
    const fresh = !!(opts && opts.fresh);
    const sig = [lang, mic, source].join('|');
    const cached = secretCache.get(sig);
    if (!fresh && cached && cached.exp - Date.now() / 1000 > 120) return cached.value;
    if (!apiKey) throw new AppError('還沒設定 OpenAI API 金鑰', 'nokey');
    // Chinese: ask for Taiwan Chinese first, fall back to plain 'zh' if the API rejects it.
    const codes = lang === 'zh' ? (zhCode ? [zhCode] : ['zh-TW', 'zh']) : [lang];
    const count = sessionVariants(lang, mic, source).length;
    let lastErr = null;
    for (let i = variantFloor; i < count; i++) {
      for (const code of codes) {
        const v = sessionVariants(code, mic, source)[i];
        const r = await timedFetch(`${API}/realtime/translations/client_secrets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(v.body),
        }, 15000);
        if (r.ok) {
          let j = null;
          try { j = await r.json(); } catch (e) { /* handled below */ }
          if (!j || !j.value) throw new AppError('OpenAI 回應格式不對（沒有 client secret）', 'format', JSON.stringify(j || {}).slice(0, 300));
          variantFloor = i;
          diag.variant = `${v.name} · ${code}`;
          if (lang === 'zh' && zhCode !== code) {
            zhCode = code;
            store.set(K.zh, code);
          }
          if (source && i >= 2 && !sourceWarned) {
            sourceWarned = true;
            ui.toast('原文字幕暫時不能用，先只顯示翻譯');
          }
          secretCache.set(sig, { value: j.value, exp: Number(j.expires_at) || Date.now() / 1000 + 600 });
          return j.value;
        }
        lastErr = await httpError(r);
        if (r.status !== 400) throw lastErr; // only a rejected config is worth retrying in another form
      }
    }
    throw lastErr;
  }

  const postSdp = (secret, sdp) => timedFetch(`${API}/realtime/translations/calls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
    body: sdp,
  }, 15000);

  const TARGET_DESC = {
    ja: 'natural, polite spoken Japanese (です／ます form) that a traveler can say or show to shop, restaurant and hotel staff in Japan',
    en: 'natural, polite spoken English',
    zh: 'Traditional Chinese as used in Taiwan (繁體中文、台灣用語)',
  };

  function responseText(j) {
    if (!j) return '';
    if (typeof j.output_text === 'string') return j.output_text;
    const parts = [];
    (Array.isArray(j.output) ? j.output : []).forEach((item) => {
      (Array.isArray(item && item.content) ? item.content : []).forEach((c) => {
        if (c && c.type === 'output_text' && c.text) parts.push(c.text);
      });
    });
    return parts.join('');
  }

  async function translateText(text, target) {
    if (!apiKey) throw new AppError('還沒設定 OpenAI API 金鑰', 'nokey');
    const instructions = `You are a professional interpreter helping a traveler from Taiwan. Translate the user's message into ${TARGET_DESC[target]}. Reply with the translation only: no quotes, notes, explanations or romanization. Keep names, numbers, prices, dates and times exact. If the message is already in that language, return it unchanged.`;
    const models = textModel ? [textModel].concat(TEXT_MODELS.filter((m) => m !== textModel)) : TEXT_MODELS.slice();
    let lastErr = null;
    for (const model of models) {
      const r = await timedFetch(`${API}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, instructions, input: text, reasoning: { effort: 'none' }, max_output_tokens: 600, store: false }),
      }, 25000);
      if (r.ok) {
        let j = null;
        try { j = await r.json(); } catch (e) { /* handled below */ }
        const out = responseText(j).trim();
        if (out) {
          diag.textModel = model;
          if (textModel !== model) {
            textModel = model;
            store.set(K.textModel, model);
          }
          return out;
        }
        lastErr = new AppError('翻譯結果是空的，請再試一次', 'empty');
        continue;
      }
      lastErr = await httpError(r, '翻譯模型');
      if (![400, 403, 404].includes(r.status)) break; // only an unavailable model is worth trying the next one
    }
    throw lastErr;
  }

  /* ---------- microphone & level meter ---------- */
  const meter = {
    ctx: null, src: null, an: null, buf: null,
    ensureCtx() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this.ctx && AC) this.ctx = new AC();
      if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    },
    attach(stream) {
      this.ensureCtx();
      if (!this.ctx) return;
      this.detach();
      this.src = this.ctx.createMediaStreamSource(stream);
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = 1024;
      this.buf = new Float32Array(this.an.fftSize);
      this.src.connect(this.an);
    },
    detach() {
      try { if (this.src) this.src.disconnect(); } catch (e) { /* ignore */ }
      this.src = null;
      this.an = null;
    },
    db() {
      if (!this.an) return -100;
      this.an.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      return 10 * Math.log10(sum / this.buf.length + 1e-12);
    },
  };

  const mic = {
    stream: null,
    pending: null,
    get() {
      if (this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live')) return Promise.resolve(this.stream);
      if (this.pending) return this.pending;
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        return Promise.reject(new AppError('這個瀏覽器不能使用麥克風。請用 Safari 或 Chrome 開啟 https 網址。', 'nomic'));
      }
      this.pending = md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      }).then((s) => {
        this.stream = s;
        meter.attach(s);
        return s;
      }).catch((e) => {
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        throw new AppError(
          denied ? '麥克風被拒絕了。請到手機「設定」允許 Safari／這個 App 使用麥克風，再重新開啟。' : `打不開麥克風（${(e && e.name) || '未知原因'}）`,
          'mic', String((e && e.message) || e));
      }).finally(() => { this.pending = null; });
      return this.pending;
    },
    stop() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      meter.detach();
    },
  };

  /* ---------- one translation session (one direction) ---------- */
  class Session {
    constructor(name) {
      this.name = name;       // 'mine' (→ their language) | 'theirs' (→ my language)
      this.state = 'idle';    // idle | connecting | open
      this.pc = null;
      this.dc = null;
      this.track = null;
      this.sig = '';
      this.openedAt = 0;
      this.pending = null;
      this.ducked = false;
      this.audio = h('audio');
      this.audio.autoplay = true;
      this.audio.setAttribute('playsinline', '');
      document.body.appendChild(this.audio);
    }

    wanted() {
      const lang = targetOf(this.name);
      const handsFree = settings.mode === 'talk' && settings.handsFree;
      const micType = settings.mode === 'listen' || handsFree ? 'far_field' : settings.micType;
      const source = settings.showSource && !handsFree;
      return { lang, micType, source, sig: [lang, micType, source].join('|') };
    }

    connect() {
      const w = this.wanted();
      if (this.state === 'open' && this.sig === w.sig) return Promise.resolve();
      if (this.pending) {
        // a cancelled attempt is still settling: wait for it, then try again
        if (this.state === 'idle') return this.pending.catch(() => {}).then(() => this.connect());
        return this.pending;
      }
      if (this.state === 'open') this.close();
      this.state = 'connecting';
      ui.render();
      this.pending = this.open(w)
        .catch((e) => { this.reset(); throw e; })
        .finally(() => { this.pending = null; ui.render(); });
      return this.pending;
    }

    async open(w) {
      const [stream, secret] = await Promise.all([mic.get(), getSecret(w.lang, w.micType, w.source)]);
      if (this.state !== 'connecting') throw new AppError('已取消', 'cancelled');
      const pc = new RTCPeerConnection();
      const track = stream.getAudioTracks()[0].clone();
      track.enabled = false; // silence until someone talks
      this.pc = pc;
      this.track = track;
      this.sig = w.sig;
      try {
        pc.addTrack(track, new MediaStream([track]));
        pc.ontrack = (e) => {
          this.audio.srcObject = (e.streams && e.streams[0]) || new MediaStream([e.track]);
          this.applyVolume();
          const p = this.audio.play();
          if (p && p.catch) p.catch(() => ui.needAudioTap(this));
        };
        pc.onconnectionstatechange = () => {
          if (this.pc !== pc) return;
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            this.reset();
            if (turn.dir && turn.sessionFor(turn.dir) === this) turn.stop('dropped');
            if (hf.active) hf.stop('dropped');
            ui.toast('翻譯連線中斷了，下次按按鈕會自動重連');
            ui.render();
          }
        };
        const dc = pc.createDataChannel('oai-events');
        this.dc = dc;
        dc.onmessage = (e) => this.onEvent(e.data);
        const opened = new Promise((resolve, reject) => {
          dc.onopen = resolve;
          setTimeout(() => reject(new AppError('語音連線逾時。這個網路可能擋住了即時語音，換個網路（例如手機網路）再試。', 'ice')), 15000);
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        let r = await postSdp(secret, offer.sdp);
        if (r.status === 401) r = await postSdp(await getSecret(w.lang, w.micType, w.source, { fresh: true }), offer.sdp);
        if (!r.ok) throw await httpError(r);
        const answer = await r.text();
        if (this.pc !== pc) throw new AppError('已取消', 'cancelled');
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        await opened;
        if (this.pc !== pc) throw new AppError('已取消', 'cancelled');
        this.state = 'open';
        this.openedAt = Date.now();
        wake.acquire();
        ui.startClock();
      } catch (e) {
        try { pc.close(); } catch (x) { /* ignore */ }
        try { track.stop(); } catch (x) { /* ignore */ }
        throw e;
      }
    }

    onEvent(raw) {
      let ev;
      try { ev = JSON.parse(raw); } catch (e) { return; }
      if (ev.type === 'session.input_transcript.delta' && ev.delta) {
        feed.delta(this.name, 'src', ev.delta);
        turn.onInput(this.name);
      } else if (ev.type === 'session.output_transcript.delta' && ev.delta) {
        hf.onOutput();
        feed.delta(this.name, 'dst', ev.delta);
      } else if (ev.type === 'error') {
        const m = (ev.error && (ev.error.message || ev.error.code)) || JSON.stringify(ev).slice(0, 200);
        ui.error(new AppError('OpenAI 回報錯誤', 'server', m));
      }
      if (ev.type !== 'session.closed') idle.bump();
    }

    setTalking(on) { if (this.track) this.track.enabled = !!on; }

    duck(on) {
      this.ducked = !!on;
      this.applyVolume();
    }

    applyVolume() {
      let want;
      if (this.name === 'mine') want = settings.speakJa;
      else want = settings.mode === 'listen' ? settings.listenSpeak : settings.speakMine;
      this.audio.muted = this.ducked || !want;
    }

    minutes() { return this.state === 'open' && this.openedAt ? (Date.now() - this.openedAt) / 60000 : 0; }

    // Polite hang-up: ask the server to flush the last words, then close.
    close() {
      const { pc, dc, track } = this;
      usage.add(this.minutes());
      this.pc = null;
      this.dc = null;
      this.track = null;
      this.state = 'idle';
      this.openedAt = 0;
      this.sig = '';
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: 'session.close' })); } catch (e) { /* ignore */ }
      }
      if (track) track.enabled = false;
      setTimeout(() => {
        try { if (pc) pc.close(); } catch (e) { /* ignore */ }
        try { if (track) track.stop(); } catch (e) { /* ignore */ }
      }, 2500);
    }

    reset() {
      usage.add(this.minutes());
      try { if (this.pc) this.pc.close(); } catch (e) { /* ignore */ }
      try { if (this.track) this.track.stop(); } catch (e) { /* ignore */ }
      this.pc = null;
      this.dc = null;
      this.track = null;
      this.state = 'idle';
      this.openedAt = 0;
      this.sig = '';
    }
  }

  /* ---------- button mode: who is talking right now ---------- */
  const turn = {
    dir: null,        // 'mine' | 'theirs' | 'listen'
    phase: 'idle',    // 'connecting' | 'live'
    holding: false,   // finger still on the button: stop on release, not on silence
    t0: 0,
    calib: [],
    floorSet: false,
    noise: -60,
    thrOn: -48,
    thrOff: -54,
    spoke: false,
    lastVoice: 0,
    gotInput: false,
    lastInput: 0,
    timer: null,

    sessionFor(dir) { return dir === 'mine' ? sessions.mine : sessions.theirs; },

    toggle(dir) {
      if (this.dir === dir) this.stop('manual');
      else this.start(dir);
    },

    async start(dir, opts) {
      if (!apiKey) { ui.openSetup(); return; }
      if (hf.active) hf.stop('switch');
      if (this.dir) this.stop('switch');
      unlockAudio();
      stopTTS();
      big.close();
      feed.pendingBig = null;
      const micReady = mic.get(); // ask for the mic while we still have the tap gesture
      const s = this.sessionFor(dir);
      const other = s === sessions.mine ? sessions.theirs : sessions.mine;
      this.dir = dir;
      this.phase = 'connecting';
      this.holding = !!(opts && opts.hold);
      this.calib = [];
      this.floorSet = false;
      this.spoke = false;
      this.gotInput = false;
      this.lastInput = 0;
      this.t0 = performance.now();
      other.duck(true); // mute the other side so the mic does not translate it back
      s.duck(false);
      this.loop();
      ui.render();
      try {
        await micReady;
        const ready = s.connect();
        if (dir !== 'listen') other.connect().catch(() => {}); // warm up the reply direction
        await ready;
      } catch (e) {
        if (this.dir === dir) this.cancel();
        if (!e || e.code !== 'cancelled') ui.error(e);
        return;
      }
      if (this.dir !== dir) return; // stopped while connecting
      feed.begin(dir);
      s.setTalking(true);
      $('#banner').hidden = true; // an old error is stale once we are connected
      this.phase = 'live';
      this.t0 = performance.now();
      this.lastVoice = this.t0;
      if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(15);
      ui.render();
      idle.bump();
    },

    release(dir) { if (this.dir === dir && this.holding) this.stop('release'); },

    tapped(dir) {
      if (this.dir === dir && this.holding) {
        this.holding = false;
        ui.render();
      }
    },

    onInput(name) {
      if (this.phase !== 'live' || !this.dir || this.sessionFor(this.dir).name !== name) return;
      this.gotInput = true;
      this.lastInput = performance.now();
    },

    loop() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.step(), 50);
    },

    // Auto-stop: loudness that follows the room, plus "are words still arriving?"
    step() {
      if (!this.dir) { clearInterval(this.timer); return; }
      const db = meter.db();
      const now = performance.now();
      ui.level(db);
      if (this.phase !== 'live' || now - this.t0 < 250) { this.calib.push(db); return; }
      if (!this.floorSet) {
        const a = this.calib.filter(Number.isFinite).sort((x, y) => x - y);
        this.noise = Math.min(a.length ? a[Math.floor(a.length * 0.2)] : -65, -40);
        this.floorSet = true;
      }
      this.thrOn = Math.min(-25, Math.max(-52, this.noise + 12));
      this.thrOff = this.thrOn - 6;
      if (db > this.thrOn) {
        this.spoke = true;
        this.lastVoice = now;
      } else {
        if (this.spoke && db > this.thrOff) this.lastVoice = now;
        this.noise += (db - this.noise) * (db > this.noise ? 0.015 : 0.1); // follow the room: rise slowly, fall fast
      }
      if (this.dir === 'listen' || this.holding) return;
      const live = now - this.t0;
      const heard = this.spoke || this.gotInput;
      const quiet = now - this.lastVoice;
      const wordsQuiet = this.gotInput ? now - this.lastInput : Infinity;
      if (!heard && live > 8000) this.stop('nothing');
      else if (heard && quiet > settings.silenceMs && wordsQuiet > 700) this.stop('auto');
      else if (this.gotInput && wordsQuiet > settings.silenceMs + 1300 && live > 2500) this.stop('auto'); // noisy room
      else if (live > 60000) this.stop('max');
    },

    stop(reason) {
      const dir = this.dir;
      if (!dir) return;
      this.sessionFor(dir).setTalking(false);
      this.dir = null;
      this.phase = 'idle';
      this.holding = false;
      clearInterval(this.timer);
      sessions.mine.duck(false);
      sessions.theirs.duck(false);
      feed.end(dir);
      if (dir === 'mine' && settings.autoBig && reason !== 'switch' && reason !== 'mode') feed.wantBig();
      if (reason === 'nothing') ui.toast('沒有聽到聲音，已停止');
      ui.level(-100);
      ui.render();
      idle.bump();
    },

    cancel() {
      const dir = this.dir;
      if (!dir) return;
      this.sessionFor(dir).setTalking(false);
      this.dir = null;
      this.phase = 'idle';
      this.holding = false;
      clearInterval(this.timer);
      sessions.mine.duck(false);
      sessions.theirs.duck(false);
      feed.end(dir);
      ui.level(-100);
      ui.render();
    },
  };

  /* ---------- hands-free mode (experimental) ---------- */
  // Both directions listen at once; each one stays silent for speech already in its own language.
  // Half duplex: while a translation is playing nobody listens, so the phone never translates itself.
  const hf = {
    active: false,
    phase: 'idle',
    open: null,
    outUntil: 0,
    timer: null,

    toggle() {
      if (this.active) this.stop('manual');
      else this.start();
    },

    async start() {
      if (!apiKey) { ui.openSetup(); return; }
      if (turn.dir) turn.stop('switch');
      unlockAudio();
      stopTTS();
      big.close();
      const micReady = mic.get();
      this.active = true;
      this.phase = 'connecting';
      this.open = null;
      this.outUntil = 0;
      feed.open = { mine: null, theirs: null };
      sessions.mine.duck(false);
      sessions.theirs.duck(false);
      this.loop();
      ui.render();
      try {
        await micReady;
        await Promise.all([sessions.mine.connect(), sessions.theirs.connect()]);
      } catch (e) {
        if (this.active) this.cancel();
        if (!e || e.code !== 'cancelled') ui.error(e);
        return;
      }
      if (!this.active) return;
      this.phase = 'live';
      $('#banner').hidden = true;
      this.gate(true);
      ui.render();
      idle.bump();
    },

    loop() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.step(), 100);
    },

    step() {
      if (!this.active) { clearInterval(this.timer); return; }
      ui.level(meter.db());
      if (this.phase === 'live') this.gate(performance.now() >= this.outUntil);
    },

    gate(open) {
      if (this.open === open) return;
      this.open = open;
      sessions.mine.setTalking(open);
      sessions.theirs.setTalking(open);
      ui.render();
    },

    // called while a translation (or the phone's own voice) is playing
    onOutput(extraMs) {
      if (!this.active) return;
      this.outUntil = Math.max(this.outUntil, performance.now() + 1400 + (extraMs || 0));
      this.gate(false);
    },

    stop() {
      if (!this.active) return;
      this.cancel();
      idle.bump();
    },

    cancel() {
      if (!this.active) return;
      this.active = false;
      this.phase = 'idle';
      this.open = null;
      clearInterval(this.timer);
      sessions.mine.setTalking(false);
      sessions.theirs.setTalking(false);
      feed.open = { mine: null, theirs: null };
      ui.level(-100);
      ui.render();
    },
  };

  /* ---------- conversation history ---------- */
  const feed = {
    items: [],
    open: { mine: null, theirs: null }, // card receiving text for each session
    last: { mine: 0, theirs: 0 },
    pendingBig: null,                   // card to show full screen once its translation arrives
    saveTimer: null,

    init() {
      const saved = store.get(K.history, []);
      this.items = Array.isArray(saved) ? saved.filter((x) => x && x.id && (x.src || x.dst)).slice(-300) : [];
      this.items.forEach((it) => ui.addCard(it, false));
      ui.scrollEnd(true);
    },

    begin(dir) {
      const sname = dir === 'mine' ? 'mine' : 'theirs';
      this.open[sname] = this.create(dir);
      this.last[sname] = Date.now();
    },

    create(dir) {
      const sdir = dir === 'mine' ? 'mine' : 'theirs';
      return this.add({ dir, from: sourceOf(sdir), to: targetOf(sdir) }, true);
    },

    add(fields, live) {
      const it = Object.assign({ id: newId(), ts: Date.now(), src: '', dst: '' }, fields);
      this.items.push(it);
      if (this.items.length > 300) this.items.splice(0, this.items.length - 300).forEach((g) => ui.removeCard(g));
      ui.addCard(it, true);
      ui.render();
      if (!live) this.save();
      return it;
    },

    delta(sname, field, text) {
      const now = Date.now();
      const listening = settings.mode === 'listen' && sname === 'theirs';
      const handsFree = hf.active;
      let it = this.open[sname];
      if (it && (listening || handsFree) && (it.src || it.dst)) {
        // start a new card after a pause, or after a long finished sentence
        const pause = now - this.last[sname] > (handsFree ? 2000 : 2500);
        const long = field === 'dst' && it.dst.length > 200 && /[.!?。！？]\s*$/.test(it.dst);
        if (pause || long) it = null;
      }
      if (!it) {
        it = this.create(sname === 'mine' ? 'mine' : listening ? 'listen' : 'theirs');
        this.open[sname] = it;
        if (handsFree) {
          if (sname === 'mine' && settings.autoBig) this.pendingBig = it.id;
          else if (sname === 'theirs') big.close();
        }
      }
      this.last[sname] = now;
      // keep a space between English sentences that arrive as separate pieces
      if (/[.!?,;:]$/.test(it[field]) && /^[A-Za-z0-9"'(]/.test(text)) text = ` ${text}`;
      it[field] += text;
      ui.updateCard(it);
      if (field === 'dst' && this.pendingBig === it.id) {
        this.pendingBig = null;
        big.showItem(it);
      }
      this.save();
    },

    wantBig() {
      const it = this.open.mine;
      if (!it) return;
      if (it.dst) big.showItem(it);
      else this.pendingBig = it.id;
    },

    end(dir) {
      const it = this.open[dir === 'mine' ? 'mine' : 'theirs'];
      if (it) setTimeout(() => { if (!it.src && !it.dst) this.remove(it); }, 8000);
    },

    remove(it) {
      const i = this.items.indexOf(it);
      if (i >= 0) this.items.splice(i, 1);
      Object.keys(this.open).forEach((k) => { if (this.open[k] === it) this.open[k] = null; });
      if (this.pendingBig === it.id) this.pendingBig = null;
      ui.removeCard(it);
      ui.render();
      this.save();
    },

    clear() {
      this.items.forEach((it) => ui.removeCard(it));
      this.items = [];
      this.open = { mine: null, theirs: null };
      this.pendingBig = null;
      this.save();
      ui.render();
    },

    save() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => store.set(K.history, this.items.filter((x) => x.src || x.dst)), 400);
    },
  };

  /* ---------- usage (estimate) ---------- */
  const usage = {
    d: Object.assign({ min: 0, usd: 0, since: Date.now() }, store.get(K.usage, {})),
    rate() {
      const handsFree = settings.mode === 'talk' && settings.handsFree;
      return PRICE.translate + (settings.showSource && !handsFree ? PRICE.source : 0);
    },
    add(min) {
      if (!(min > 0)) return;
      this.d.min += min;
      this.d.usd += min * this.rate();
      store.set(K.usage, this.d);
    },
    liveMin() { return sessions.mine.minutes() + sessions.theirs.minutes(); },
    live() { return this.liveMin() * this.rate(); },
    text() {
      const min = this.d.min + this.liveMin();
      const usd = this.d.usd + this.live();
      const since = new Date(this.d.since).toLocaleDateString('zh-TW');
      return `這支手機自 ${since} 起累計連線 ${min.toFixed(1)} 分鐘，估計約 US$${usd.toFixed(2)}。依官方單價估算（兩個方向各算一條連線，打字翻譯另計但很少），實際以 OpenAI 帳單為準。`;
    },
    reset() {
      this.d = { min: 0, usd: 0, since: Date.now() };
      store.set(K.usage, this.d);
    },
  };

  /* ---------- idle hang-up, wake lock, audio helpers ---------- */
  const idle = {
    timer: null,
    bump() {
      clearTimeout(this.timer);
      if (!sessions.mine.pc && !sessions.theirs.pc) return;
      const ms = Math.max(0.05, Number(settings.idleMin) || 2) * 60000;
      this.timer = setTimeout(() => this.fire(), ms);
    },
    fire() {
      if (turn.dir && turn.dir !== 'listen') { this.bump(); return; } // never cut someone mid-sentence
      const what = hf.active ? 'hf' : turn.dir === 'listen' ? 'listen' : '';
      closeAll();
      if (what === 'hf') ui.toast('一段時間沒人講話，已停止免按鍵並斷線');
      else if (what === 'listen') ui.toast('一段時間沒有聲音，已停止聆聽並斷線');
      else ui.toast('閒置太久，已自動斷線（省錢）');
    },
  };

  const wake = {
    lock: null,
    async acquire() {
      try {
        if (!this.lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
          this.lock = await navigator.wakeLock.request('screen');
          this.lock.addEventListener('release', () => { this.lock = null; });
        }
      } catch (e) { /* not supported or not allowed */ }
    },
    release() {
      try { if (this.lock) this.lock.release(); } catch (e) { /* ignore */ }
      this.lock = null;
    },
  };

  function closeAll() {
    if (turn.dir) turn.cancel();
    if (hf.active) hf.cancel();
    sessions.mine.close();
    sessions.theirs.close();
    mic.stop();
    wake.release();
    clearTimeout(idle.timer);
    ui.render();
  }

  function unlockAudio() {
    meter.ensureCtx();
    [sessions.mine, sessions.theirs].forEach((s) => {
      if (!s.audio.srcObject) {
        const p = s.audio.play();
        if (p && p.catch) p.catch(() => {});
      }
    });
  }

  let ttsPrimed = false;
  // iOS only lets a page speak after a tap; say nothing once inside the tap so later speech works.
  function primeTTS() {
    if (ttsPrimed || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      ttsPrimed = true;
    } catch (e) { /* ignore */ }
  }

  function stopTTS() {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  }

  function speakText(text, lang) {
    if (!text) return;
    if (!('speechSynthesis' in window)) { ui.toast('這台裝置不支援朗讀'); return; }
    if (turn.dir) turn.stop('tts'); // do not translate our own voice
    const said = showText(text, lang);
    hf.onOutput(Array.from(said).length * (lang === 'en' ? 70 : 160));
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(said);
    const tag = (LANGS[lang] && LANGS[lang].tts) || lang;
    u.lang = tag;
    u.rate = lang === 'ja' ? 0.95 : 1;
    const voices = synth.getVoices() || [];
    const norm = (s) => String(s || '').replace('_', '-');
    const v = voices.find((x) => norm(x.lang) === tag) || voices.find((x) => norm(x.lang).slice(0, 2) === tag.slice(0, 2));
    if (v) u.voice = v;
    synth.speak(u);
  }

  function prefetch() {
    if (!apiKey || navigator.onLine === false || settings.mode === 'phrases') return;
    const list = settings.mode === 'listen' ? [sessions.theirs] : [sessions.mine, sessions.theirs];
    list.forEach((s) => {
      const w = s.wanted();
      getSecret(w.lang, w.micType, w.source).catch(() => {});
    });
  }

  function setMode(m) {
    if (settings.mode === m) return;
    if (turn.dir) turn.stop('mode');
    if (hf.active) hf.stop();
    const prev = settings.mode;
    settings.mode = m;
    saveSettings();
    if (m === 'listen' || prev === 'listen') sessions.theirs.close(); // listen uses a different microphone profile
    if (m === 'listen') sessions.mine.close();
    sessions.mine.applyVolume();
    sessions.theirs.applyVolume();
    big.close();
    if (m === 'phrases') phrasebook.render();
    ui.render();
    prefetch();
  }

  function setPair(pair) {
    if (!PAIRS.includes(pair)) return;
    const [my, their] = pair.split('-');
    if (settings.myLang === my && settings.theirLang === their) return;
    if (turn.dir) turn.cancel();
    if (hf.active) hf.stop();
    if (settings.theirLang !== their) sessions.mine.close();  // "我說" now goes out in another language
    if (settings.myLang !== my) sessions.theirs.close();      // "對方說" now comes back in another language
    settings.myLang = my;
    settings.theirLang = their;
    saveSettings();
    syncSettingsUI();
    phrasebook.render();
    ui.render();
    prefetch();
    ui.toast(`${langName(my)} ⇄ ${langName(their)}`);
  }

  function setHandsFree(on) {
    if (settings.handsFree === on) return;
    if (turn.dir) turn.cancel();
    if (hf.active) hf.stop();
    settings.handsFree = on;
    saveSettings();
    sessions.mine.close();   // hands-free uses different session settings (table mic, no subtitles)
    sessions.theirs.close();
    ui.render();
    prefetch();
    ui.toast(on ? '免按鍵（實驗）：按紫色按鈕開始，兩人直接輪流講' : '已切回按鍵模式');
  }

  /* ---------- big view (show to the other person) ---------- */
  const big = {
    id: null,
    cur: null,
    show({ id = null, text, lang = 'ja', sub = '', subLang = 'zh', reply = false }) {
      this.id = id;
      this.cur = { text, lang, sub, subLang };
      const t = $('#bigText');
      t.textContent = showText(text, lang) || '…';
      t.lang = langTag(lang);
      const s = $('#bigSub');
      s.textContent = sub ? showText(sub, subLang) : '';
      s.lang = langTag(subLang);
      s.hidden = !sub;
      $('#bigReply').hidden = !reply || settings.mode === 'listen';
      $('#big').hidden = false;
      this.fit();
    },
    showItem(it) {
      this.show({ id: it.id, text: it.dst, lang: it.to, sub: settings.showSource ? it.src : '', subLang: it.from, reply: it.dir === 'mine' });
    },
    update(it) {
      if (this.id !== it.id || $('#big').hidden) return;
      this.cur = { text: it.dst, lang: it.to, sub: it.src, subLang: it.from };
      $('#bigText').textContent = showText(it.dst, it.to) || '…';
      const s = $('#bigSub');
      s.textContent = settings.showSource && it.src ? showText(it.src, it.from) : '';
      s.hidden = !s.textContent;
      this.fit();
    },
    say() { if (this.cur) speakText(this.cur.text, this.cur.lang); },
    // Largest font size that still fits the screen.
    fit() {
      const t = $('#bigText');
      const stage = $('#big .big-stage');
      const sub = $('#bigSub');
      const room = stage.clientHeight - (sub.hidden ? 0 : sub.offsetHeight + 18);
      const maxH = Math.max(80, room * 0.92);
      let size = Math.min(stage.clientWidth * 0.2, 150);
      t.style.fontSize = `${size}px`;
      for (let i = 0; i < 40 && t.scrollHeight > maxH && size > 16; i++) {
        size *= 0.93;
        t.style.fontSize = `${size.toFixed(1)}px`;
      }
    },
    close() {
      $('#big').hidden = true;
      this.id = null;
    },
  };

  /* ---------- phrasebook (offline) ---------- */
  const phrasebook = {
    entries: new Map(),
    mine() {
      const list = store.get(K.mine, []);
      return Array.isArray(list) ? list : [];
    },
    render() {
      const list = $('#phraseList');
      const cats = $('#phraseCats');
      list.textContent = '';
      cats.textContent = '';
      this.entries.clear();
      const ref = settings.myLang;
      const tgt = settings.theirLang;
      const groups = [{
        id: 'mine',
        name: '我的',
        custom: true,
        items: this.mine().map((p) => ({ key: p.id, ref: p.src, refLang: p.srcLang, tgt: p.dst, tgtLang: p.dstLang, custom: true })),
      }];
      (window.PHRASES || []).forEach((g) => {
        groups.push({
          id: g.id,
          name: g.name,
          items: g.items.map((p, i) => ({ key: `${g.id}-${i}`, ref: p[ref] || p.zh, refLang: p[ref] ? ref : 'zh', tgt: p[tgt], tgtLang: tgt })),
        });
      });
      groups.forEach((g) => {
        const chip = h('button', 'cat', g.name);
        chip.type = 'button';
        chip.dataset.cat = g.id;
        cats.appendChild(chip);
        const head = h('h3', 'psec', g.name);
        head.id = `psec-${g.id}`;
        list.appendChild(head);
        if (!g.items.length && g.custom) {
          list.appendChild(h('p', 'pempty', '按下方「＋ 新增我的句子」，打字翻譯後就能存在這裡（例如你的過敏食物、要去的地址）。'));
        }
        g.items.forEach((e) => {
          this.entries.set(e.key, e);
          const row = h('div', 'prow');
          row.dataset.key = e.key;
          const main = h('button', 'ptext');
          main.type = 'button';
          main.dataset.act = 'big';
          const r = h('span', 'pref', showText(e.ref, e.refLang));
          r.lang = langTag(e.refLang);
          const t = h('span', 'ptgt', showText(e.tgt, e.tgtLang));
          t.lang = langTag(e.tgtLang);
          main.append(r, t);
          const say = h('button', 'pbtn');
          say.type = 'button';
          say.dataset.act = 'say';
          say.setAttribute('aria-label', '唸出來');
          say.innerHTML = SPEAKER;
          row.append(main, say);
          if (e.custom) {
            const del = h('button', 'pbtn', '✕');
            del.type = 'button';
            del.dataset.act = 'del';
            del.setAttribute('aria-label', '刪除');
            row.appendChild(del);
          }
          list.appendChild(row);
        });
      });
    },
    act(key, action) {
      const e = this.entries.get(key);
      if (!e) return;
      if (action === 'say') speakText(e.tgt, e.tgtLang);
      else if (action === 'del') {
        if (!window.confirm('刪除這個句子？')) return;
        store.set(K.mine, this.mine().filter((p) => p.id !== key));
        this.render();
      } else {
        big.show({ text: e.tgt, lang: e.tgtLang, sub: e.ref, subLang: e.refLang, reply: true });
      }
    },
    add(item) {
      const list = this.mine();
      if (list.some((p) => p.dst === item.dst)) return false;
      list.unshift(Object.assign({ id: newId() }, item));
      store.set(K.mine, list.slice(0, 200));
      this.render();
      return true;
    },
  };

  /* ---------- typed translation ---------- */
  const typer = {
    dir: 'out',      // 'out' = into their language, 'in' = into my language
    touched: false,  // the user picked a direction by hand
    last: null,
    open() {
      $('#typeResult').hidden = true;
      $('#typeMsg').textContent = '';
      $('#typeMsg').className = 'msgline';
      this.touched = false;
      this.last = null;
      this.setDir('out');
      $('#typer').hidden = false;
      $('#typeInput').focus();
    },
    setDir(d) {
      this.dir = d;
      $$('#typeDir button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === d)));
    },
    labels() {
      $('#typeDir [data-v=out]').textContent = `翻成${LANGS[settings.theirLang].word}`;
      $('#typeDir [data-v=in]').textContent = `翻成${LANGS[settings.myLang].word}`;
      $('#typeInput').placeholder = `輸入要說的話（${LANGS[settings.myLang].word}）…`;
    },
    autoDir() {
      if (this.touched) return;
      const text = $('#typeInput').value.trim();
      if (!text) return;
      this.setDir(guessLang(text) === settings.theirLang ? 'in' : 'out');
    },
    async go() {
      const input = $('#typeInput');
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      primeTTS();
      const target = this.dir === 'out' ? settings.theirLang : settings.myLang;
      const srcLang = guessLang(text);
      const btn = $('#typeGo');
      const msg = $('#typeMsg');
      btn.disabled = true;
      msg.textContent = '翻譯中…';
      msg.className = 'msgline';
      try {
        const out = await translateText(text, target);
        this.last = { src: text, srcLang, dst: out, dstLang: target, out: this.dir === 'out' };
        const o = $('#typeOut');
        o.textContent = showText(out, target);
        o.lang = langTag(target);
        $('#typeResult').hidden = false;
        msg.textContent = '';
        feed.add({ dir: this.dir === 'out' ? 'mine' : 'theirs', typed: true, from: srcLang, to: target, src: text, dst: out });
        if (this.dir === 'out' && settings.speakJa) speakText(out, target);
      } catch (e) {
        msg.textContent = `✗ ${e.message}${e.detail ? '：' + e.detail : ''}`;
        msg.className = 'msgline bad';
        if (e.code === 'nokey') ui.openSetup();
      } finally {
        btn.disabled = false;
      }
    },
    showBig() {
      if (!this.last) return;
      ui.closeSheet('typer');
      big.show({ text: this.last.dst, lang: this.last.dstLang, sub: this.last.src, subLang: this.last.srcLang, reply: this.last.out });
    },
    say() { if (this.last) speakText(this.last.dst, this.last.dstLang); },
    save() {
      if (!this.last) return;
      const ok = phrasebook.add({ src: this.last.src, srcLang: this.last.srcLang, dst: this.last.dst, dstLang: this.last.dstLang });
      ui.toast(ok ? '已存到常用句「我的」' : '這句已經存過了');
    },
  };

  /* ---------- UI ---------- */
  const ui = {
    nodes: new Map(),
    clock: null,
    toastTimer: null,

    render() {
      const mode = settings.mode;
      const handsFree = mode === 'talk' && settings.handsFree;
      $$('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      $('#feed').hidden = mode === 'phrases';
      $('#phraseView').hidden = mode !== 'phrases';
      $('#talkControls').hidden = mode !== 'talk' || handsFree;
      $('#hfControls').hidden = !handsFree;
      $('#listenControls').hidden = mode !== 'listen';
      $('#phraseControls').hidden = mode !== 'phrases';
      $('#typeBtn').hidden = mode === 'listen';
      $('#hfBtn').hidden = mode !== 'talk';
      $('#hfBtn').setAttribute('aria-pressed', String(handsFree));

      const my = langName(settings.myLang);
      const their = langName(settings.theirLang);
      $('[data-label=mine]').textContent = `${my} → ${their}`;
      $('[data-label=theirs]').textContent = `${their} → ${my}`;
      $('[data-label=listen]').textContent = `${their} → ${my}`;
      $('[data-label=hf]').textContent = `${my} ⇄ ${their}`;
      $$('[data-idle]').forEach((e) => { e.textContent = String(settings.idleMin); });
      const pair = `${settings.myLang}-${settings.theirLang}`;
      $$('[data-pair]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pair === pair)));
      const intro = $('#introText');
      intro.textContent = INTRO[settings.theirLang] || INTRO.ja;
      intro.lang = langTag(settings.theirLang);
      typer.labels();

      const idleHints = { mine: '點一下說，或按住說', theirs: '點一下讓對方說，或按住', listen: '點一下開始翻譯' };
      $$('.talk[data-dir]').forEach((b) => {
        const d = b.dataset.dir;
        if (d === 'hf') return;
        const active = turn.dir === d;
        b.classList.toggle('connecting', active && turn.phase === 'connecting');
        b.classList.toggle('live', active && turn.phase === 'live' && !turn.holding);
        b.classList.toggle('holding', active && turn.holding);
        b.setAttribute('aria-pressed', String(active));
        let hint = idleHints[d] || '';
        if (active && turn.phase === 'connecting') hint = '連線中…稍等再說';
        else if (active && turn.holding) hint = '講完放開';
        else if (active && d === 'listen') hint = '聆聽中・再點一下停止';
        else if (active) hint = '請說・講完會自動停';
        b.querySelector('.hint').textContent = hint;
        if (d === 'listen') b.querySelector('.t1').textContent = active ? '停止聆聽' : '開始聆聽';
        if (!active) b.style.setProperty('--lvl', '0');
      });

      const hb = $('.talk.hf');
      hb.classList.toggle('connecting', hf.active && hf.phase === 'connecting');
      hb.classList.toggle('live', hf.active && hf.phase === 'live' && hf.open === true);
      hb.classList.toggle('gated', hf.active && hf.phase === 'live' && hf.open === false);
      hb.setAttribute('aria-pressed', String(hf.active));
      hb.querySelector('.t1').textContent = hf.active ? '停止' : '開始';
      let hint = '點一下開始，兩人直接輪流講';
      if (hf.active && hf.phase === 'connecting') hint = '連線中…';
      else if (hf.active && hf.open) hint = '聆聽中・直接講';
      else if (hf.active) hint = '播放翻譯中…';
      hb.querySelector('.hint').textContent = hint;
      if (!hf.active) hb.style.setProperty('--lvl', '0');

      $('#empty').hidden = feed.items.length > 0;
      this.status();
    },

    status() {
      const line = $('#statusLine');
      const all = [sessions.mine, sessions.theirs];
      const open = all.filter((s) => s.state === 'open');
      line.classList.remove('busy');
      if (open.length) {
        const since = Math.min(...open.map((s) => s.openedAt));
        const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
        $('#statusText').textContent = `已連線 ${Math.floor(sec / 60)}:${pad2(sec % 60)} · 約 US$${usage.live().toFixed(2)}`;
        line.hidden = false;
      } else if (all.some((s) => s.state === 'connecting')) {
        $('#statusText').textContent = '連線中…';
        line.classList.add('busy');
        line.hidden = false;
      } else {
        line.hidden = true;
      }
    },

    startClock() {
      if (this.clock) return;
      this.clock = setInterval(() => {
        if (!sessions.mine.pc && !sessions.theirs.pc) {
          clearInterval(this.clock);
          this.clock = null;
        }
        this.status();
      }, 1000);
    },

    level(db) {
      const b = hf.active ? $('.talk.hf') : turn.dir ? $(`.talk[data-dir="${turn.dir}"]`) : null;
      if (!b) return;
      const pct = Math.max(0, Math.min(1, (db + 70) / 45));
      b.style.setProperty('--lvl', pct.toFixed(3));
    },

    addCard(it, live) {
      const art = h('article', `card ${it.dir}`);
      art.dataset.id = it.id;
      const head = h('header', 'card-head');
      const who = it.typed ? '打字' : it.dir === 'mine' ? '我說' : it.dir === 'listen' ? '聆聽' : '對方說';
      head.append(h('span', 'who', who), h('time', 'ts', fmtTime(it.ts)));
      const say = h('button', 'say');
      say.type = 'button';
      say.dataset.act = 'say';
      say.setAttribute('aria-label', '唸出來');
      say.innerHTML = SPEAKER;
      head.appendChild(say);
      const src = h('p', 'src');
      const dst = h('p', 'dst');
      art.append(head, src, dst);
      $('#feed').appendChild(art);
      const n = { art, src, dst, say };
      this.nodes.set(it.id, n);
      this.fill(it, n);
      if (live) this.scrollEnd(true);
    },

    fill(it, n) {
      n.src.textContent = showText(it.src, it.from);
      n.src.lang = langTag(it.from);
      n.src.hidden = !it.src || !settings.showSource;
      n.dst.textContent = it.dst ? showText(it.dst, it.to) : '翻譯中…';
      n.dst.lang = it.dst ? langTag(it.to) : 'zh-Hant';
      n.dst.classList.toggle('pending', !it.dst);
      n.say.hidden = !it.dst;
    },

    updateCard(it) {
      const n = this.nodes.get(it.id);
      if (!n) return;
      const f = $('#feed');
      const nearEnd = f.scrollHeight - f.scrollTop - f.clientHeight < 160;
      this.fill(it, n);
      big.update(it);
      if (nearEnd) this.scrollEnd(true);
    },

    refillAll() {
      feed.items.forEach((it) => {
        const n = this.nodes.get(it.id);
        if (n) this.fill(it, n);
      });
    },

    removeCard(it) {
      const n = this.nodes.get(it.id);
      if (n) n.art.remove();
      this.nodes.delete(it.id);
    },

    scrollEnd(force) {
      const f = $('#feed');
      if (force) f.scrollTop = f.scrollHeight;
    },

    toast(msg) {
      const t = $('#toast');
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
    },

    error(e) {
      const err = e instanceof AppError ? e : new AppError('發生錯誤', 'unknown', String((e && e.message) || e));
      diag.lastError = `${fmtTime(Date.now())} ${err.message}${err.detail ? '｜' + err.detail : ''}`;
      const b = $('#banner');
      b.querySelector('.msg').textContent = err.message;
      const d = b.querySelector('.detail');
      d.textContent = err.detail || '';
      d.hidden = !err.detail;
      b.hidden = false;
      if (err.code === 'nokey') this.openSetup();
    },

    needAudioTap(session) {
      const b = $('#banner');
      b.querySelector('.msg').textContent = '翻譯的聲音被擋住了，點這裡打開聲音';
      b.querySelector('.detail').hidden = true;
      b.hidden = false;
      b.onclick = () => {
        session.audio.play().catch(() => {});
        b.hidden = true;
        b.onclick = null;
      };
    },

    openSetup() {
      $('#setupMsg').textContent = '';
      $('#setup').hidden = false;
    },

    openSettings() {
      syncSettingsUI();
      $('#keyMsg').textContent = '';
      $('#settings').hidden = false;
    },

    closeSheet(id) { $(`#${id}`).hidden = true; },
  };

  /* ---------- settings sheet ---------- */
  const maskKey = (k) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : '••••');

  function diagText() {
    const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    return [
      `版本 v${VERSION}`,
      `網址 ${location.origin}${location.pathname}`,
      `主畫面 App：${standalone ? '是' : '否'}　安全連線：${window.isSecureContext ? '是' : '否'}`,
      `麥克風 API：${navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? '有' : '無'}　WebRTC：${'RTCPeerConnection' in window ? '有' : '無'}　螢幕常亮：${'wakeLock' in navigator ? '有' : '無'}`,
      `語言：${settings.myLang}-${settings.theirLang}　中文代碼：${zhCode || '未定'}　繁體轉換：${typeof window.toTrad === 'function' ? '有' : '無'}`,
      `連線設定：${diag.variant || '（還沒連過）'}　打字模型：${diag.textModel || textModel || '（還沒用過）'}`,
      `模式：${settings.mode}${settings.handsFree ? '（免按鍵）' : ''}　我說：${sessions.mine.state}　對方說：${sessions.theirs.state}`,
      `最後錯誤：${diag.lastError || '無'}`,
      `UA ${navigator.userAgent}`,
    ].join('\n');
  }

  function syncSettingsUI() {
    $$('.seg[data-setting]').forEach((seg) => {
      const k = seg.dataset.setting;
      $$('button[data-v]', seg).forEach((b) => b.setAttribute('aria-pressed', String(String(settings[k]) === b.dataset.v)));
    });
    $$('input[type=checkbox][data-setting]').forEach((cb) => { cb.checked = !!settings[cb.dataset.setting]; });
    $('#listenSpeak').checked = !!settings.listenSpeak;
    $('#keyState').textContent = apiKey ? `已設定：${maskKey(apiKey)}` : '尚未設定';
    $('#usageText').textContent = usage.text();
    $('#diag').textContent = diagText();
    $('#versionLine').textContent = `口譯 v${VERSION} · ${MODEL}`;
  }

  function updateSetting(k, v) {
    if (settings[k] === v) { syncSettingsUI(); return; }
    settings[k] = v;
    saveSettings();
    if (k === 'showSource' || k === 'micType') {
      if (turn.dir) turn.cancel();
      if (hf.active) hf.stop();
      sessions.mine.close();
      sessions.theirs.close();
      prefetch();
    }
    if (k === 'speakJa' || k === 'speakMine' || k === 'listenSpeak') {
      sessions.mine.applyVolume();
      sessions.theirs.applyVolume();
    }
    if (k === 'showSource' || k === 'trad') {
      ui.refillAll();
      phrasebook.render();
    }
    if (k === 'idleMin') idle.bump();
    syncSettingsUI();
    ui.render();
  }

  async function testKey(msgEl) {
    if (!apiKey) {
      msgEl.textContent = '還沒有金鑰';
      msgEl.className = 'msgline bad';
      return false;
    }
    msgEl.textContent = '測試中…';
    msgEl.className = 'msgline';
    try {
      const w = sessions.mine.wanted();
      await getSecret(w.lang, w.micType, w.source, { fresh: true });
      msgEl.textContent = '✓ 可以用了：金鑰有效，也能使用口譯模型。';
      msgEl.className = 'msgline ok';
      return true;
    } catch (e) {
      msgEl.textContent = `✗ ${e.message}${e.detail ? '：' + e.detail : ''}`;
      msgEl.className = 'msgline bad';
      if (e.code === 'http401') {
        apiKey = '';
        store.del(K.key);
      }
      return false;
    } finally {
      syncSettingsUI();
    }
  }

  async function saveKey(input, msgEl) {
    const k = String(input.value || '').trim();
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(k)) {
      msgEl.textContent = '格式不對：金鑰是 sk- 開頭的一長串字，請整串貼上。';
      msgEl.className = 'msgline bad';
      return false;
    }
    apiKey = k;
    store.set(K.key, k);
    secretCache.clear();
    variantFloor = 0;
    sourceWarned = false;
    input.value = '';
    return testKey(msgEl);
  }

  /* ---------- wiring ---------- */
  const sessions = { mine: new Session('mine'), theirs: new Session('theirs') };

  // 我說／對方說: a tap listens until a pause; holding listens until the finger lifts.
  function bindTalkButton(b) {
    const dir = b.dataset.dir;
    let press = null;
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      if (turn.dir === dir) {
        press = null;
        turn.stop('manual');
        return;
      }
      press = { t: performance.now() };
      turn.start(dir, { hold: true });
    });
    const end = () => {
      unlockAudio(); // pointerup counts as a user gesture on iOS
      if (!press) return;
      const held = performance.now() - press.t;
      press = null;
      if (held >= HOLD_MS) turn.release(dir);
      else turn.tapped(dir);
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { if (e.detail === 0) turn.toggle(dir); }); // keyboard
  }

  function bind() {
    $$('.talk.mine, .talk.theirs').forEach(bindTalkButton);
    $('.talk.listen').addEventListener('click', () => turn.toggle('listen'));
    $('.talk.hf').addEventListener('click', () => hf.toggle());
    $$('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('#hangup').addEventListener('click', () => {
      closeAll();
      ui.toast('已斷線');
    });
    $('#typeBtn').addEventListener('click', () => typer.open());
    $('#addPhrase').addEventListener('click', () => typer.open());
    $('#hfBtn').addEventListener('click', () => setHandsFree(!settings.handsFree));

    $('#openSettings').addEventListener('click', () => ui.openSettings());
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => ui.closeSheet(b.dataset.close)));
    ['settings', 'typer'].forEach((id) => {
      $(`#${id}`).addEventListener('click', (e) => { if (e.target.id === id) ui.closeSheet(id); });
    });
    $('#banner .banner-x').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#banner').hidden = true;
      $('#banner').onclick = null;
    });

    document.addEventListener('click', (e) => {
      const p = e.target.closest('[data-pair]');
      if (p) { setPair(p.dataset.pair); return; }
      if (e.target.closest('[data-intro]')) {
        big.show({ text: INTRO[settings.theirLang] || INTRO.ja, lang: settings.theirLang, sub: $('#introZh').textContent.trim(), subLang: 'zh', reply: true });
      }
    });

    $('#feed').addEventListener('click', (e) => {
      const card = e.target.closest('.card[data-id]');
      if (!card) return;
      const it = feed.items.find((x) => x.id === card.dataset.id);
      if (!it || !it.dst) return;
      if (e.target.closest('[data-act=say]')) speakText(it.dst, it.to);
      else big.showItem(it);
    });

    $('#phraseList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('.prow');
      if (btn && row) phrasebook.act(row.dataset.key, btn.dataset.act);
    });
    $('#phraseCats').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      $$('#phraseCats .cat').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      const head = $(`#psec-${chip.dataset.cat}`);
      if (head) head.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    $('#bigFlip').addEventListener('click', () => $('#big').classList.toggle('flipped'));
    $('#bigSay').addEventListener('click', () => big.say());
    $('#bigClose').addEventListener('click', () => big.close());
    $('#bigReply').addEventListener('click', () => {
      big.close();
      if (settings.mode !== 'talk') setMode('talk');
      if (settings.handsFree) { if (!hf.active) hf.start(); } else turn.start('theirs');
    });
    window.addEventListener('resize', () => { if (!$('#big').hidden) big.fit(); });

    $('#typeGo').addEventListener('click', () => typer.go());
    $('#typeInput').addEventListener('input', () => typer.autoDir());
    $('#typeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        typer.go();
      }
    });
    $('#typeDir').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      typer.touched = true;
      typer.setDir(b.dataset.v);
    });
    $('#typeBig').addEventListener('click', () => typer.showBig());
    $('#typeSay').addEventListener('click', () => typer.say());
    $('#typeSave').addEventListener('click', () => typer.save());

    $('#setupSave').addEventListener('click', async () => {
      if (await saveKey($('#setupKey'), $('#setupMsg'))) setTimeout(() => ui.closeSheet('setup'), 1200);
    });
    $('#setupLater').addEventListener('click', () => ui.closeSheet('setup'));
    $('#keySave').addEventListener('click', () => saveKey($('#keyInput'), $('#keyMsg')));
    $('#keyTest').addEventListener('click', () => testKey($('#keyMsg')));
    $('#keyDelete').addEventListener('click', () => {
      if (!window.confirm('確定要刪除這支手機上的金鑰？')) return;
      closeAll();
      apiKey = '';
      store.del(K.key);
      secretCache.clear();
      syncSettingsUI();
      $('#keyMsg').textContent = '已刪除';
      $('#keyMsg').className = 'msgline';
    });

    $$('#settings .seg[data-setting]').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        const k = seg.dataset.setting;
        updateSetting(k, typeof DEFAULTS[k] === 'number' ? Number(b.dataset.v) : b.dataset.v);
      });
    });
    $$('#settings input[type=checkbox][data-setting]').forEach((cb) => {
      cb.addEventListener('change', () => updateSetting(cb.dataset.setting, cb.checked));
    });
    $('#listenSpeak').addEventListener('change', (e) => updateSetting('listenSpeak', e.target.checked));

    $('#usageReset').addEventListener('click', () => { usage.reset(); syncSettingsUI(); });
    $('#historyClear').addEventListener('click', () => {
      if (!window.confirm('清除所有對話紀錄？')) return;
      feed.clear();
      syncSettingsUI();
    });
    $('#diagCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(diagText());
        ui.toast('已複製診斷資訊');
      } catch (e) {
        ui.toast('無法自動複製，請長按上面的文字複製');
      }
    });

    window.addEventListener('offline', () => ui.toast('沒有網路：翻譯暫時不能用，常用句還是可以用'));
    window.addEventListener('online', () => prefetch());

    let hiddenTimer = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // the phone went to the background: stop paying for idle audio
        hiddenTimer = setTimeout(closeAll, 10000);
      } else {
        clearTimeout(hiddenTimer);
        if (sessions.mine.pc || sessions.theirs.pc) wake.acquire();
        prefetch();
      }
    });
    window.addEventListener('pagehide', closeAll);
  }

  function init() {
    bind();
    syncSettingsUI();
    feed.init();
    phrasebook.render();
    ui.render();
    if (!apiKey) ui.openSetup();
    else prefetch();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // handle for debugging from the console
    window.__ky = { VERSION, settings, sessions, turn, hf, feed, usage, secretCache, diag, big, typer, phrasebook };
  }

  init();
})();
