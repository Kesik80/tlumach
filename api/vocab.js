// ============================================================
//  Тлумач — запись глагола в словарь verb-de
//  Кладётся как:  /api/vocab.js
//
//  Читает woerterbuch.json из репозитория, добавляет одну запись
//  и коммитит обратно. Формат записи в точности как у существующих.
//
//  Environment Variables на Vercel:
//    GITHUB_TOKEN   — обязательно. Fine-grained token, доступ только
//                     к репозиторию Verb_de, право Contents: Read and write
//    GITHUB_REPO    — по умолчанию Kesik80/Verb_de
//    GITHUB_PATH    — по умолчанию woerterbuch.json
//    GITHUB_BRANCH  — по умолчанию main
//    ALLOWED_ORIGINS — как в translate.js
// ============================================================

const REPO = process.env.GITHUB_REPO || 'Kesik80/Verb_de';
const PATH = process.env.GITHUB_PATH || 'woerterbuch.json';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const API = 'https://api.github.com';

const PERSON_KEYS = ['ich', 'du', 'er/sie/es', 'wir', 'ihr', 'sie/Sie'];
const TABLE_KEYS = ['praesens', 'praeteritum', 'perfekt', 'konjunktiv2'];

// Запись в чужой репозиторий дороже ошибки, чем лишний перевод,
// поэтому лимит жёстче, чем у translate.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 6;
const hits = new Map();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return fail(res, 405, 'Метод не поддерживается. Нужен POST.');
  if (!process.env.GITHUB_TOKEN) return fail(res, 500, 'На сервере не задан GITHUB_TOKEN.');
  if (!isAllowedOrigin(req)) return fail(res, 403, 'Запрос с чужого источника отклонён.');
  if (!underRateLimit(clientIp(req))) return fail(res, 429, 'Слишком часто. Подожди минуту.');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(res, 400, 'Тело запроса — не JSON.'); }
  }
  if (!body || typeof body !== 'object') return fail(res, 400, 'Пустое тело запроса.');

  const entry = validateEntry(body.entry);
  if (!entry) return fail(res, 400, 'Карточка глагола заполнена не полностью.');

  const key = entry.infinitiv;
  delete entry.infinitiv;          // в файле инфинитив — это ключ, а не поле
  const overwrite = body.overwrite === true;

  try {
    const current = await loadFile();
    if (!current) return fail(res, 502, 'Не удалось прочитать словарь из GitHub.');

    const { dict, sha } = current;
    if (dict[key] && !overwrite) {
      return res.status(409).json({
        error: `«${key}» уже есть в словаре.`,
        exists: true,
        total: Object.keys(dict).length
      });
    }

    entry.addedAt = new Date().toISOString();
    dict[key] = entry;

    // Ключи по алфавиту: файл правится и руками, диффы должны читаться.
    const sorted = {};
    Object.keys(dict).sort(function (a, b) {
      return a.localeCompare(b, 'de');
    }).forEach(function (k) { sorted[k] = dict[k]; });

    const saved = await saveFile(sorted, sha, key, dict[key] && overwrite);
    if (!saved.ok) return fail(res, 502, saved.message);

    return res.status(200).json({
      saved: true,
      verb: key,
      total: Object.keys(sorted).length
    });

  } catch (err) {
    console.error('vocab handler failed', err);
    return fail(res, 500, 'Внутренняя ошибка при записи в словарь.');
  }
};

// ---------- GitHub ----------

function ghHeaders() {
  return {
    'authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'tlumach'
  };
}

async function loadFile() {
  const url = `${API}/repos/${REPO}/contents/${encodeURIComponent(PATH)}?ref=${encodeURIComponent(BRANCH)}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (!r.ok) {
    console.error('GitHub read failed', r.status, (await r.text().catch(() => '')).slice(0, 300));
    return null;
  }
  const meta = await r.json();
  let dict;
  try {
    dict = JSON.parse(Buffer.from(meta.content || '', 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return null;
  return { dict, sha: meta.sha };
}

async function saveFile(dict, sha, key, isUpdate) {
  const url = `${API}/repos/${REPO}/contents/${encodeURIComponent(PATH)}`;
  const content = Buffer.from(JSON.stringify(dict, null, 2) + '\n', 'utf8').toString('base64');

  const r = await fetch(url, {
    method: 'PUT',
    headers: Object.assign({ 'content-type': 'application/json' }, ghHeaders()),
    body: JSON.stringify({
      message: `${isUpdate ? 'Обновлён' : 'Добавлен'} глагол ${key} (Тлумач)`,
      content,
      sha,
      branch: BRANCH
    })
  });

  if (r.ok) return { ok: true };

  const detail = (await r.text().catch(() => '')).slice(0, 300);
  console.error('GitHub write failed', r.status, detail);
  if (r.status === 409) return { ok: false, message: 'Словарь изменился параллельно. Попробуй ещё раз.' };
  if (r.status === 401 || r.status === 403) return { ok: false, message: 'GitHub отклонил токен. Проверь права Contents: Read and write.' };
  if (r.status === 404) return { ok: false, message: `Файл ${PATH} в ${REPO} не найден.` };
  return { ok: false, message: `GitHub вернул ошибку (${r.status}).` };
}

// ---------- проверка карточки ----------

function validateEntry(input) {
  if (!input || typeof input !== 'object') return null;

  const str = v => (typeof v === 'string' ? v.trim() : '');
  const infinitiv = str(input.infinitiv).slice(0, 40);
  const bedeutung = str(input.bedeutung).slice(0, 200);
  const hauptformen = str(input.hauptformen).slice(0, 120);
  const hilfsverb = str(input.hilfsverb);
  const typ = str(input.typ);

  if (!infinitiv || !/^[A-Za-zÄÖÜäöüß-]{2,40}$/.test(infinitiv)) return null;
  if (!bedeutung || !hauptformen) return null;
  if (hilfsverb !== 'haben' && hilfsverb !== 'sein') return null;

  const tabelle = {};
  for (const section of TABLE_KEYS) {
    const src = input.tabelle && input.tabelle[section];
    if (!src || typeof src !== 'object') return null;
    const rows = {};
    for (const person of PERSON_KEYS) {
      const v = str(src[person]).slice(0, 80);
      if (!v) return null;
      rows[person] = v;
    }
    tabelle[section] = rows;
  }

  return {
    infinitiv,
    niveau: str(input.niveau).slice(0, 4) || 'B1',
    typ: typ || 'regelmäßig',
    hilfsverb,
    bedeutung,
    // В существующих записях hauptformen — объект с text и mp3.
    // mp3 не выдумываем: verb-de читает его через ?. и переживёт отсутствие.
    hauptformen: { text: hauptformen },
    tabelle
  };
}

// ---------- общее ----------

function isAllowedOrigin(req) {
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return false;
  let host;
  try { host = new URL(src).host; } catch { return false; }
  if (host === req.headers.host) return true;

  return (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .some(entry => {
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
  for (const [k, stamps] of hits) {
    const fresh = stamps.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length) hits.set(k, fresh); else hits.delete(k);
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
