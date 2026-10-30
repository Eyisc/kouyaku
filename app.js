/*
 * 口譯 — my own Japanese ⇄ English live interpreter.
 * Engine: OpenAI gpt-realtime-translate over WebRTC, one session per direction
 * (the official pattern for two-person conversation).
 * The API key lives only in this phone's localStorage and is only sent to api.openai.com.
 */
(() => {
  'use strict';

  const VERSION = '1.1.0';
  const API = 'https://api.openai.com/v1';
  const MODEL = 'gpt-realtime-translate';
  const SOURCE_MODEL = 'gpt-realtime-whisper';
  // USD per connected minute (OpenAI pricing page, checked 2026-10-30)
  const PRICE = { translate: 0.034, source: 0.017 };

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

  class AppError extends Error {
    constructor(message, code, detail) {
      super(message);
      this.code = code || 'error';
      this.detail = detail || '';
    }
  }

  /* ---------- storage & settings ---------- */
  const K = { key: 'ky.key', settings: 'ky.settings', history: 'ky.history', usage: 'ky.usage', zh: 'ky.zhcode' };
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
    mode: 'talk',          // 'talk' (對話) | 'listen' (聆聽)
    myLang: 'zh',          // my language: their words come back in it ('zh' | 'en')
    theirLang: 'ja',       // the other person's language: my words go out in it ('ja' | 'en')
    speakJa: true,         // play the Japanese translation aloud (for them)
    speakMine: true,       // play the translation of their words aloud (for me)
    listenSpeak: false,    // listen mode: play audio (earphones recommended)
    showSource: true,      // source-language subtitles
    micType: 'near_field', // 'near_field' phone near mouth | 'far_field' phone on table
    silenceMs: 1200,       // auto-stop after this much silence
    idleMin: 2,            // hang up after this many idle minutes
  };
  const settings = Object.assign({}, DEFAULTS, store.get(K.settings, {}));
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

  /* ---------- OpenAI: client secrets ---------- */
  const diag = { lastError: '', variant: '' };
  const secretCache = new Map(); // "lang|mic|source" -> { value, exp }
  let variantFloor = 0;           // after a config is rejected, start from the simpler one
  let sourceWarned = false;
  let zhCode = String(store.get(K.zh, '') || ''); // 'zh-TW' if OpenAI accepts it, otherwise 'zh'

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

  async function httpError(r) {
    let body = '';
    try { body = await r.text(); } catch (e) { /* ignore */ }
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body);
      if (j && j.error) detail = j.error.message || j.error.code || detail;
    } catch (e) { /* not JSON */ }
    const map = {
      400: '請求被拒絕（設定不被接受）',
      401: 'API 金鑰無效或已被刪除',
      403: '這把金鑰沒有權限使用口譯模型（檢查專案的模型權限）',
      404: '找不到口譯模型（帳號可能還不能用 gpt-realtime-translate）',
      429: '額度不足、超過預算上限，或請求太頻繁',
    };
    const base = map[r.status] || (r.status >= 500 ? 'OpenAI 伺服器暫時有問題，稍後再試' : '連線失敗');
    return new AppError(`${base}（${r.status}）`, 'http' + r.status, detail);
  }

  function sessionVariants(lang, mic) {
    const input = { noise_reduction: { type: mic } };
    const withSource = Object.assign({}, input);
    if (settings.showSource) withSource.transcription = { model: SOURCE_MODEL };
    const sess = (inp) => ({ model: MODEL, audio: Object.assign(inp ? { input: inp } : {}, { output: { language: lang } }) });
    return [
      { name: 'full', body: { session: sess(withSource), expires_after: { anchor: 'created_at', seconds: 3600 } } },
      { name: 'no-expiry', body: { session: sess(withSource) } },
      { name: 'no-source', body: { session: sess(input) } },
      { name: 'minimal', body: { session: sess(null) } },
    ];
  }

  async function getSecret(lang, mic, opts) {
    const fresh = !!(opts && opts.fresh);
    const sig = [lang, mic, settings.showSource].join('|');
    const cached = secretCache.get(sig);
    if (!fresh && cached && cached.exp - Date.now() / 1000 > 120) return cached.value;
    if (!apiKey) throw new AppError('還沒設定 OpenAI API 金鑰', 'nokey');
    // Chinese: ask for Taiwan Chinese first, fall back to plain 'zh' if the API rejects it.
    const codes = lang === 'zh' ? (zhCode ? [zhCode] : ['zh-TW', 'zh']) : [lang];
    const count = sessionVariants(lang, mic).length;
    let lastErr = null;
    for (let i = variantFloor; i < count; i++) {
      for (const code of codes) {
        const v = sessionVariants(code, mic)[i];
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
          if (settings.showSource && i >= 2 && !sourceWarned) {
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
      this.name = name;       // 'mine' (→ 日本語) | 'theirs' (日本語 →)
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
      const micType = settings.mode === 'listen' ? 'far_field' : settings.micType;
      return { lang, micType, sig: [lang, micType, settings.showSource].join('|') };
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
      const [stream, secret] = await Promise.all([mic.get(), getSecret(w.lang, w.micType)]);
      if (this.state !== 'connecting') throw new AppError('已取消', 'cancelled');
      const pc = new RTCPeerConnection();
      const track = stream.getAudioTracks()[0].clone();
      track.enabled = false; // silence until a turn starts
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
        if (r.status === 401) r = await postSdp(await getSecret(w.lang, w.micType, { fresh: true }), offer.sdp);
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
      } else if (ev.type === 'session.output_transcript.delta' && ev.delta) {
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

  /* ---------- a turn: who is talking right now ---------- */
  const turn = {
    dir: null,        // 'mine' | 'theirs' | 'listen'
    phase: 'idle',    // 'connecting' | 'live'
    t0: 0,
    calib: [],
    floorSet: false,
    thrOn: -48,
    thrOff: -54,
    spoke: false,
    lastVoice: 0,
    timer: null,

    sessionFor(dir) { return dir === 'mine' ? sessions.mine : sessions.theirs; },

    toggle(dir) {
      if (this.dir === dir) this.stop('manual');
      else this.start(dir);
    },

    async start(dir) {
      if (!apiKey) { ui.openSetup(); return; }
      if (this.dir) this.stop('switch');
      unlockAudio();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      const micReady = mic.get(); // ask for the mic while we still have the tap gesture
      const s = this.sessionFor(dir);
      const other = s === sessions.mine ? sessions.theirs : sessions.mine;
      this.dir = dir;
      this.phase = 'connecting';
      this.calib = [];
      this.floorSet = false;
      this.spoke = false;
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
      if (navigator.vibrate) navigator.vibrate(15);
      ui.render();
      idle.bump();
    },

    loop() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.step(), 50);
    },

    // Simple voice-activity detection for the auto-stop.
    step() {
      if (!this.dir) { clearInterval(this.timer); return; }
      const db = meter.db();
      const now = performance.now();
      ui.level(db);
      if (this.phase !== 'live' || now - this.t0 < 250) { this.calib.push(db); return; }
      if (!this.floorSet) {
        const a = this.calib.filter(Number.isFinite).sort((x, y) => x - y);
        const floor = a.length ? a[Math.floor(a.length * 0.2)] : -70;
        this.thrOn = Math.min(-28, Math.max(-50, floor + 12));
        this.thrOff = this.thrOn - 6;
        this.floorSet = true;
      }
      if (db > this.thrOn) {
        this.spoke = true;
        this.lastVoice = now;
      } else if (this.spoke && db > this.thrOff) {
        this.lastVoice = now;
      }
      if (this.dir === 'listen') return; // listen mode runs until stopped
      const live = now - this.t0;
      if (!this.spoke && live > 8000) this.stop('nothing');
      else if (this.spoke && now - this.lastVoice > settings.silenceMs) this.stop('auto');
      else if (live > 90000) this.stop('max');
    },

    stop(reason) {
      const dir = this.dir;
      if (!dir) return;
      this.sessionFor(dir).setTalking(false);
      this.dir = null;
      this.phase = 'idle';
      clearInterval(this.timer);
      sessions.mine.duck(false);
      sessions.theirs.duck(false);
      feed.end(dir);
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
      clearInterval(this.timer);
      sessions.mine.duck(false);
      sessions.theirs.duck(false);
      feed.end(dir);
      ui.level(-100);
      ui.render();
    },
  };

  /* ---------- conversation history ---------- */
  const feed = {
    items: [],
    open: { mine: null, theirs: null }, // card receiving text for each session
    last: { mine: 0, theirs: 0 },
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
      const it = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        dir,
        from: sourceOf(sdir),
        to: targetOf(sdir),
        src: '',
        dst: '',
        ts: Date.now(),
      };
      this.items.push(it);
      if (this.items.length > 300) this.items.splice(0, this.items.length - 300).forEach((g) => ui.removeCard(g));
      ui.addCard(it, true);
      ui.render();
      return it;
    },

    delta(sname, field, text) {
      const now = Date.now();
      const listening = settings.mode === 'listen' && sname === 'theirs';
      let it = this.open[sname];
      if (it && listening && (it.src || it.dst)) {
        // listen mode: start a new paragraph after a pause, or after a long finished sentence
        const pause = now - this.last[sname] > 2500;
        const long = field === 'dst' && it.dst.length > 200 && /[.!?。！？]\s*$/.test(it.dst);
        if (pause || long) it = null;
      }
      if (!it) {
        it = this.create(sname === 'mine' ? 'mine' : listening ? 'listen' : 'theirs');
        this.open[sname] = it;
      }
      this.last[sname] = now;
      // keep a space between English sentences that arrive as separate pieces
      if (/[.!?,;:]$/.test(it[field]) && /^[A-Za-z0-9"'(]/.test(text)) text = ` ${text}`;
      it[field] += text;
      ui.updateCard(it);
      this.save();
    },

    end(dir) {
      const it = this.open[dir === 'mine' ? 'mine' : 'theirs'];
      if (it) setTimeout(() => { if (!it.src && !it.dst) this.remove(it); }, 8000);
    },

    remove(it) {
      const i = this.items.indexOf(it);
      if (i >= 0) this.items.splice(i, 1);
      Object.keys(this.open).forEach((k) => { if (this.open[k] === it) this.open[k] = null; });
      ui.removeCard(it);
      ui.render();
      this.save();
    },

    clear() {
      this.items.forEach((it) => ui.removeCard(it));
      this.items = [];
      this.open = { mine: null, theirs: null };
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
    rate() { return PRICE.translate + (settings.showSource ? PRICE.source : 0); },
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
      return `這支手機自 ${since} 起累計連線 ${min.toFixed(1)} 分鐘，估計約 US$${usd.toFixed(2)}。依官方單價估算（兩個方向各算一條連線），實際以 OpenAI 帳單為準。`;
    },
    reset() {
      this.d = { min: 0, usd: 0, since: Date.now() };
      store.set(K.usage, this.d);
    },
  };

  /* ---------- idle hang-up, wake lock, background ---------- */
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
      const listening = turn.dir === 'listen';
      closeAll();
      ui.toast(listening ? '一段時間沒有聲音，已停止聆聽並斷線' : '閒置太久，已自動斷線（省錢）');
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

  function prefetch() {
    if (!apiKey || navigator.onLine === false) return;
    const micType = settings.mode === 'listen' ? 'far_field' : settings.micType;
    if (settings.mode === 'talk') getSecret(settings.theirLang, micType).catch(() => {});
    getSecret(settings.myLang, micType).catch(() => {});
  }

  function speakText(text, lang) {
    if (!text) return;
    if (!('speechSynthesis' in window)) { ui.toast('這台裝置不支援朗讀'); return; }
    if (turn.dir) turn.stop('tts');
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const tag = (LANGS[lang] && LANGS[lang].tts) || lang;
    u.lang = tag;
    u.rate = lang === 'ja' ? 0.95 : 1;
    const voices = synth.getVoices() || [];
    const norm = (s) => String(s || '').replace('_', '-');
    const v = voices.find((x) => norm(x.lang) === tag) || voices.find((x) => norm(x.lang).slice(0, 2) === tag.slice(0, 2));
    if (v) u.voice = v;
    synth.speak(u);
  }

  function setMode(m) {
    if (settings.mode === m) return;
    if (turn.dir) turn.stop('mode');
    settings.mode = m;
    saveSettings();
    sessions.theirs.close(); // the two modes use different microphone profiles
    if (m === 'listen') sessions.mine.close();
    sessions.mine.applyVolume();
    sessions.theirs.applyVolume();
    ui.render();
    prefetch();
  }

  function setPair(pair) {
    if (!PAIRS.includes(pair)) return;
    const [my, their] = pair.split('-');
    if (settings.myLang === my && settings.theirLang === their) return;
    if (turn.dir) turn.cancel();
    if (settings.theirLang !== their) sessions.mine.close();  // "我說" now goes out in another language
    if (settings.myLang !== my) sessions.theirs.close();      // "對方說" now comes back in another language
    settings.myLang = my;
    settings.theirLang = their;
    saveSettings();
    syncSettingsUI();
    ui.render();
    prefetch();
    ui.toast(`${langName(my)} ⇄ ${langName(their)}`);
  }

  /* ---------- big view (show to the other person) ---------- */
  const big = {
    id: null,
    show({ id = null, text, sub = '', lang = 'ja', reply = false }) {
      this.id = id;
      const t = $('#bigText');
      t.textContent = text || '…';
      t.lang = langTag(lang);
      const s = $('#bigSub');
      s.textContent = sub || '';
      s.hidden = !sub;
      $('#bigReply').hidden = !reply || settings.mode !== 'talk';
      $('#big').hidden = false;
      this.fit();
    },
    update(it) {
      if (this.id !== it.id || $('#big').hidden) return;
      $('#bigText').textContent = it.dst || '…';
      const s = $('#bigSub');
      s.textContent = settings.showSource ? it.src : '';
      s.hidden = !s.textContent;
      this.fit();
    },
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

  /* ---------- UI ---------- */
  const ui = {
    nodes: new Map(),
    clock: null,
    toastTimer: null,

    render() {
      $$('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
      $('#talkControls').hidden = settings.mode !== 'talk';
      $('#listenControls').hidden = settings.mode !== 'listen';
      const my = langName(settings.myLang);
      const their = langName(settings.theirLang);
      $('[data-label=mine]').textContent = `${my} → ${their}`;
      $('[data-label=theirs]').textContent = `${their} → ${my}`;
      $('[data-label=listen]').textContent = `${their} → ${my}`;
      $$('[data-myword]').forEach((e) => { e.textContent = LANGS[settings.myLang].word; });
      $$('[data-theirword]').forEach((e) => { e.textContent = LANGS[settings.theirLang].word; });
      $$('[data-idle]').forEach((e) => { e.textContent = String(settings.idleMin); });
      const pair = `${settings.myLang}-${settings.theirLang}`;
      $$('[data-pair]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pair === pair)));
      const intro = $('#introText');
      intro.textContent = INTRO[settings.theirLang] || INTRO.ja;
      intro.lang = langTag(settings.theirLang);
      $('#introChip').hidden = settings.mode !== 'talk';
      $$('.talk').forEach((b) => {
        const d = b.dataset.dir;
        const active = turn.dir === d;
        b.classList.toggle('connecting', active && turn.phase === 'connecting');
        b.classList.toggle('live', active && turn.phase === 'live');
        b.setAttribute('aria-pressed', String(active));
        let hint = { mine: '按一下開始說', theirs: '按一下讓對方說', listen: '按一下開始翻譯' }[d] || '';
        if (active && turn.phase === 'connecting') hint = '連線中…稍等再說';
        else if (active && d === 'listen') hint = '聆聽中・再按一下停止';
        else if (active) hint = '請說・講完會自動停';
        b.querySelector('.hint').textContent = hint;
        if (d === 'listen') b.querySelector('.t1').textContent = active ? '停止聆聽' : '開始聆聽';
        if (!active) b.style.setProperty('--lvl', '0');
      });
      $('#empty').hidden = feed.items.length > 0;
      this.status();
    },

    status() {
      const st = $('#status');
      const all = [sessions.mine, sessions.theirs];
      const open = all.filter((s) => s.state === 'open');
      st.classList.remove('on', 'busy');
      if (open.length) {
        const since = Math.min(...open.map((s) => s.openedAt));
        const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
        st.textContent = `${Math.floor(sec / 60)}:${pad2(sec % 60)} · US$${usage.live().toFixed(2)}`;
        st.classList.add('on');
        st.setAttribute('aria-label', '已連線，按一下斷線');
      } else if (all.some((s) => s.state === 'connecting')) {
        st.textContent = '連線中';
        st.classList.add('busy');
        st.setAttribute('aria-label', '連線中');
      } else {
        st.textContent = '未連線';
        st.setAttribute('aria-label', '未連線');
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
      const b = turn.dir ? $(`.talk[data-dir="${turn.dir}"]`) : null;
      if (!b) return;
      const pct = Math.max(0, Math.min(1, (db + 70) / 45));
      b.style.setProperty('--lvl', pct.toFixed(3));
    },

    addCard(it, live) {
      const art = h('article', `card ${it.dir}`);
      art.dataset.id = it.id;
      const head = h('header', 'card-head');
      const who = it.dir === 'mine' ? '我說' : it.dir === 'listen' ? '聆聽' : '對方說';
      head.append(h('span', 'who', who), h('span', 'langs', `${langName(it.from)} → ${langName(it.to)}`), h('time', 'ts', fmtTime(it.ts)));
      const src = h('p', 'src');
      src.lang = langTag(it.from);
      const dst = h('p', 'dst');
      dst.lang = langTag(it.to);
      const actions = h('footer', 'card-actions');
      const zoom = h('button', 'chip', it.dir === 'mine' ? '放大給對方看' : '放大');
      zoom.type = 'button';
      zoom.dataset.act = 'zoom';
      const say = h('button', 'chip', it.dir === 'mine' ? '再唸一次' : '朗讀');
      say.type = 'button';
      say.dataset.act = 'say';
      actions.append(zoom, say);
      art.append(head, src, dst, actions);
      $('#feed').appendChild(art);
      const n = { art, src, dst, actions };
      this.nodes.set(it.id, n);
      this.fill(it, n);
      if (live) this.scrollEnd(true);
    },

    fill(it, n) {
      n.src.textContent = it.src;
      n.src.hidden = !it.src || !settings.showSource;
      n.dst.textContent = it.dst || '翻譯中…';
      n.dst.classList.toggle('pending', !it.dst);
      n.dst.lang = it.dst ? langTag(it.to) : 'zh-Hant';
      n.actions.hidden = !it.dst;
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

    refillAll() { feed.items.forEach((it) => { const n = this.nodes.get(it.id); if (n) this.fill(it, n); }); },

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
      const d = b.querySelector('.detail');
      d.hidden = true;
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
      `連線設定：${diag.variant || '（還沒連過）'}`,
      `我說：${sessions.mine.state}　對方說：${sessions.theirs.state}`,
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
    if (k === 'myLang' || k === 'showSource' || k === 'micType') {
      if (turn.dir) turn.cancel();
      if (k === 'myLang') sessions.theirs.close();
      else { sessions.mine.close(); sessions.theirs.close(); }
      prefetch();
    }
    if (k === 'speakJa' || k === 'speakMine' || k === 'listenSpeak') {
      sessions.mine.applyVolume();
      sessions.theirs.applyVolume();
    }
    if (k === 'showSource') ui.refillAll();
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
      await getSecret(settings.theirLang, settings.micType, { fresh: true });
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

  function bind() {
    $$('.talk').forEach((b) => b.addEventListener('click', () => turn.toggle(b.dataset.dir)));
    $$('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    $('#status').addEventListener('click', () => {
      const busy = [sessions.mine, sessions.theirs].some((s) => s.state !== 'idle');
      if (busy) {
        closeAll();
        ui.toast('已斷線');
      } else {
        ui.toast('按「我說」或「對方說」就會自動連線');
      }
    });

    $('#openSettings').addEventListener('click', () => ui.openSettings());
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => ui.closeSheet(b.dataset.close)));
    $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') ui.closeSheet('settings'); });
    $('#banner .banner-x').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#banner').hidden = true;
      $('#banner').onclick = null;
    });

    const introText = () => INTRO[settings.theirLang] || INTRO.ja;
    const introZh = () => $('#introZh').textContent.trim();
    document.addEventListener('click', (e) => {
      const p = e.target.closest('[data-pair]');
      if (p) { setPair(p.dataset.pair); return; }
      const x = e.target.closest('[data-intro]');
      if (!x) return;
      if (x.dataset.intro === 'say') speakText(introText(), settings.theirLang);
      else big.show({ text: introText(), sub: introZh(), lang: settings.theirLang, reply: true });
    });

    $('#feed').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const card = b.closest('.card');
      const it = card && feed.items.find((x) => x.id === card.dataset.id);
      if (!it) return;
      if (b.dataset.act === 'zoom') {
        big.show({ id: it.id, text: it.dst, sub: settings.showSource ? it.src : '', lang: it.to, reply: it.dir === 'mine' });
      } else if (b.dataset.act === 'say') {
        speakText(it.dst, it.to);
      }
    });

    $('#bigFlip').addEventListener('click', () => $('#big').classList.toggle('flipped'));
    window.addEventListener('resize', () => { if (!$('#big').hidden) big.fit(); });
    $('#bigClose').addEventListener('click', () => big.close());
    $('#bigReply').addEventListener('click', () => {
      big.close();
      turn.start('theirs');
    });

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

    window.addEventListener('offline', () => ui.toast('沒有網路，翻譯暫時不能用'));
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
    ui.render();
    if (!apiKey) ui.openSetup();
    else prefetch();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    // handle for debugging from the console
    window.__ky = { VERSION, settings, sessions, turn, feed, usage, secretCache, diag };
  }

  init();
})();
