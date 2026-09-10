/*! pwa.js — универсальный PWA-установщик
 *  Сгенерировано PWA Forge · 10.09.2026 17:13
 *
 *  Подключение — одна строка перед </body>:
 *      <script src="/pwa.js">  (закрывающий тег обязателен)
 *
 *  Всё остальное (мета-теги, манифест, service worker,
 *  окно установки) этот файл делает сам.
 *
 *  API:
 *      PWA.show()            — показать окно установки вручную
 *      PWA.hide()            — закрыть окно
 *      PWA.check()           — диагностика (или ?pwa=check в адресе)
 *      PWA.setTheme('#111')  — цвет статус-бара
 *      PWA.installed()       — true, если запущено с экрана «Домой»
 *
 *  Своя кнопка установки — любой элемент с атрибутом:
 *      <button data-pwa-install>Установить</button>
 *  Он сам скрывается, когда установка недоступна или уже сделана.
 *
 *  События на window:
 *      pwa:available — установка стала возможна
 *      pwa:installed — приложение установлено
 *      pwa:update    — вышла новая версия (detail.apply() применит)
 */
(function () {
'use strict';

var CFG = {
  "name": "Тлумач",
  "short": "Тлумач",
  "desc": "Gemini Translate",
  "manifest": "/icons/manifest.json",
  "sw": "/pwa-sw.js",
  "scope": "/",
  "icon192": "/icons/icon-192x192.png",
  "favicon": "/icons/favicon.ico",
  "accent": "#0a0a0f",
  "themeDark": "#0a0a0f",
  "themeLight": "#ffffff",
  "themeAuto": false,
  "statusBar": "black-translucent",
  "style": "modal",
  "delay": 1800,
  "autoPrompt": true,
  "snooze": 7,
  "lang": "auto",
  "barPos": "bottom",
  "offset": 16,
  "button": "none",
  "buttonText": "Установить",
  "injectMeta": true,
  "registerSW": true,
  "updateToast": true,
  "auto": true
};

var W = window, D = document;
var KEY = 'pwa-install-dismissed';
/* ─────────────────────────────────────────────
   0. ЯЗЫКИ  —  ru / en / de / uk
   Берётся язык устройства, если CFG.lang = 'auto'.
───────────────────────────────────────────── */
var L10N = {
  ru: {
    install:'Установить', later:'Позже', ok:'Понятно',
    ios:['Нажми «Поделиться» ⎙ внизу Safari','Выбери «На экран «Домой»»','Нажми «Добавить»'],
    man:['Открой меню браузера ⋮','Выбери «Установить приложение»','Подтверди установку'],
    updTitle:'Доступна новая версия', update:'Обновить',
    diagTitle:'Диагностика PWA', copy:'Скопировать отчёт', copied:'Скопировано ✓', close:'Закрыть',
    httpsBad:'PWA работает только по https или на localhost',
    installedNow:'Приложение уже установлено', standalone:'страница открыта в режиме standalone',
    mfOk:'Манифест подключён', mfNo:'Манифест не подключён', mfNoHint:'<link rel="manifest"> отсутствует в <head>',
    mfRead:'manifest.json читается', mfErr:'Ошибка манифеста',
    fieldEmpty:'поле пустое — без него установка не предложится',
    displayBrowser:'display: browser отключает установку',
    themeMissing:'не задан — статус-бар будет системным',
    bgMissing:'не задан — splash на Android будет белым',
    icon:'Иконка', iconRequired:'обязательна для установки',
    maskable:'Maskable-иконка', maskableHint:'без неё Android обрежет края логотипа',
    iconMissing:'Файл иконки не найден', iconsOk:'Все файлы иконок на месте', count:'шт.',
    swNo:'Service worker не поддерживается браузером',
    swMissing:'Service worker не зарегистрирован', swMissingHint:'Chrome не предложит установку без него',
    swActive:'Service worker активен', swWaiting:'Ждёт обновление', swCurrent:'Версия актуальная',
    appleIconHint:'на iPhone иконка будет скриншотом страницы',
    iosNote:'iOS: автоустановки нет',
    iosNoteHint:'Safari не поддерживает beforeinstallprompt — показывается инструкция',
    bipOk:'Событие beforeinstallprompt сработало', bipOkHint:'браузер готов установить приложение',
    bipInstalled:'Установка не предлагается — уже установлено',
    bipWarn:'beforeinstallprompt не сработал',
    bipWarnHint:'либо приложение уже установлено, либо Chrome ещё не засчитал вовлечённость — открой страницу второй раз'
  },
  en: {
    install:'Install', later:'Later', ok:'Got it',
    ios:['Tap Share ⎙ at the bottom of Safari','Choose "Add to Home Screen"','Tap "Add"'],
    man:['Open the browser menu ⋮','Choose "Install app"','Confirm the installation'],
    updTitle:'A new version is available', update:'Update',
    diagTitle:'PWA diagnostics', copy:'Copy report', copied:'Copied ✓', close:'Close',
    httpsBad:'PWA works only over https or on localhost',
    installedNow:'The app is already installed', standalone:'the page runs in standalone mode',
    mfOk:'Manifest linked', mfNo:'Manifest not linked', mfNoHint:'<link rel="manifest"> is missing in <head>',
    mfRead:'manifest.json is readable', mfErr:'Manifest error',
    fieldEmpty:'empty field — installation will not be offered',
    displayBrowser:'display: browser disables installation',
    themeMissing:'not set — the status bar stays default',
    bgMissing:'not set — the Android splash will be white',
    icon:'Icon', iconRequired:'required for installation',
    maskable:'Maskable icon', maskableHint:'without it Android crops the logo edges',
    iconMissing:'Icon file not found', iconsOk:'All icon files are reachable', count:'files',
    swNo:'Service workers are not supported by this browser',
    swMissing:'Service worker not registered', swMissingHint:'Chrome will not offer installation without it',
    swActive:'Service worker is active', swWaiting:'Update waiting', swCurrent:'Version is current',
    appleIconHint:'on iPhone the icon becomes a screenshot of the page',
    iosNote:'iOS: no automatic install',
    iosNoteHint:'Safari has no beforeinstallprompt — instructions are shown instead',
    bipOk:'beforeinstallprompt fired', bipOkHint:'the browser is ready to install the app',
    bipInstalled:'Not offered — already installed',
    bipWarn:'beforeinstallprompt did not fire',
    bipWarnHint:'either the app is already installed or Chrome has not counted enough engagement — open the page again'
  },
  de: {
    install:'Installieren', later:'Später', ok:'Verstanden',
    ios:['Tippe unten in Safari auf „Teilen" ⎙','Wähle „Zum Home-Bildschirm"','Tippe auf „Hinzufügen"'],
    man:['Öffne das Browser-Menü ⋮','Wähle „App installieren"','Bestätige die Installation'],
    updTitle:'Neue Version verfügbar', update:'Aktualisieren',
    diagTitle:'PWA-Diagnose', copy:'Bericht kopieren', copied:'Kopiert ✓', close:'Schließen',
    httpsBad:'PWA funktioniert nur über https oder auf localhost',
    installedNow:'Die App ist bereits installiert', standalone:'die Seite läuft im Standalone-Modus',
    mfOk:'Manifest eingebunden', mfNo:'Manifest nicht eingebunden', mfNoHint:'<link rel="manifest"> fehlt im <head>',
    mfRead:'manifest.json ist lesbar', mfErr:'Manifest-Fehler',
    fieldEmpty:'Feld ist leer — ohne das wird die Installation nicht angeboten',
    displayBrowser:'display: browser deaktiviert die Installation',
    themeMissing:'nicht gesetzt — die Statusleiste bleibt Standard',
    bgMissing:'nicht gesetzt — der Android-Splash wird weiß',
    icon:'Icon', iconRequired:'für die Installation erforderlich',
    maskable:'Maskable-Icon', maskableHint:'ohne es schneidet Android die Logo-Ränder ab',
    iconMissing:'Icon-Datei nicht gefunden', iconsOk:'Alle Icon-Dateien sind erreichbar', count:'Dateien',
    swNo:'Service Worker wird von diesem Browser nicht unterstützt',
    swMissing:'Service Worker nicht registriert', swMissingHint:'Chrome bietet ohne ihn keine Installation an',
    swActive:'Service Worker ist aktiv', swWaiting:'Update wartet', swCurrent:'Version ist aktuell',
    appleIconHint:'auf dem iPhone wird das Icon zum Screenshot der Seite',
    iosNote:'iOS: keine automatische Installation',
    iosNoteHint:'Safari kennt kein beforeinstallprompt — es wird eine Anleitung gezeigt',
    bipOk:'beforeinstallprompt wurde ausgelöst', bipOkHint:'der Browser ist installationsbereit',
    bipInstalled:'Wird nicht angeboten — bereits installiert',
    bipWarn:'beforeinstallprompt wurde nicht ausgelöst',
    bipWarnHint:'entweder ist die App bereits installiert oder Chrome hat zu wenig Interaktion gezählt — öffne die Seite erneut'
  },
  uk: {
    install:'Встановити', later:'Пізніше', ok:'Зрозуміло',
    ios:['Натисни «Поділитися» ⎙ внизу Safari','Обери «На екран «Домівка»»','Натисни «Додати»'],
    man:['Відкрий меню браузера ⋮','Обери «Встановити застосунок»','Підтверди встановлення'],
    updTitle:'Доступна нова версія', update:'Оновити',
    diagTitle:'Діагностика PWA', copy:'Скопіювати звіт', copied:'Скопійовано ✓', close:'Закрити',
    httpsBad:'PWA працює лише через https або на localhost',
    installedNow:'Застосунок вже встановлено', standalone:'сторінку відкрито в режимі standalone',
    mfOk:'Маніфест підключено', mfNo:'Маніфест не підключено', mfNoHint:'<link rel="manifest"> відсутній у <head>',
    mfRead:'manifest.json читається', mfErr:'Помилка маніфеста',
    fieldEmpty:'поле порожнє — без нього встановлення не запропонується',
    displayBrowser:'display: browser вимикає встановлення',
    themeMissing:'не задано — статус-бар буде системним',
    bgMissing:'не задано — splash на Android буде білим',
    icon:'Іконка', iconRequired:'обов’язкова для встановлення',
    maskable:'Maskable-іконка', maskableHint:'без неї Android обріже краї логотипа',
    iconMissing:'Файл іконки не знайдено', iconsOk:'Усі файли іконок на місці', count:'шт.',
    swNo:'Service worker не підтримується браузером',
    swMissing:'Service worker не зареєстровано', swMissingHint:'Chrome не запропонує встановлення без нього',
    swActive:'Service worker активний', swWaiting:'Очікує оновлення', swCurrent:'Версія актуальна',
    appleIconHint:'на iPhone іконка буде скриншотом сторінки',
    iosNote:'iOS: автовстановлення немає',
    iosNoteHint:'Safari не підтримує beforeinstallprompt — показується інструкція',
    bipOk:'Подія beforeinstallprompt спрацювала', bipOkHint:'браузер готовий встановити застосунок',
    bipInstalled:'Встановлення не пропонується — вже встановлено',
    bipWarn:'beforeinstallprompt не спрацював',
    bipWarnHint:'або застосунок вже встановлено, або Chrome ще не зарахував залученість — відкрий сторінку вдруге'
  }
};

function pickLang() {
  if (CFG.lang && CFG.lang !== 'auto') return L10N[CFG.lang] ? CFG.lang : 'en';
  var list = navigator.languages || [navigator.language || 'en'];
  for (var i = 0; i < list.length; i++) {
    var code = String(list[i]).slice(0, 2).toLowerCase();
    if (L10N[code]) return code;
  }
  return 'en';
}

var LANG = pickLang();
var T = L10N[LANG];


var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var deferred = null, box = null, bipFired = false, swReg = null, wantReload = false;

function installed() {
  return W.matchMedia('(display-mode: standalone)').matches ||
         W.matchMedia('(display-mode: minimal-ui)').matches ||
         navigator.standalone === true;
}
function snoozed() {
  try {
    var t = parseInt(localStorage.getItem(KEY) || '0', 10);
    return t > 0 && Date.now() - t < CFG.snooze * 86400000;
  } catch (e) { return false; }
}
function remember() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }

function emit(name, detail) {
  W.dispatchEvent(new CustomEvent('pwa:' + name, { detail: detail || {} }));
}

/* Установка возможна: либо браузер дал событие, либо это iOS с инструкцией */
function canInstall() { return !installed() && (!!deferred || isIOS); }

/* ─────────────────────────────────────────────
   1. МЕТА-ТЕГИ И МАНИФЕСТ
───────────────────────────────────────────── */
function meta(name, content, attr) {
  attr = attr || 'name';
  var m = D.head.querySelector('meta[' + attr + '="' + name + '"]');
  if (!m) { m = D.createElement('meta'); m.setAttribute(attr, name); D.head.appendChild(m); }
  m.setAttribute('content', content);
  return m;
}
function linkTag(rel, href, attrs) {
  var l = D.head.querySelector('link[rel="' + rel + '"]');
  if (!l) { l = D.createElement('link'); l.setAttribute('rel', rel); D.head.appendChild(l); }
  l.setAttribute('href', href);
  if (attrs) for (var k in attrs) l.setAttribute(k, attrs[k]);
  return l;
}

function injectHead() {
  if (!CFG.injectMeta) return;

  if (!D.head.querySelector('meta[name="viewport"]')) {
    meta('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  }
  meta('application-name', CFG.short);
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-status-bar-style', CFG.statusBar);
  meta('apple-mobile-web-app-title', CFG.short);
  meta('theme-color', CFG.themeDark);

  linkTag('manifest', CFG.manifest);
  linkTag('apple-touch-icon', CFG.icon192);
  if (CFG.favicon) linkTag('icon', CFG.favicon, { sizes: '32x32' });

  if (CFG.themeAuto) {
    var mq = W.matchMedia('(prefers-color-scheme: dark)');
    var apply = function (dark) { meta('theme-color', dark ? CFG.themeDark : CFG.themeLight); };
    apply(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', function (e) { apply(e.matches); });
  }
}

/* ─────────────────────────────────────────────
   2. SERVICE WORKER
───────────────────────────────────────────── */
function registerSW() {
  if (!CFG.registerSW || !('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    console.warn('[pwa] Service worker работает только по HTTPS или на localhost');
    return;
  }
  navigator.serviceWorker.register(CFG.sw, { scope: CFG.scope }).then(function (reg) {
    swReg = reg;
    reg.addEventListener('updatefound', function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', function () {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          emit('update', { apply: function () { applyUpdate(nw); } });
          showUpdateToast(nw);
        }
      });
    });
  }).catch(function (e) {
    console.warn('[pwa] Service worker не зарегистрирован: ' + e.message);
  });

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!wantReload) return;
    wantReload = false;
    location.reload();
  });
}

function applyUpdate(worker) {
  wantReload = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

function showUpdateToast(worker) {
  if (!CFG.updateToast || D.getElementById('pwa-upd')) return;
  injectCss();
  var t = D.createElement('div');
  t.id = 'pwa-upd';
  var span = D.createElement('span');
  span.textContent = T.updTitle;
  var b = D.createElement('button');
  b.textContent = T.update;
  b.style.background = CFG.accent;
  b.onclick = function () { applyUpdate(worker); t.remove(); };
  var x = D.createElement('button');
  x.className = 'ghost';
  x.textContent = T.later;
  x.onclick = function () { t.remove(); };
  t.appendChild(span); t.appendChild(x); t.appendChild(b);
  D.body.appendChild(t);
}

/* ─────────────────────────────────────────────
   3. ОКНО УСТАНОВКИ
───────────────────────────────────────────── */
function injectCss() {
  var off  = (parseInt(CFG.offset, 10) || 0) + 'px';
  var top  = CFG.barPos === 'top';
  var sig  = [CFG.barPos, off, CFG.accent].join('|');
  var old  = D.getElementById('pwa-install-css');
  if (old) {
    if (old.getAttribute('data-sig') === sig) return;
    old.remove();                       // настройки изменились — стиль пересобираем
  }
  var st = D.createElement('style');
  st.id = 'pwa-install-css';
  st.setAttribute('data-sig', sig);
  st.textContent = [
    top
      ? '#pwa-ov.is-bar{align-items:flex-start;padding-top:calc(' + off + ' + env(safe-area-inset-top))}'
      : '#pwa-ov.is-bar{align-items:flex-end;padding-bottom:calc(' + off + ' + env(safe-area-inset-bottom))}',
    '#pwa-fab.bottom{bottom:calc(' + off + ' + env(safe-area-inset-bottom))}',
    '#pwa-fab.top{top:calc(' + off + ' + env(safe-area-inset-top))}',
    '#pwa-upd{bottom:calc(' + off + ' + env(safe-area-inset-bottom))}',
    top ? '#pwa-ov.is-bar #pwa-card{animation:pwaDown .3s cubic-bezier(.32,1,.23,1)}' : '',
    '@keyframes pwaDown{from{transform:translateY(-24px);opacity:0}to{transform:none;opacity:1}}',
    '#pwa-ov{position:fixed;inset:0;z-index:99999;display:flex;padding:16px;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;animation:pwaFade .22s ease}',
    '#pwa-ov.is-modal{align-items:center;justify-content:center;background:rgba(0,0,0,.55);',
    '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}',
    '#pwa-ov.is-bar{justify-content:center;pointer-events:none}',
    '#pwa-card{pointer-events:auto;background:#fff;color:#111;width:100%;max-width:380px;',
    'border-radius:22px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.35);',
    'animation:pwaUp .3s cubic-bezier(.32,1,.23,1)}',
    '#pwa-ov.is-bar #pwa-card{max-width:520px;border-radius:18px;padding:12px 14px;',
    'display:flex;align-items:center;gap:12px;text-align:left}',
    '#pwa-ico{width:64px;height:64px;border-radius:16px;display:block;margin:0 auto 14px;',
    'box-shadow:0 6px 18px rgba(0,0,0,.18)}',
    '#pwa-ov.is-bar #pwa-ico{width:44px;height:44px;border-radius:12px;margin:0;flex:0 0 auto}',
    '#pwa-txt{text-align:center;min-width:0}',
    '#pwa-ov.is-bar #pwa-txt{text-align:left;flex:1}',
    '#pwa-name{font-size:17px;font-weight:700;line-height:1.25}',
    '#pwa-ov.is-bar #pwa-name{font-size:14px}',
    '#pwa-desc{font-size:13px;opacity:.65;margin-top:4px;line-height:1.4}',
    '#pwa-ov.is-bar #pwa-desc{font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#pwa-steps{margin-top:18px;display:flex;flex-direction:column;gap:12px;text-align:left}',
    '.pwa-step{display:flex;align-items:center;gap:12px;font-size:14px;line-height:1.35;opacity:.85}',
    '.pwa-num{flex:0 0 auto;width:28px;height:28px;border-radius:9px;color:#fff;display:flex;',
    'align-items:center;justify-content:center;font-size:13px;font-weight:700}',
    '#pwa-btns{display:flex;gap:8px;margin-top:20px}',
    '#pwa-ov.is-bar #pwa-btns{margin-top:0;flex:0 0 auto}',
    '.pwa-btn{flex:1;padding:13px 16px;border:0;border-radius:14px;font-size:14px;font-weight:700;',
    'cursor:pointer;font-family:inherit}',
    '#pwa-ov.is-bar .pwa-btn{padding:9px 14px;border-radius:11px;font-size:13px}',
    '.pwa-btn.ghost{background:rgba(120,120,128,.16);color:inherit;font-weight:600}',
    '#pwa-upd{position:fixed;left:50%;transform:translateX(-50%);z-index:99999;',
    'display:flex;align-items:center;gap:10px;',
    'background:#1c1c1e;color:#fff;padding:10px 12px;border-radius:14px;font-size:13px;',
    'font-family:system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);',
    'animation:pwaUp .3s cubic-bezier(.32,1,.23,1);max-width:calc(100vw - 32px)}',
    '#pwa-upd button{border:0;border-radius:10px;padding:7px 12px;font-size:13px;font-weight:700;',
    'color:#fff;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '#pwa-upd button.ghost{background:rgba(255,255,255,.16);font-weight:600}',
    '@keyframes pwaFade{from{opacity:0}to{opacity:1}}',
    '@keyframes pwaUp{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}',
    '@media (prefers-color-scheme:dark){#pwa-card{background:#1c1c1e;color:#f5f5f7}',
    '.pwa-btn.ghost{background:rgba(255,255,255,.14)}}',
    '#pwa-fab{position:fixed;z-index:99998;right:calc(14px + env(safe-area-inset-right));',
    'display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:9px 16px 9px 9px;',
    'color:#fff;font-size:13px;font-weight:700;font-family:system-ui,-apple-system,sans-serif;',
    'cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.3);animation:pwaUp .3s cubic-bezier(.32,1,.23,1)}',
    '#pwa-fab img{width:26px;height:26px;border-radius:8px;display:block}',
    '[data-pwa-install][hidden]{display:none!important}',
    '#pwa-diag{position:fixed;inset:0;z-index:100000;background:#0b0d12;color:#e6e9ef;overflow:auto;',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;',
    'padding:calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom))}',
    '#pwa-diag h3{font-size:15px;margin:0 0 4px}',
    '#pwa-diag .sub{opacity:.55;font-size:12px;margin-bottom:14px;word-break:break-all}',
    '#pwa-diag .row{display:flex;gap:9px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08)}',
    '#pwa-diag .row .st{flex:0 0 auto;width:18px;text-align:center}',
    '#pwa-diag .row .tx{flex:1;min-width:0;word-break:break-word}',
    '#pwa-diag .row .hint{display:block;opacity:.55;font-size:11.5px;margin-top:2px}',
    '#pwa-diag .ok{color:#4ade80}#pwa-diag .bad{color:#f87171}#pwa-diag .warn{color:#fbbf24}',
    '#pwa-diag .acts{display:flex;gap:8px;margin-top:16px;position:sticky;bottom:0;padding-bottom:4px}',
    '#pwa-diag .acts button{flex:1;padding:12px;border:0;border-radius:12px;font:inherit;',
    'font-weight:700;background:rgba(255,255,255,.12);color:#fff;cursor:pointer}'
  ].join('');
  D.head.appendChild(st);
}

function el(tag, id, text) {
  var n = D.createElement(tag);
  if (id) n.id = id;
  if (text) n.textContent = text;
  return n;
}
function close(rem) {
  if (rem) remember();
  if (box) { box.remove(); box = null; }
}

function show(force) {
  if (box) return;
  if (!force && (installed() || snoozed())) return;
  injectCss();

  var iosMode  = isIOS && !deferred;
  var manual   = !isIOS && !deferred && !CFG.preview;   // браузер не дал beforeinstallprompt

  box = el('div', 'pwa-ov');
  box.className = (iosMode || manual) ? 'is-modal' : ('is-' + CFG.style);

  var card = el('div', 'pwa-card');

  var icon = D.createElement('img');
  icon.id = 'pwa-ico';
  icon.src = CFG.icon192;
  icon.alt = '';
  card.appendChild(icon);

  var txt = el('div', 'pwa-txt');
  txt.appendChild(el('div', 'pwa-name', CFG.name));
  if (CFG.desc) txt.appendChild(el('div', 'pwa-desc', CFG.desc));
  card.appendChild(txt);

  if (iosMode || manual) {
    var steps = el('div', 'pwa-steps');
    (iosMode ? T.ios : T.man).forEach(function (s, i) {
      var row = el('div'); row.className = 'pwa-step';
      var num = el('div', null, String(i + 1));
      num.className = 'pwa-num';
      num.style.background = CFG.accent;
      row.appendChild(num);
      row.appendChild(el('div', null, s));
      steps.appendChild(row);
    });
    card.appendChild(steps);
  }

  var btns = el('div', 'pwa-btns');
  var later = el('button', null, T.later);
  later.className = 'pwa-btn ghost';
  later.onclick = function () { close(true); };

  var main = el('button', null, (iosMode || manual) ? T.ok : T.install);
  main.className = 'pwa-btn';
  main.style.background = CFG.accent;
  main.style.color = '#fff';
  main.onclick = function () {
    if (!deferred) { close(true); return; }
    close(false);
    var d = deferred;
    deferred = null;
    d.prompt();
    d.userChoice.then(function (res) { if (res.outcome === 'dismissed') remember(); });
  };

  if (!iosMode && !manual) btns.appendChild(later);
  btns.appendChild(main);
  card.appendChild(btns);

  box.appendChild(card);
  box.addEventListener('click', function (e) { if (e.target === box) close(true); });
  (D.body || D.documentElement).appendChild(box);
}

function listen() {
  W.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    bipFired = true;
    emit('available', { ios: false });
    syncButtons();
    if (CFG.autoPrompt) setTimeout(function () { show(false); }, CFG.delay);
  });
  W.addEventListener('appinstalled', function () {
    close(false);
    deferred = null;
    try { localStorage.removeItem(KEY); } catch (e) {}
    emit('installed', {});
    syncButtons();
  });
  if (isIOS && !installed()) {
    emit('available', { ios: true });
    if (CFG.autoPrompt) setTimeout(function () { show(false); }, CFG.delay);
  }
  syncButtons();
}

/* ─────────────────────────────────────────────
   3b. КНОПКИ УСТАНОВКИ
   Любой элемент с data-pwa-install становится кнопкой.
   Плавающая кнопка в углу — по настройке CFG.button.
───────────────────────────────────────────── */
function syncButtons() {
  var ok = canInstall();

  var own = D.querySelectorAll('[data-pwa-install]');
  for (var i = 0; i < own.length; i++) {
    var b = own[i];
    if (!b.getAttribute('data-pwa-bound')) {
      b.setAttribute('data-pwa-bound', '1');
      b.addEventListener('click', function (e) { e.preventDefault(); show(true); });
    }
    b.hidden = !ok;
  }

  if (CFG.button === 'none') return;

  var fab = D.getElementById('pwa-fab');
  if (!ok) { if (fab) fab.remove(); return; }
  if (fab) return;

  injectCss();
  fab = D.createElement('button');
  fab.id = 'pwa-fab';
  fab.type = 'button';
  fab.className = CFG.button === 'tr' ? 'top' : 'bottom';
  fab.style.background = CFG.accent;

  var im = D.createElement('img');
  im.src = CFG.icon192;
  im.alt = '';
  fab.appendChild(im);
  fab.appendChild(D.createTextNode(CFG.buttonText || T.install));
  fab.onclick = function () { show(true); };
  (D.body || D.documentElement).appendChild(fab);
}

/* ─────────────────────────────────────────────
   4. ДИАГНОСТИКА  —  ?pwa=check  или  PWA.check()
───────────────────────────────────────────── */
function head200(url) {
  return fetch(url, { method: 'GET', cache: 'no-store' })
    .then(function (r) { return r.ok; })
    .catch(function () { return false; });
}

function check() {
  injectCss();
  var old = D.getElementById('pwa-diag');
  if (old) old.remove();

  var wrap = el('div', 'pwa-diag');
  var h = el('h3', null, T.diagTitle);
  var sub = el('div', null, location.href.split('?')[0] + '  ·  ' + LANG);
  sub.className = 'sub';
  wrap.appendChild(h); wrap.appendChild(sub);
  var list = el('div', 'pwa-diag-list');
  wrap.appendChild(list);

  var acts = el('div');
  acts.className = 'acts';
  var copyBtn = el('button', null, T.copy);
  var closeBtn = el('button', null, T.close);
  closeBtn.onclick = function () { wrap.remove(); };
  acts.appendChild(copyBtn); acts.appendChild(closeBtn);
  wrap.appendChild(acts);
  (D.body || D.documentElement).appendChild(wrap);

  var lines = [];
  function add(state, text, hint) {
    var row = el('div'); row.className = 'row';
    var st = el('div', null, state === 'ok' ? '✓' : state === 'bad' ? '✕' : '!');
    st.className = 'st ' + state;
    var tx = el('div', null, text);
    tx.className = 'tx';
    if (hint) {
      var hs = el('span', null, hint);
      hs.className = 'hint';
      tx.appendChild(hs);
    }
    row.appendChild(st); row.appendChild(tx);
    list.appendChild(row);
    lines.push((state === 'ok' ? '[OK]  ' : state === 'bad' ? '[FAIL] ' : '[WARN] ') + text + (hint ? ' — ' + hint : ''));
  }

  copyBtn.onclick = function () {
    var report = T.diagTitle + ' — ' + location.origin + '\n' + lines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(report);
    copyBtn.textContent = T.copied;
  };

  var secure = location.protocol === 'https:' || location.hostname === 'localhost';
  add(secure ? 'ok' : 'bad', 'HTTPS', secure ? location.protocol : T.httpsBad);

  if (installed()) add('ok', T.installedNow, T.standalone);

  var mLink = D.querySelector('link[rel="manifest"]');
  if (mLink) add('ok', T.mfOk, mLink.getAttribute('href'));
  else add('bad', T.mfNo, T.mfNoHint);

  Promise.resolve().then(function () {
    if (!mLink) return null;
    return fetch(mLink.href, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }).then(function (m) {
    if (!m) return null;
    add('ok', T.mfRead);

    ['name', 'short_name', 'start_url', 'display'].forEach(function (k) {
      add(m[k] ? 'ok' : 'bad', k, m[k] ? String(m[k]) : T.fieldEmpty);
    });
    add(m.display === 'standalone' || m.display === 'fullscreen' || m.display === 'minimal-ui' ? 'ok' : 'warn',
        'display = ' + (m.display || '—'),
        m.display === 'browser' ? T.displayBrowser : '');
    add(m.theme_color ? 'ok' : 'warn', 'theme_color', m.theme_color || T.themeMissing);
    add(m.background_color ? 'ok' : 'warn', 'background_color', m.background_color || T.bgMissing);

    var icons = m.icons || [];
    var sizes = icons.map(function (i) { return i.sizes || ''; }).join(' ');
    add(/192x192/.test(sizes) ? 'ok' : 'bad', T.icon + ' 192×192', /192x192/.test(sizes) ? '' : T.iconRequired);
    add(/512x512/.test(sizes) ? 'ok' : 'bad', T.icon + ' 512×512', /512x512/.test(sizes) ? '' : T.iconRequired);
    var hasMask = icons.some(function (i) { return (i.purpose || '').indexOf('maskable') >= 0; });
    add(hasMask ? 'ok' : 'warn', T.maskable, hasMask ? '' : T.maskableHint);

    var checks = icons.slice(0, 12).map(function (i) {
      var u = new URL(i.src, mLink.href).href;
      return head200(u).then(function (ok) { return { ok: ok, u: i.src }; });
    });
    return Promise.all(checks);
  }).then(function (res) {
    if (!res) return;
    var bad = res.filter(function (r) { return !r.ok; });
    if (bad.length) {
      bad.forEach(function (b) { add('bad', T.iconMissing, b.u); });
    } else {
      add('ok', T.iconsOk, res.length + ' ' + T.count);
    }
  }).catch(function (e) {
    add('bad', T.mfErr, e.message);
  }).then(function () {
    if (!('serviceWorker' in navigator)) { add('bad', T.swNo); return null; }
    return navigator.serviceWorker.getRegistration();
  }).then(function (reg) {
    if (reg === null) return;
    if (!reg) {
      add('bad', T.swMissing, T.swMissingHint);
    } else {
      add('ok', T.swActive, 'scope: ' + reg.scope);
      add(reg.waiting ? 'warn' : 'ok', reg.waiting ? T.swWaiting : T.swCurrent);
    }
  }).then(function () {
    add(D.querySelector('link[rel="apple-touch-icon"]') ? 'ok' : 'warn', 'apple-touch-icon',
        D.querySelector('link[rel="apple-touch-icon"]') ? '' : T.appleIconHint);
    add(D.querySelector('meta[name="theme-color"]') ? 'ok' : 'warn', 'meta theme-color');
    return new Promise(function (res) { setTimeout(res, 2500); });
  }).then(function () {
    if (isIOS) {
      add('warn', T.iosNote, T.iosNoteHint);
    } else if (bipFired) {
      add('ok', T.bipOk, T.bipOkHint);
    } else if (installed()) {
      add('ok', T.bipInstalled);
    } else {
      add('warn', T.bipWarn, T.bipWarnHint);
    }
  });
}

/* ─────────────────────────────────────────────
   5. СТАРТ
───────────────────────────────────────────── */
var API = {
  show: function () { show(true); },
  hide: function () { close(false); },
  check: check,
  installed: installed,
  setTheme: function (c) { meta('theme-color', c); },
  setIcon: function (src) { CFG.icon192 = src; },
  canInstall: canInstall,
  sync: syncButtons,
  reset: function () { try { localStorage.removeItem(KEY); } catch (e) {} },
  config: CFG
};
W.PWA = API;

function onReady(fn) {
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', fn);
  else fn();
}

if (CFG.auto) {
  injectHead();            // мета-теги ставим сразу, до отрисовки
  onReady(function () {
    registerSW();
    listen();
    if (/[?&]pwa=check/.test(location.search)) setTimeout(check, 400);
  });
}

})();
