/* live.js — режим «Разговор»: синхронный голосовой перевод через Gemini Live.
 *
 * Схема: /api/live-token выдаёт одноразовый токен с зашитым языком перевода,
 * браузер сам открывает WebSocket к Google. Микрофон → PCM 16 кГц кусками
 * по 100 мс; в ответ приходит озвученный перевод (PCM 24 кГц) и субтитры.
 *
 * Скорость. Обе сессии (моя речь → язык собеседника и наоборот) открываются
 * сразу при входе в окно и держатся, пока оно открыто. Нажатие кнопки только
 * переключает, куда идёт звук, — без токена и рукопожатия. Последние 400 мс
 * звука до нажатия тоже уходят в сессию, чтобы не съедалось первое слово.
 * При отпускании/смене стороны шлём audioStreamEnd — модель сразу
 * договаривает перевод, а не ждёт продолжения.
 *
 * Режимы:
 *   manual — две кнопки, звук идёт только в сессию нажатой стороны;
 *   auto   — звук идёт в обе сессии. echoTargetLanguage=false: каждая молчит,
 *            если речь уже на её целевом языке, так что говорит та, что нужна.
 *            Пока играет перевод, микрофон никуда не отправляется — иначе
 *            озвучка ушла бы на перевод обратно и зациклилась.
 *
 * Подключается в index.html после основного скрипта: <script src="live.js?v=4">.
 * При правке этого файла поднимать ?v= — service worker отдаёт .js из кэша.
 */
(function () {
  'use strict';

  var WS_URL = 'wss://generativelanguage.googleapis.com/ws/' +
    'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  var PREF_KEY = 'ueb_live';
  var HIST_KEY = 'ueb_live_hist';
  var HIST_MAX = 15;
  var IN_RATE = 16000;
  var OUT_RATE = 24000;
  var CHUNK = 1600;          // 100 мс при 16 кГц — так советует документация
  var PREROLL = 4;           // сколько последних кусков (по 100 мс) отдать при нажатии
  var QUEUE_MAX = 100;       // до 10 с звука ждут, пока сессия поднимается
  var PAUSE_MS = 2500;       // тишина дольше — значит, следующая реплика
  var ECHO_TAIL = 0.3;       // авто: столько секунд после конца озвучки микрофон ещё молчит
  var MAX_FAILS = 3;
  var FLUSH_MS = 60;         // как часто склеивать пришедший звук
  var JITTER = 0.18;         // запас перед началом озвучки, секунды
  var GUESS_MS = 700;        // сколько ждать расшифровку, чтобы понять, чья это речь
  var FACE_LINES = 6;        // сколько последних реплик видно на половине экрана
  var HIDE_GRACE_MS = 4000;  // столько вкладка может побыть скрытой без разрыва

  var MINE = [{ code: 'ru', label: 'RU' }, { code: 'uk', label: 'UA' }];
  var THEIRS = [{ code: 'de', label: 'DE' }, { code: 'en', label: 'EN' }];
  var MODES = [
    { code: 'manual', label: 'Кнопками' },
    { code: 'face', label: 'Лицом к лицу' },
    { code: 'auto', label: 'Авто' }
  ];
  // Какой алфавит ждать от каждого языка — по нему в авто-режиме видно,
  // чья это была речь, и лишняя сессия замолкает.
  var SCRIPT = { ru: 'cyr', uk: 'cyr', de: 'lat', en: 'lat' };
  // Подписи для собеседника — на его языке, не на русском.
  var FACE_UI = {
    de: { talk: '🎙 Sprechen', stop: '⏹ Stopp', hint: 'Tippen, sprechen, nochmal tippen' },
    en: { talk: '🎙 Speak', stop: '⏹ Stop', hint: 'Tap, speak, tap again' }
  };
  var SHORT = { de: 'DE', en: 'EN', ru: 'RU', uk: 'UA' };
  var SIDES = ['me', 'them'];

  // Процессор микрофона: Float32 любой частоты → Int16 16 кГц, пачками по CHUNK.
  // Ресемплинг свой — на случай, если браузер не дал контекст на 16 кГц.
  var WORKLET = [
    'class Pcm16 extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.ratio = sampleRate / ' + IN_RATE + ';',
    '    this.pos = 0; this.prev = 0;',
    '    this.buf = new Int16Array(' + CHUNK + '); this.n = 0;',
    '  }',
    '  push(v) {',
    '    v = v < -1 ? -1 : v > 1 ? 1 : v;',
    '    this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767;',
    '    if (this.n === this.buf.length) {',
    '      this.port.postMessage(this.buf.buffer, [this.buf.buffer]);',
    '      this.buf = new Int16Array(' + CHUNK + '); this.n = 0;',
    '    }',
    '  }',
    '  process(inputs) {',
    '    var ch = inputs[0] && inputs[0][0];',
    '    if (!ch || !ch.length) return true;',
    '    var p = this.pos, r = this.ratio, last = ch.length - 1;',
    '    while (p < last) {',
    '      var i = Math.floor(p), f = p - i;',
    '      var a = i < 0 ? this.prev : ch[i];',
    '      this.push(a + (ch[i + 1] - a) * f);',
    '      p += r;',
    '    }',
    '    this.pos = p - ch.length;',
    '    this.prev = ch[last];',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("pcm16", Pcm16);'
  ].join('\n');

  function log() {
    var args = ['[live]'].concat([].slice.call(arguments));
    console.log.apply(console, args);
  }

  // ---------- настройки ----------

  var prefs = { mine: 'ru', theirs: 'de', sound: true, mode: 'manual' };
  try {
    var saved = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    if (saved) {
      if (MINE.some(function (l) { return l.code === saved.mine; })) prefs.mine = saved.mine;
      if (THEIRS.some(function (l) { return l.code === saved.theirs; })) prefs.theirs = saved.theirs;
      if (typeof saved.sound === 'boolean') prefs.sound = saved.sound;
      if (MODES.some(function (m) { return m.code === saved.mode; })) prefs.mode = saved.mode;
    }
  } catch (e) { /* битые настройки — берём по умолчанию */ }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* квота */ }
  }

  // ---------- разметка ----------

  var root = document.createElement('div');
  root.className = 'live hidden';
  root.id = 'live';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Разговор');
  root.innerHTML =
    '<div class="live-top">' +
    '  <b class="live-title">Разговор</b>' +
    '  <button class="iconbtn" id="liveSound" type="button" title="Озвучивать перевод" aria-pressed="false"></button>' +
    '  <button class="iconbtn" id="liveClose" type="button" aria-label="Закрыть">✕</button>' +
    '</div>' +
    '<div class="bar">' +
    '  <div class="pills" id="liveMine" role="group" aria-label="Мой язык"></div>' +
    '  <span class="live-arrow" aria-hidden="true">↔</span>' +
    '  <div class="pills" id="liveTheirs" role="group" aria-label="Язык собеседника"></div>' +
    '</div>' +
    '<div class="bar"><div class="pills" id="liveModes" role="group" aria-label="Режим"></div></div>' +
    '<div class="live-log" id="liveLog" aria-live="polite"></div>' +
    '<div class="live-status" id="liveStatus"></div>' +
    '<div class="live-btns" id="liveManual">' +
    '  <button class="live-side" id="liveMe" type="button" aria-pressed="false"></button>' +
    '  <button class="live-side" id="liveThem" type="button" aria-pressed="false"></button>' +
    '</div>' +
    '<div class="live-btns hidden" id="liveAutoBox">' +
    '  <button class="live-side" id="liveAuto" type="button" aria-pressed="false"></button>' +
    '</div>' +
    '<div class="live-face" id="liveFace">' +
    '  <div class="face-pane them" id="facePaneThem">' +
    '    <button class="face-btn" id="faceThem" type="button" aria-pressed="false"></button>' +
    '    <div class="face-text" id="faceTextThem"></div>' +
    '  </div>' +
    '  <div class="face-pane me" id="facePaneMe">' +
    '    <button class="face-btn" id="faceMe" type="button" aria-pressed="false"></button>' +
    '    <div class="face-text" id="faceTextMe"></div>' +
    '    <div class="face-status" id="faceStatus"></div>' +
    '  </div>' +
    '</div>' +
    '<div class="live-foot">' +
    '  <button class="hist-clear" id="liveBigLast" type="button">Крупно</button>' +
    '  <button class="hist-clear" id="liveCopy" type="button">Копировать</button>' +
    '  <button class="hist-clear" id="liveHist" type="button">История</button>' +
    '  <button class="hist-clear" id="liveWipe" type="button">Очистить</button>' +
    '</div>' +
    '<div class="live-big hidden" id="liveBig">' +
    '  <div class="lb-card" id="liveBigCard">' +
    '    <div class="lb-text" id="liveBigText"></div>' +
    '    <div class="lb-src" id="liveBigSrc"></div>' +
    '  </div>' +
    '  <div class="lb-btns">' +
    '    <button class="ghost" id="liveBigFlip" type="button">↻ Перевернуть</button>' +
    '    <button class="go" id="liveBigClose" type="button">Закрыть</button>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(root);

  function $(id) { return document.getElementById(id); }
  var el = {
    sound: $('liveSound'), close: $('liveClose'),
    mine: $('liveMine'), theirs: $('liveTheirs'), modes: $('liveModes'),
    log: $('liveLog'), status: $('liveStatus'),
    manual: $('liveManual'), me: $('liveMe'), them: $('liveThem'),
    autoBox: $('liveAutoBox'), auto: $('liveAuto'),
    face: $('liveFace'), faceMe: $('faceMe'), faceThem: $('faceThem'),
    faceTextMe: $('faceTextMe'), faceTextThem: $('faceTextThem'), faceStatus: $('faceStatus'),
    bigLast: $('liveBigLast'), copy: $('liveCopy'), hist: $('liveHist'), wipe: $('liveWipe'),
    big: $('liveBig'), bigCard: $('liveBigCard'), bigText: $('liveBigText'), bigSrc: $('liveBigSrc'),
    bigFlip: $('liveBigFlip'), bigClose: $('liveBigClose'),
    open: $('btnLive')
  };

  // ---------- состояние ----------

  var S = {
    open: false,
    active: null,      // manual: 'me' | 'them' | null
    running: false,    // auto: слушаем ли
    sess: { me: null, them: null },
    ring: [],          // последние куски звука — для «предзаписи»
    err: '',
    // микрофон
    stream: null, micP: null, micGen: 0, inCtx: null, srcNode: null, workNode: null,
    // вывод
    outCtx: null, playAt: 0, playing: [], queue: [], flush: 0,
    // субтитры
    log: [],           // реплики текущего разговора
    convId: 0,
    view: 'log',       // 'log' | 'hist'
    big: null,         // реплика, открытая крупно
    wake: null
  };
  var decoder = new TextDecoder();

  function targetFor(side) {
    return side === 'me' ? prefs.theirs : prefs.mine;
  }

  function listening(side) {
    return prefs.mode === 'auto' ? S.running : S.active === side;
  }

  // ---------- кнопки и статус ----------

  function buildPills(box, list, key, onChange) {
    box.innerHTML = '';
    list.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill';
      b.textContent = l.label;
      b.setAttribute('aria-pressed', String(prefs[key] === l.code));
      b.addEventListener('click', function () {
        if (prefs[key] === l.code) return;
        prefs[key] = l.code;
        savePrefs();
        buildPills(box, list, key, onChange);
        onChange();
      });
      box.appendChild(b);
    });
  }

  function syncButtons() {
    var mine = SHORT[prefs.mine], theirs = SHORT[prefs.theirs];
    el.me.innerHTML = '🎙️ Я говорю<small>' + mine + ' → ' + theirs + '</small>';
    el.them.innerHTML = '🎙️ Собеседник<small>' + theirs + ' → ' + mine + '</small>';
    el.auto.innerHTML = (S.running ? '⏹ Остановить' : '🎙️ Слушать разговор') +
      '<small>' + mine + ' ↔ ' + theirs + ', кто бы ни говорил</small>';
    el.me.setAttribute('aria-pressed', String(S.active === 'me'));
    el.them.setAttribute('aria-pressed', String(S.active === 'them'));
    el.auto.setAttribute('aria-pressed', String(S.running));
    var ui = FACE_UI[prefs.theirs] || FACE_UI.en;
    el.faceMe.textContent = S.active === 'me' ? '⏹ Стоп' : '🎙 Говорить';
    el.faceThem.textContent = S.active === 'them' ? ui.stop : ui.talk;
    el.faceMe.setAttribute('aria-pressed', String(S.active === 'me'));
    el.faceThem.setAttribute('aria-pressed', String(S.active === 'them'));
    el.faceThem.lang = prefs.theirs;
    root.classList.toggle('face-mode', prefs.mode === 'face');
    el.manual.classList.toggle('hidden', prefs.mode !== 'manual');
    el.autoBox.classList.toggle('hidden', prefs.mode !== 'auto');
    el.sound.textContent = prefs.sound ? '🔊' : '🔇';
    el.sound.setAttribute('aria-pressed', String(!prefs.sound));
  }

  function setError(msg) {
    S.err = msg || '';
    updateStatus();
  }

  // Короткая подсказка без красного цвета; следующий updateStatus её сменит.
  function note(msg) {
    S.err = '';
    el.status.textContent = msg;
    el.status.classList.remove('error');
  }

  function updateStatus() {
    var text, isErr = false;
    if (S.err) { text = S.err; isErr = true; }
    else if (!S.open) text = '';
    else if (!S.workNode) text = 'Включаю микрофон…';
    else {
      var ready = SIDES.every(function (s) { return S.sess[s] && S.sess[s].ready; });
      var need = prefs.mode === 'auto' ? S.running : !!S.active;
      if (!ready) text = need ? 'Подключаюсь — говори, звук не потеряется…' : 'Подключаюсь…';
      else if (prefs.mode === 'auto') text = S.running ? 'Слушаю обоих…' : 'Готово. Нажми «Слушать разговор».';
      else if (S.active === 'me') text = 'Слушаю тебя…';
      else if (S.active === 'them') text = 'Слушаю собеседника…';
      else text = 'Готово. Нажми кнопку и говори.';
    }
    el.status.textContent = text;
    el.status.classList.toggle('error', isErr);
    el.faceStatus.textContent = isErr ? text : '';
  }

  // ---------- звук: вход ----------

  // Вызывается прямо в обработчике нажатия: иначе браузер не даст звук.
  function unlockOutput() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!S.outCtx) S.outCtx = new Ctx();
    if (S.outCtx.state === 'suspended') S.outCtx.resume();
  }

  function ensureMic() {
    if (S.workNode) return Promise.resolve();
    if (S.micP) return S.micP;   // уже спрашиваем разрешение — второй раз не надо
    S.micP = openMic();
    return S.micP;
  }

  function openMic() {
    var mg = S.micGen;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('Браузер не даёт доступ к микрофону.'));
    }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (stream) {
      if (mg !== S.micGen) {   // пока спрашивали разрешение, окно закрыли
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      S.stream = stream;
      var ctx;
      try { ctx = new Ctx({ sampleRate: IN_RATE }); } catch (e) { ctx = new Ctx(); }
      var src;
      try {
        src = ctx.createMediaStreamSource(stream);
      } catch (e) {
        // Firefox не смешивает частоты — берём родную, ресемплит worklet.
        ctx.close();
        ctx = new Ctx();
        src = ctx.createMediaStreamSource(stream);
      }
      S.inCtx = ctx;
      S.srcNode = src;
      if (!ctx.audioWorklet) throw new Error('Браузер слишком старый для голосового режима.');
      var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      return ctx.audioWorklet.addModule(url).then(function () {
        URL.revokeObjectURL(url);
        if (mg !== S.micGen) return;   // пока грузили, окно закрыли — releaseMic уже всё закрыл
        var node = new AudioWorkletNode(ctx, 'pcm16', { numberOfInputs: 1, numberOfOutputs: 1 });
        node.port.onmessage = function (e) { onAudio(e.data); };
        src.connect(node);
        node.connect(ctx.destination);   // пишет тишину; нужно, чтобы граф вообще считался
        S.workNode = node;
        S.micP = null;
        return ctx.resume();
      });
    }).catch(function (e) {
      releaseMic();
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        throw new Error('Микрофон не разрешён.');
      }
      if (e && e.name === 'NotFoundError') throw new Error('Микрофон не найден.');
      throw e;
    });
  }

  function releaseMic() {
    if (S.workNode) { S.workNode.port.onmessage = null; S.workNode.disconnect(); }
    if (S.srcNode) S.srcNode.disconnect();
    if (S.stream) S.stream.getTracks().forEach(function (t) { t.stop(); });
    if (S.inCtx) S.inCtx.close().catch(function () {});
    S.workNode = S.srcNode = S.stream = S.inCtx = S.micP = null;
    S.micGen++;
    S.ring = [];
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function playbackBusy() {
    return S.outCtx && S.playAt + ECHO_TAIL > S.outCtx.currentTime;
  }

  function onAudio(buf) {
    S.ring.push(buf);
    if (S.ring.length > PREROLL) S.ring.shift();
    if (prefs.mode === 'auto' && playbackBusy()) return;   // не слушаем собственную озвучку
    SIDES.forEach(function (side) {
      if (listening(side)) sendAudio(S.sess[side], buf);
    });
  }

  function sendAudio(sess, buf) {
    if (!sess) return;
    if (sess.ready && sess.ws && sess.ws.readyState === 1) {
      sess.ws.send(JSON.stringify({
        realtimeInput: { audio: { data: toBase64(buf), mimeType: 'audio/pcm;rate=' + IN_RATE } }
      }));
    } else if (sess.queue.length < QUEUE_MAX) {
      sess.queue.push(buf);
    }
  }

  // Сказать модели «я договорил» — она сразу выдаёт остаток перевода.
  function sendStreamEnd(side) {
    var sess = S.sess[side];
    if (!sess) return;
    sess.queue = [];
    if (sess.ready && sess.ws && sess.ws.readyState === 1) {
      sess.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }
  }

  // ---------- звук: выход ----------

  // Модель шлёт звук мелкими кусками и рывками. Поэтому куски не
  // проигрываются по одному, а собираются в общий буфер: раз в FLUSH_MS
  // всё накопленное склеивается в один кусок и ставится в очередь встык.
  // JITTER — запас, чтобы очередная порция успела прийти до конца текущей.
  function decodePcm(b64) {
    var bin = atob(b64);
    var n = bin.length >> 1;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      out[i] = (v >= 32768 ? v - 65536 : v) / 32768;
    }
    return out;
  }

  function play(b64) {
    if (!prefs.sound || !S.outCtx) return;
    var pcm = decodePcm(b64);
    if (!pcm.length) return;
    S.queue.push(pcm);
    if (!S.flush) S.flush = setTimeout(flushAudio, FLUSH_MS);
  }

  function flushAudio() {
    S.flush = 0;
    if (!S.queue.length || !S.outCtx) return;
    var total = 0;
    S.queue.forEach(function (a) { total += a.length; });
    var buffer = S.outCtx.createBuffer(1, total, OUT_RATE);
    var ch = buffer.getChannelData(0), at = 0;
    S.queue.forEach(function (a) { ch.set(a, at); at += a.length; });
    S.queue = [];

    var now = S.outCtx.currentTime;
    if (S.playAt < now + JITTER) S.playAt = now + JITTER;   // отстали — начинаем с запасом
    var node = S.outCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(S.outCtx.destination);
    node.start(S.playAt);
    S.playAt += buffer.duration;
    S.playing.push(node);
    node.onended = function () {
      var k = S.playing.indexOf(node);
      if (k >= 0) S.playing.splice(k, 1);
    };
  }

  function stopPlayback() {
    clearTimeout(S.flush);
    S.flush = 0;
    S.queue = [];
    S.playing.forEach(function (n) { try { n.stop(); } catch (e) { /* уже закончился */ } });
    S.playing = [];
    S.playAt = 0;
  }

  // ---------- субтитры ----------

  function turnOf(sess) {
    if (!sess.turn) {
      sess.turn = {
        side: sess.side, src: '', interim: '', dst: '', el: null,
        heardAt: 0, spokeAt: 0,
        // В авто обе сессии слышат всех. Пока не ясно, на каком языке
        // говорили, звук этой сессии придерживается: иначе обе начинают
        // озвучивать одновременно и получается каша.
        allow: prefs.mode === 'auto' ? null : true,
        held: [], holdTimer: 0
      };
    }
    return sess.turn;
  }

  function scriptOf(text) {
    if (/[\u0400-\u04FF]/.test(text)) return 'cyr';
    if (/[A-Za-zÀ-ÿ]/.test(text)) return 'lat';
    return '';
  }

  // Речь на целевом языке эта сессия переводить не должна — значит, говорил
  // не тот, за кого она отвечает. Тогда её реплику и звук выбрасываем.
  function decideTurn(sess, t, text) {
    if (t.allow !== null) return;
    var sc = scriptOf(text || '');
    if (!sc) return;
    t.allow = sc !== SCRIPT[sess.target];
    clearTimeout(t.holdTimer);
    if (t.allow) t.held.forEach(play);
    t.held = [];
    if (!t.allow) dropTurn(t);
  }

  function holdAudio(t, b64) {
    t.held.push(b64);
    if (t.holdTimer) return;
    t.holdTimer = setTimeout(function () {   // расшифровки нет — пусть звучит
      t.holdTimer = 0;
      if (t.allow !== null) return;
      t.allow = true;
      t.held.forEach(play);
      t.held = [];
    }, GUESS_MS);
  }

  function dropTurn(t) {
    clearTimeout(t.holdTimer);
    t.held = [];
    if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
    var k = S.log.indexOf(t);
    if (k >= 0) S.log.splice(k, 1);
    t.el = null;
    if (S.big === t) hideBig();
    renderFace();
  }

  function touch(sess) {
    clearTimeout(sess.pauseTimer);
    sess.pauseTimer = setTimeout(function () { endTurn(sess); }, PAUSE_MS);
  }

  function endTurn(sess) {
    if (!sess) return;
    clearTimeout(sess.pauseTimer);
    var t = sess.turn;
    sess.turn = null;
    if (!t) return;
    if (t.allow === null) {   // так и не поняли, чья речь — пусть звучит
      clearTimeout(t.holdTimer);
      t.holdTimer = 0;
      t.allow = true;
      t.held.forEach(play);
      t.held = [];
    }
    if (t.interim) { t.interim = ''; renderTurn(t); }
  }

  function renderTurn(t) {
    if (t.allow === false) return;
    // В авто обе сессии слышат всех; реплика показывается только у той,
    // что реально переводит, — иначе каждая фраза задвоится.
    var visible = t.dst || (prefs.mode !== 'auto' && (t.src || t.interim));
    if (!visible) return;
    if (!t.el) {
      if (S.view !== 'log') showLog();
      var empty = el.log.querySelector('.live-empty');
      if (empty) el.log.innerHTML = '';
      if (!S.convId) S.convId = Date.now();
      t.el = document.createElement('div');
      t.el.className = 'live-turn ' + t.side;
      t.el.innerHTML = '<div class="lt-dst"></div><div class="lt-src"></div>';
      t.el.addEventListener('click', function () { showBig(t); });
      el.log.appendChild(t.el);
      S.log.push(t);
    }
    t.el.querySelector('.lt-dst').textContent = t.dst.trim();
    t.el.querySelector('.lt-src').textContent = (t.src + (t.interim ? ' ' + t.interim : '')).trim();
    el.log.scrollTop = el.log.scrollHeight;
    if (S.big === t) fillBig(t);
    renderFace();
  }

  function addText(sess, kind, text) {
    if (!text) return;
    var t = turnOf(sess);
    if (kind !== 'dst') decideTurn(sess, t, text);
    if (t.allow === false) return;
    if (kind === 'interim') {
      t.interim = text;
    } else if (kind === 'src') {
      t.src += text;
      t.interim = '';
    } else {
      t.dst += text;
    }
    if (!t.heardAt && kind !== 'dst') t.heardAt = Date.now();
    renderTurn(t);
    touch(sess);
  }

  // Каждая половина экрана показывает разговор на своём языке: моя — по-русски,
  // половина собеседника — на его языке и вверх ногами, чтобы он читал напротив.
  function faceLine(t, mineSide) {
    if (mineSide) return t.side === 'me' ? t.src + (t.interim ? ' ' + t.interim : '') : t.dst;
    return t.side === 'me' ? t.dst : t.src + (t.interim ? ' ' + t.interim : '');
  }

  function renderFace() {
    if (prefs.mode !== 'face') return;
    [[el.faceTextMe, true], [el.faceTextThem, false]].forEach(function (pair) {
      var box = pair[0], mineSide = pair[1];
      box.innerHTML = '';
      var turns = S.log.slice(-FACE_LINES);
      turns.forEach(function (t, i) {
        var text = (faceLine(t, mineSide) || '').trim();
        if (!text) return;
        var d = document.createElement('div');
        d.className = 'face-line' + (i === turns.length - 1 ? ' last' : '') +
          (t.side === (mineSide ? 'me' : 'them') ? ' own' : '');
        d.textContent = text;
        box.appendChild(d);
      });
      box.scrollTop = box.scrollHeight;
    });
  }

  // ---------- сессии ----------

  function newSession(side) {
    return {
      side: side, gen: 0, ws: null, ready: false, readyAt: 0,
      queue: [], fails: 0, retry: 0, turn: null, pauseTimer: 0, target: ''
    };
  }

  function closeSession(sess) {
    if (!sess) return;
    sess.gen++;
    clearTimeout(sess.retry);
    endTurn(sess);
    sess.ready = false;
    if (sess.ws) {
      var ws = sess.ws;
      sess.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000); } catch (e) { /* уже закрыт */ }
    }
  }

  function ensureSession(side) {
    var sess = S.sess[side];
    if (!sess) sess = S.sess[side] = newSession(side);
    if (!sess.ws && !sess.connecting) connect(sess);
    return sess;
  }

  function connect(sess) {
    closeSession(sess);
    var gen = sess.gen;
    var target = targetFor(sess.side);
    var t0 = Date.now();
    sess.target = target;
    sess.connecting = true;
    updateStatus();

    fetch('/api/live-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Ошибка сервера ' + r.status));
        return d;
      });
    }).then(function (d) {
      if (gen !== sess.gen) return;
      var tToken = Date.now() - t0;
      var ws = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(d.token));
      ws.binaryType = 'arraybuffer';
      sess.ws = ws;

      ws.onopen = function () {
        ws.send(JSON.stringify({
          // Настройка всё равно берётся из токена целиком; дублируем её
          // на случай, если сервер начнёт сверять одно с другим.
          setup: {
            model: 'models/' + d.model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              translationConfig: { targetLanguageCode: target, echoTargetLanguage: false }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        }));
      };

      ws.onmessage = function (e) {
        if (gen !== sess.gen) return;
        var msg;
        try { msg = JSON.parse(typeof e.data === 'string' ? e.data : decoder.decode(e.data)); }
        catch (err) { return; }
        if (msg.setupComplete) {
          sess.ready = true;
          sess.connecting = false;
          sess.readyAt = Date.now();
          sess.fails = 0;
          log(sess.side, '→', target, 'готово за', sess.readyAt - t0, 'мс (токен', tToken, 'мс)');
          var q = sess.queue;
          sess.queue = [];
          q.forEach(function (b) { sendAudio(sess, b); });
          updateStatus();
          return;
        }
        handle(sess, msg);
      };

      ws.onerror = function () { /* подробности придут в onclose */ };

      ws.onclose = function (e) {
        if (gen !== sess.gen) return;
        var wasReady = sess.ready;
        sess.ws = null;
        sess.ready = false;
        sess.connecting = false;
        endTurn(sess);
        if (!S.open) return;
        log(sess.side, 'сокет закрыт', e.code, e.reason || '');
        if (wasReady) { connect(sess); return; }   // плановый обрыв — сразу заново
        failed(sess, 'Соединение закрыто: ' + (e.reason || ('код ' + e.code)));
      };
    }).catch(function (err) {
      if (gen !== sess.gen) return;
      sess.connecting = false;
      failed(sess, err.message || 'Не удалось подключиться.');
    });
  }

  function failed(sess, reason) {
    sess.fails++;
    log(sess.side, 'ошибка', sess.fails + '/' + MAX_FAILS + ':', reason);
    if (sess.fails >= MAX_FAILS || !S.open) {
      stopListening();
      setError(reason);
      return;
    }
    clearTimeout(sess.retry);
    sess.retry = setTimeout(function () { if (S.open) connect(sess); }, 800 * sess.fails);
  }

  function handle(sess, msg) {
    if (msg.goAway) {   // сервер скоро закроет сессию — переходим заранее
      log(sess.side, 'goAway — переподключаюсь');
      connect(sess);
      return;
    }
    var sc = msg.serverContent;
    if (!sc) return;
    if (sc.interimInputTranscription && sc.interimInputTranscription.text) {
      addText(sess, 'interim', sc.interimInputTranscription.text);
    }
    if (sc.inputTranscription && sc.inputTranscription.text) {
      addText(sess, 'src', sc.inputTranscription.text);
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      addText(sess, 'dst', sc.outputTranscription.text);
    }
    if (sc.modelTurn && sc.modelTurn.parts) {
      sc.modelTurn.parts.forEach(function (p) {
        if (!p.inlineData || !p.inlineData.data) return;
        var t = turnOf(sess);
        if (t.allow === false) return;
        if (!t.spokeAt) {
          t.spokeAt = Date.now();
          if (t.heardAt) log(sess.side, 'озвучка через', t.spokeAt - t.heardAt, 'мс после первых слов');
        }
        if (t.allow === null) holdAudio(t, p.inlineData.data);
        else play(p.inlineData.data);
        touch(sess);
      });
    }
    if (sc.turnComplete) endTurn(sess);
  }

  function connectAll() {
    SIDES.forEach(function (side) {
      var sess = ensureSession(side);
      if (sess.target && sess.target !== targetFor(side)) connect(sess);
    });
  }

  function closeAll() {
    SIDES.forEach(function (side) { closeSession(S.sess[side]); S.sess[side] = null; });
  }

  // ---------- слушать / не слушать ----------

  function startSide(side) {
    var prev = S.active;
    S.active = side;
    if (prev && prev !== side) sendStreamEnd(prev);
    var sess = ensureSession(side);
    sess.fails = 0;
    endTurn(sess);   // новое нажатие — новая реплика
    S.ring.forEach(function (b) { sendAudio(sess, b); });
  }

  function stopListening() {
    if (S.active) sendStreamEnd(S.active);
    if (S.running) SIDES.forEach(sendStreamEnd);
    S.active = null;
    S.running = false;
    syncButtons();
    updateStatus();
  }

  function pressSide(side) {
    unlockOutput();
    S.err = '';
    if (S.active === side) { stopListening(); return; }
    startSide(side);
    syncButtons();
    updateStatus();
    warmUp();
  }

  function pressAuto() {
    unlockOutput();
    S.err = '';
    if (S.running) { stopListening(); return; }
    S.running = true;
    SIDES.forEach(function (side) {
      var sess = ensureSession(side);
      sess.fails = 0;
      endTurn(sess);
      S.ring.forEach(function (b) { sendAudio(sess, b); });
    });
    syncButtons();
    updateStatus();
    warmUp();
  }

  // Микрофон и обе сессии — заранее, чтобы нажатие не ждало.
  function warmUp() {
    if (!S.open || document.hidden) return;
    ensureMic().then(function () {
      if (!S.open) return;
      updateStatus();
      connectAll();
    }).catch(function (err) {
      stopListening();
      setError(err.message || 'Микрофон недоступен.');
    });
  }

  function coolDown() {
    stopListening();
    closeAll();
    releaseMic();
  }

  // ---------- крупный показ ----------

  function fillBig(t) {
    var text = t.dst.trim() || '…';
    el.bigText.textContent = text;
    el.bigSrc.textContent = t.src.trim();
    var n = text.length;
    el.bigText.style.fontSize = n < 50 ? '42px' : n < 120 ? '32px' : n < 250 ? '25px' : '20px';
  }

  function showBig(t) {
    if (!t) { note('Показывать пока нечего.'); return; }
    S.big = t;
    fillBig(t);
    el.big.classList.remove('hidden');
  }

  function hideBig() {
    S.big = null;
    el.big.classList.add('hidden');
  }

  function lastTranslated() {
    for (var i = S.log.length - 1; i >= 0; i--) if (S.log[i].dst) return S.log[i];
    return null;
  }

  // ---------- история разговоров ----------

  function loadHist() {
    try {
      var list = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function saveCurrent() {
    var turns = S.log.filter(function (t) { return t.dst; }).map(function (t) {
      return { side: t.side, src: t.src.trim(), dst: t.dst.trim() };
    });
    if (!turns.length || !S.convId) return;
    var list = loadHist().filter(function (c) { return c.id !== S.convId; });
    list.unshift({ id: S.convId, at: Date.now(), mine: prefs.mine, theirs: prefs.theirs, turns: turns });
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); }
    catch (e) { /* квота */ }
  }

  function resetLog() {
    SIDES.forEach(function (s) { endTurn(S.sess[s]); });
    S.log = [];
    S.convId = 0;
    hideBig();
    showEmpty();
    renderFace();
  }

  function showEmpty() {
    S.view = 'log';
    el.log.innerHTML =
      '<p class="live-empty">«Кнопками»: нажми свою кнопку и говори, когда отвечает собеседник — его. ' +
      '«Авто»: одна кнопка, телефон сам понимает, кто говорит. Тап по реплике — показать крупно.</p>' +
      '<p class="live-empty small">Бесплатный тариф Gemini: Google может использовать ' +
      'записи для улучшения своих моделей. Для личного лучше текстовый режим.</p>';
  }

  function showLog() {
    S.view = 'log';
    el.log.innerHTML = '';
    if (!S.log.length) { showEmpty(); return; }
    S.log.forEach(function (t) {
      el.log.appendChild(t.el);
    });
    el.log.scrollTop = el.log.scrollHeight;
  }

  function showHist() {
    saveCurrent();
    S.view = 'hist';
    var list = loadHist();
    el.log.innerHTML = '';
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'hist-clear';
    back.textContent = '← К текущему разговору';
    back.addEventListener('click', showLog);
    el.log.appendChild(back);
    if (!list.length) {
      var p = document.createElement('p');
      p.className = 'live-empty';
      p.textContent = 'Сохранённых разговоров пока нет.';
      el.log.appendChild(p);
      return;
    }
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hist-item';
      var d = new Date(c.at);
      var first = c.turns[0] ? c.turns[0].src || c.turns[0].dst : '';
      b.textContent = first.slice(0, 60) + (first.length > 60 ? '…' : '');
      var meta = document.createElement('span');
      meta.textContent = pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + c.turns.length + ' репл.';
      b.appendChild(meta);
      b.addEventListener('click', function () { openConv(c); });
      el.log.appendChild(b);
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function openConv(c) {
    SIDES.forEach(function (s) { endTurn(S.sess[s]); });
    S.convId = c.id;
    S.log = [];
    el.log.innerHTML = '';
    c.turns.forEach(function (x) {
      var t = {
        side: x.side, src: x.src, interim: '', dst: x.dst, el: null,
        heardAt: 0, spokeAt: 0, allow: true, held: [], holdTimer: 0
      };
      S.view = 'log';
      renderTurn(t);
    });
    if (!S.log.length) showEmpty();
    renderFace();
  }

  function copyLog() {
    var lines = S.log.filter(function (t) { return t.src || t.dst; }).map(function (t) {
      var who = t.side === 'me' ? 'Я' : 'Собеседник';
      return who + ': ' + t.src.trim() + (t.dst ? '\n→ ' + t.dst.trim() : '');
    });
    if (!lines.length) { note('Копировать пока нечего.'); return; }
    var text = lines.join('\n\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { note('Скопировано.'); })
      .catch(function () { setError('Не удалось скопировать.'); });
  }

  // ---------- окно ----------

  function lockScreen() {
    if (!navigator.wakeLock || S.wake) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!S.open) { lock.release(); return; }
      S.wake = lock;
      lock.addEventListener('release', function () { if (S.wake === lock) S.wake = null; });
    }).catch(function () { /* нет — не беда, экран просто может погаснуть */ });
  }

  function open() {
    unlockOutput();
    S.open = true;
    S.err = '';
    root.classList.remove('hidden');
    document.documentElement.classList.add('live-open');
    if (!el.log.children.length) showEmpty();
    syncButtons();
    updateStatus();
    renderFace();
    lockScreen();
    warmUp();
    // «Назад» на Android закрывает окно, а не уходит со страницы.
    if (!(history.state && history.state.live)) history.pushState({ live: 1 }, '');
  }

  function close(fromHistory) {
    if (!S.open) return;
    S.open = false;
    saveCurrent();
    coolDown();
    stopPlayback();
    hideBig();
    if (S.wake) { S.wake.release().catch(function () {}); S.wake = null; }
    root.classList.add('hidden');
    document.documentElement.classList.remove('live-open');
    if (!fromHistory && history.state && history.state.live) history.back();
  }

  // ---------- события ----------

  buildPills(el.mine, MINE, 'mine', onLangChange);
  buildPills(el.theirs, THEIRS, 'theirs', onLangChange);
  buildPills(el.modes, MODES, 'mode', function () {
    stopListening();
    syncButtons();
    updateStatus();
    renderFace();
  });
  syncButtons();

  function onLangChange() {
    syncButtons();
    if (S.open) connectAll();   // язык зашит в токен — нужны новые сессии
  }

  if (el.open) el.open.addEventListener('click', open);
  el.close.addEventListener('click', function () { close(false); });
  el.me.addEventListener('click', function () { pressSide('me'); });
  el.them.addEventListener('click', function () { pressSide('them'); });
  el.auto.addEventListener('click', pressAuto);
  el.faceMe.addEventListener('click', function () { pressSide('me'); });
  el.faceThem.addEventListener('click', function () { pressSide('them'); });
  el.sound.addEventListener('click', function () {
    prefs.sound = !prefs.sound;
    savePrefs();
    if (!prefs.sound) stopPlayback();
    syncButtons();
  });
  el.bigLast.addEventListener('click', function () { showBig(lastTranslated()); });
  el.bigFlip.addEventListener('click', function () { el.bigCard.classList.toggle('flip'); });
  el.bigClose.addEventListener('click', hideBig);
  el.copy.addEventListener('click', copyLog);
  el.hist.addEventListener('click', function () { if (S.view === 'hist') showLog(); else showHist(); });
  el.wipe.addEventListener('click', function () { saveCurrent(); resetLog(); S.err = ''; updateStatus(); });

  window.addEventListener('popstate', function () { close(true); });

  // HyperOS всё равно усыпит фоновую вкладку — отпускаем микрофон и сокеты,
  // а по возвращении поднимаем заново (без нажатия). С задержкой: скриншот
  // тоже на миг прячет вкладку, и рвать из-за него разговор незачем.
  var hideTimer = 0;
  document.addEventListener('visibilitychange', function () {
    if (!S.open) return;
    clearTimeout(hideTimer);
    if (document.hidden) {
      hideTimer = setTimeout(function () {
        if (!document.hidden || !S.open) return;
        saveCurrent();
        coolDown();
      }, HIDE_GRACE_MS);
    } else {
      lockScreen();
      if (!S.workNode) { S.err = ''; warmUp(); }
    }
  });
})();
