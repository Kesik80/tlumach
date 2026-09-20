/* live.js — режим «Разговор»: синхронный голосовой перевод через Gemini Live.
 *
 * Схема: /api/live-token выдаёт одноразовый токен с зашитым языком перевода,
 * браузер сам открывает WebSocket к Google. Микрофон → PCM 16 кГц кусками
 * по 100 мс; в ответ приходит озвученный перевод (PCM 24 кГц) и субтитры.
 *
 * Две кнопки — два направления. Одна сессия в каждый момент: при смене
 * стороны старый сокет закрывается и открывается новый с другим языком.
 * echoTargetLanguage=false: речь уже на целевом языке модель не повторяет,
 * поэтому перевод, который играет из динамика, не уходит по кругу.
 *
 * Подключается в index.html после основного скрипта: <script src="live.js?v=2">.
 * При правке этого файла поднимать ?v= — service worker отдаёт .js из кэша.
 */
(function () {
  'use strict';

  var WS_URL = 'wss://generativelanguage.googleapis.com/ws/' +
    'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  var PREF_KEY = 'ueb_live';
  var IN_RATE = 16000;
  var OUT_RATE = 24000;
  var CHUNK = 1600;          // 100 мс при 16 кГц — так советует документация
  var PAUSE_MS = 2500;       // тишина дольше — значит, следующая реплика
  var RECONNECT_AFTER = 30000; // обрыв после стольких мс работы — переподключаемся сами

  var MINE = [{ code: 'ru', label: 'RU' }, { code: 'uk', label: 'UA' }];
  var THEIRS = [{ code: 'de', label: 'DE' }, { code: 'en', label: 'EN' }];
  var SHORT = { de: 'DE', en: 'EN', ru: 'RU', uk: 'UA' };

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

  // ---------- настройки ----------

  var prefs = { mine: 'ru', theirs: 'de', sound: true };
  try {
    var saved = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    if (saved) {
      if (MINE.some(function (l) { return l.code === saved.mine; })) prefs.mine = saved.mine;
      if (THEIRS.some(function (l) { return l.code === saved.theirs; })) prefs.theirs = saved.theirs;
      if (typeof saved.sound === 'boolean') prefs.sound = saved.sound;
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
    '<div class="live-log" id="liveLog" aria-live="polite"></div>' +
    '<div class="live-status" id="liveStatus"></div>' +
    '<div class="live-btns">' +
    '  <button class="live-side" id="liveMe" type="button" aria-pressed="false"></button>' +
    '  <button class="live-side" id="liveThem" type="button" aria-pressed="false"></button>' +
    '</div>' +
    '<div class="live-foot">' +
    '  <button class="hist-clear" id="liveCopy" type="button">Копировать</button>' +
    '  <button class="hist-clear" id="liveWipe" type="button">Очистить</button>' +
    '</div>';
  document.body.appendChild(root);

  var el = {
    sound: document.getElementById('liveSound'),
    close: document.getElementById('liveClose'),
    mine: document.getElementById('liveMine'),
    theirs: document.getElementById('liveTheirs'),
    log: document.getElementById('liveLog'),
    status: document.getElementById('liveStatus'),
    me: document.getElementById('liveMe'),
    them: document.getElementById('liveThem'),
    copy: document.getElementById('liveCopy'),
    wipe: document.getElementById('liveWipe'),
    open: document.getElementById('btnLive')
  };

  function buildPills(box, list, key) {
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
        buildPills(box, list, key);
        syncButtons();
        if (S.side) connect();   // язык зашит в токен — нужна новая сессия
      });
      box.appendChild(b);
    });
  }

  function syncButtons() {
    var mine = SHORT[prefs.mine], theirs = SHORT[prefs.theirs];
    el.me.innerHTML = '🎙️ Я говорю<small>' + mine + ' → ' + theirs + '</small>';
    el.them.innerHTML = '🎙️ Собеседник<small>' + theirs + ' → ' + mine + '</small>';
    el.me.setAttribute('aria-pressed', String(S.side === 'me'));
    el.them.setAttribute('aria-pressed', String(S.side === 'them'));
    el.sound.textContent = prefs.sound ? '🔊' : '🔇';
    el.sound.setAttribute('aria-pressed', String(!prefs.sound));
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg || '';
    el.status.classList.toggle('error', !!isError);
  }

  function showEmpty() {
    el.log.innerHTML =
      '<p class="live-empty">Нажми «Я говорю» и говори — телефон озвучит перевод. ' +
      'Когда отвечает собеседник, нажми его кнопку. Повторное нажатие — стоп.</p>' +
      '<p class="live-empty small">Бесплатный тариф Gemini: Google может использовать ' +
      'записи для улучшения своих моделей. Для личного лучше текстовый режим.</p>';
  }

  // ---------- состояние сессии ----------

  var S = {
    side: null,        // 'me' | 'them' | null
    gen: 0,            // номер попытки: события старых сокетов отбрасываются
    ws: null,
    ready: false,
    readyAt: 0,
    stream: null,
    micP: null,
    micGen: 0,
    inCtx: null,
    srcNode: null,
    workNode: null,
    outCtx: null,
    playAt: 0,
    playing: [],
    turn: null,
    pauseTimer: 0,
    wake: null
  };
  var decoder = new TextDecoder();

  function targetFor(side) {
    return side === 'me' ? prefs.theirs : prefs.mine;
  }

  // ---------- звук ----------

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
      if (mg !== S.micGen) {   // пока спрашивали разрешение, нажали стоп
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
        if (mg !== S.micGen) return;   // пока грузили, нажали стоп — releaseMic уже всё закрыл
        var node = new AudioWorkletNode(ctx, 'pcm16', { numberOfInputs: 1, numberOfOutputs: 1 });
        node.port.onmessage = function (e) { sendAudio(e.data); };
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
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function sendAudio(buf) {
    if (!S.ready || !S.ws || S.ws.readyState !== 1) return;
    S.ws.send(JSON.stringify({
      realtimeInput: { audio: { data: toBase64(buf), mimeType: 'audio/pcm;rate=' + IN_RATE } }
    }));
  }

  function play(b64) {
    if (!prefs.sound || !S.outCtx) return;
    var bin = atob(b64);
    var n = bin.length >> 1;
    if (!n) return;
    var buffer = S.outCtx.createBuffer(1, n, OUT_RATE);
    var ch = buffer.getChannelData(0);
    for (var i = 0; i < n; i++) {
      var v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      ch[i] = (v >= 32768 ? v - 65536 : v) / 32768;
    }
    var node = S.outCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(S.outCtx.destination);
    var at = Math.max(S.outCtx.currentTime + 0.04, S.playAt);
    node.start(at);
    S.playAt = at + buffer.duration;
    S.playing.push(node);
    node.onended = function () {
      var k = S.playing.indexOf(node);
      if (k >= 0) S.playing.splice(k, 1);
    };
  }

  function stopPlayback() {
    S.playing.forEach(function (n) { try { n.stop(); } catch (e) { /* уже закончился */ } });
    S.playing = [];
    S.playAt = 0;
  }

  // ---------- субтитры ----------

  function endTurn() {
    clearTimeout(S.pauseTimer);
    S.turn = null;
  }

  function addText(kind, text) {
    if (!text) return;
    if (!S.turn || S.turn.side !== S.side) {
      var empty = el.log.querySelector('.live-empty');
      if (empty) el.log.innerHTML = '';
      var box = document.createElement('div');
      box.className = 'live-turn ' + S.side;
      box.innerHTML = '<div class="lt-dst"></div><div class="lt-src"></div>';
      el.log.appendChild(box);
      S.turn = { side: S.side, box: box, src: '', dst: '' };
    }
    S.turn[kind] += text;
    S.turn.box.querySelector(kind === 'dst' ? '.lt-dst' : '.lt-src').textContent = S.turn[kind].trim();
    el.log.scrollTop = el.log.scrollHeight;
    clearTimeout(S.pauseTimer);
    S.pauseTimer = setTimeout(endTurn, PAUSE_MS);
  }

  // ---------- соединение ----------

  function closeSocket() {
    S.ready = false;
    if (S.ws) {
      var ws = S.ws;
      S.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000); } catch (e) { /* уже закрыт */ }
    }
  }

  function connect() {
    var gen = ++S.gen;
    var target = targetFor(S.side);
    closeSocket();
    endTurn();
    setStatus('Подключаюсь…');

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
      if (gen !== S.gen) return;
      var ws = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(d.token));
      ws.binaryType = 'arraybuffer';
      S.ws = ws;

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
        if (gen !== S.gen) return;
        var msg;
        try { msg = JSON.parse(typeof e.data === 'string' ? e.data : decoder.decode(e.data)); }
        catch (err) { return; }
        handle(msg);
      };

      ws.onerror = function () { /* подробности придут в onclose */ };

      ws.onclose = function (e) {
        if (gen !== S.gen) return;
        var worked = S.ready && Date.now() - S.readyAt > RECONNECT_AFTER;
        S.ws = null;
        S.ready = false;
        if (!S.side) return;
        if (worked) { connect(); return; }   // плановый обрыв длинной сессии
        stop();
        setStatus('Соединение закрыто: ' + (e.reason || ('код ' + e.code)), true);
      };
    }).catch(function (err) {
      if (gen !== S.gen) return;
      stop();
      setStatus(err.message || 'Не удалось подключиться.', true);
    });
  }

  function handle(msg) {
    if (msg.setupComplete) {
      S.ready = true;
      S.readyAt = Date.now();
      setStatus(S.side === 'me'
        ? 'Слушаю тебя…'
        : 'Слушаю собеседника…');
      return;
    }
    if (msg.goAway) {   // сервер скоро закроет сессию — переходим заранее
      connect();
      return;
    }
    var sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription && sc.inputTranscription.text) addText('src', sc.inputTranscription.text);
    if (sc.outputTranscription && sc.outputTranscription.text) addText('dst', sc.outputTranscription.text);
    if (sc.modelTurn && sc.modelTurn.parts) {
      sc.modelTurn.parts.forEach(function (p) {
        if (p.inlineData && p.inlineData.data) play(p.inlineData.data);
      });
    }
    if (sc.turnComplete) endTurn();
  }

  // ---------- старт / стоп ----------

  function lockScreen() {
    if (!navigator.wakeLock || S.wake) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!S.side) { lock.release(); return; }
      S.wake = lock;
      lock.addEventListener('release', function () { if (S.wake === lock) S.wake = null; });
    }).catch(function () { /* нет — не беда, экран просто может погаснуть */ });
  }

  function toggle(side) {
    unlockOutput();
    if (S.side === side) { stop(); setStatus('Остановлено.'); return; }
    var fresh = !S.side;
    S.side = side;
    syncButtons();
    if (fresh) lockScreen();
    var gen = S.gen;
    ensureMic().then(function () {
      if (S.side !== side || gen !== S.gen) return;   // пока ждали разрешения, всё поменялось
      connect();
    }).catch(function (err) {
      stop();
      setStatus(err.message || 'Микрофон недоступен.', true);
    });
  }

  function stop() {
    S.gen++;
    S.side = null;
    closeSocket();
    endTurn();
    releaseMic();
    if (S.wake) { S.wake.release().catch(function () {}); S.wake = null; }
    syncButtons();
  }

  // ---------- окно ----------

  function open() {
    root.classList.remove('hidden');
    document.documentElement.classList.add('live-open');
    if (!el.log.children.length) showEmpty();
    setStatus('');
    // «Назад» на Android закрывает окно, а не уходит со страницы.
    if (!(history.state && history.state.live)) history.pushState({ live: 1 }, '');
  }

  function close(fromHistory) {
    if (root.classList.contains('hidden')) return;
    stop();
    stopPlayback();
    root.classList.add('hidden');
    document.documentElement.classList.remove('live-open');
    if (!fromHistory && history.state && history.state.live) history.back();
  }

  function copyLog() {
    var lines = [];
    el.log.querySelectorAll('.live-turn').forEach(function (t) {
      var who = t.classList.contains('me') ? 'Я' : 'Собеседник';
      var src = t.querySelector('.lt-src').textContent;
      var dst = t.querySelector('.lt-dst').textContent;
      lines.push(who + ': ' + src + (dst ? '\n→ ' + dst : ''));
    });
    if (!lines.length) { setStatus('Копировать пока нечего.'); return; }
    var text = lines.join('\n\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { setStatus('Скопировано.'); })
      .catch(function () { setStatus('Не удалось скопировать.', true); });
  }

  // ---------- события ----------

  buildPills(el.mine, MINE, 'mine');
  buildPills(el.theirs, THEIRS, 'theirs');
  syncButtons();

  if (el.open) el.open.addEventListener('click', open);
  el.close.addEventListener('click', function () { close(false); });
  el.me.addEventListener('click', function () { toggle('me'); });
  el.them.addEventListener('click', function () { toggle('them'); });
  el.sound.addEventListener('click', function () {
    prefs.sound = !prefs.sound;
    savePrefs();
    if (!prefs.sound) stopPlayback();
    syncButtons();
  });
  el.copy.addEventListener('click', copyLog);
  el.wipe.addEventListener('click', function () { endTurn(); showEmpty(); setStatus(''); });

  window.addEventListener('popstate', function () { close(true); });

  // HyperOS всё равно усыпит фоновую вкладку — лучше честно остановиться,
  // чем держать микрофон и сокет, которые уже не работают.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.side) {
      stop();
      setStatus('Остановлено: приложение ушло в фон.');
    }
  });
})();
