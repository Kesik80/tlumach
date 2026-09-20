// ============================================================
//  Übersetzer — выдача временного токена для голосового режима
//  Кладётся как:  /api/live-token.js
//
//  Браузер не может подключиться к Gemini Live с настоящим ключом —
//  его пришлось бы отдать клиенту. Поэтому сервер просит у Google
//  одноразовый токен (живёт минуты) и отдаёт только его.
//  Язык перевода зашит в токен: клиент его подменить не может.
//
//  Environment Variables на Vercel:
//    GEMINI_API_KEY   — тот же ключ, что у /api/translate
//    MODEL_LIVE       — опционально, модель синхронного перевода
//    ALLOWED_ORIGINS  — опционально, как в translate.js
// ============================================================

const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const MODEL_LIVE = process.env.MODEL_LIVE || 'gemini-3.5-live-translate-preview';

// Коды BCP-47, которые понимает Live Translate.
const TARGETS = ['de', 'ru', 'uk', 'en'];

// Токен одноразовый: каждое подключение (и каждая смена стороны) — новый.
const SESSION_MIN = 20;      // сколько живёт уже открытое соединение
const START_WINDOW_S = 60;   // за сколько секунд надо успеть подключиться

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const hits = new Map();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается. Нужен POST.');
  if (!process.env.GEMINI_API_KEY) return fail(res, 500, 'На сервере не задан GEMINI_API_KEY.');
  if (!isAllowedOrigin(req)) return fail(res, 403, 'Запрос с чужого источника отклонён.');
  if (!underRateLimit(clientIp(req))) return fail(res, 429, 'Слишком часто. Подожди минуту.');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(res, 400, 'Тело запроса — не JSON.'); }
  }
  const to = String((body && body.to) || '').toLowerCase();
  if (TARGETS.indexOf(to) === -1) return fail(res, 400, 'Неизвестный язык перевода.');

  const now = Date.now();
  const payload = {
    uses: 1,
    expireTime: new Date(now + SESSION_MIN * 60_000).toISOString(),
    newSessionExpireTime: new Date(now + START_WINDOW_S * 1000).toISOString(),
    liveConnectConstraints: {
      model: `models/${MODEL_LIVE}`,
      config: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: to,
          // Речь уже на целевом языке не повторять. Благодаря этому
          // перевод, который телефон сам же проигрывает, не уходит по кругу.
          echoTargetLanguage: false
        }
      }
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const upstream = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const raw = await upstream.text().catch(() => '');
      console.error('auth_tokens error', upstream.status, raw.slice(0, 400));
      if (upstream.status === 429) return fail(res, 429, 'Лимит бесплатного тарифа исчерпан. Попробуй позже.');
      if (upstream.status === 404) return fail(res, 502, `Модель ${MODEL_LIVE} недоступна для этого ключа.`);
      if (upstream.status === 400 || upstream.status === 403) {
        return fail(res, 502, 'Google отклонил запрос токена. Проверь GEMINI_API_KEY и MODEL_LIVE.');
      }
      return fail(res, 502, `Сервис токенов вернул ошибку (${upstream.status}).`);
    }

    const data = await upstream.json().catch(() => null);
    if (!data || typeof data.name !== 'string') return fail(res, 502, 'Токен не получен.');

    return res.status(200).json({ token: data.name, model: MODEL_LIVE, to });
  } catch (e) {
    if (e && e.name === 'AbortError') return fail(res, 504, 'Google не ответил вовремя.');
    console.error('live-token failed', e);
    return fail(res, 502, 'Не удалось получить токен.');
  } finally {
    clearTimeout(timer);
  }
};

// ---- те же проверки, что в translate.js ----

function isAllowedOrigin(req) {
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return false;

  let host;
  try { host = new URL(src).host; } catch { return false; }

  if (host === req.headers.host) return true;

  const list = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return list.some(entry => {
    try { return new URL(entry).host === host; } catch { return entry === host; }
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function underRateLimit(ip) {
  const now = Date.now();
  for (const [key, stamps] of hits) {
    const fresh = stamps.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length) hits.set(key, fresh); else hits.delete(key);
  }
  const mine = hits.get(ip) || [];
  if (mine.length >= RATE_MAX) return false;
  mine.push(now);
  hits.set(ip, mine);
  return true;
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}
