// ============================================================
//  Тлумач — запись в репозитории GitHub
//  Кладётся как:  /api/vocab.js
//
//  Три цели, выбираются полем "kind":
//    verb    → Verb_de / woerterbuch.json   — словарь глаголов (verb-de)
//    noun    → Verb_de / substantive.json   — словарь существительных
//    phrases → tlumach / phrases-mine.js    — свой разговорник
//
//  Environment Variables на Vercel:
//    GITHUB_TOKEN     — fine-grained token с доступом к ОБОИМ репозиториям,
//                       право Contents: Read and write
//    GITHUB_REPO_DICT — по умолчанию Kesik80/Verb_de
//    GITHUB_REPO_APP  — по умолчанию Kesik80/tlumach
//    GITHUB_BRANCH    — по умолчанию main
//    ALLOWED_ORIGINS  — как в translate.js
// ============================================================

const REPO_DICT = process.env.GITHUB_REPO_DICT || 'Kesik80/Verb_de';
const REPO_APP = process.env.GITHUB_REPO_APP || 'Kesik80/tlumach';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const API = 'https://api.github.com';

const TARGETS = {
  verb: { repo: REPO_DICT, path: process.env.GITHUB_PATH || 'woerterbuch.json', format: 'dict' },
  noun: { repo: REPO_DICT, path: 'substantive.json', format: 'dict' },
  phrases: { repo: REPO_APP, path: 'phrases-mine.js', format: 'phrases' }
};

const PERSON_KEYS = ['ich', 'du', 'er/sie/es', 'wir', 'ihr', 'sie/Sie'];
const TABLE_KEYS = ['praesens', 'praeteritum', 'perfekt', 'konjunktiv2'];
const ARTICLES = ['der', 'die', 'das'];

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

  const kind = body.kind === 'noun' ? 'noun' : body.kind === 'phrases' ? 'phrases' : 'verb';
  const target = TARGETS[kind];

  try {
    if (kind === 'phrases') return await savePhrases(res, body, target);
    return await saveWord(res, body, target, kind);
  } catch (err) {
    console.error('vocab handler failed', err);
    return fail(res, 500, 'Внутренняя ошибка при записи.');
  }
};

// ---------- слова ----------

async function saveWord(res, body, target, kind) {
  const entry = kind === 'noun' ? validateNoun(body.entry) : validateVerb(body.entry);
  if (!entry) {
    return fail(res, 400, kind === 'noun'
      ? 'Карточка существительного заполнена не полностью.'
      : 'Карточка глагола заполнена не полностью.');
  }

  const key = entry.key;
  delete entry.key;                       // в файле слово — это ключ, а не поле
  const overwrite = body.overwrite === true;

  // Файла существительных может ещё не быть — это не ошибка.
  const current = await loadJson(target, kind === 'noun');
  if (!current) return fail(res, 502, 'Не удалось прочитать файл из GitHub.');

  const { data: dict, sha } = current;
  if (dict[key] && !overwrite) {
    return res.status(409).json({
      error: `«${key}» уже есть в словаре.`,
      exists: true,
      total: Object.keys(dict).length
    });
  }

  const isUpdate = !!dict[key];
  entry.addedAt = new Date().toISOString();
  dict[key] = entry;

  const sorted = {};
  Object.keys(dict).sort((a, b) => a.localeCompare(b, 'de')).forEach(k => { sorted[k] = dict[k]; });

  const content = JSON.stringify(sorted, null, 2) + '\n';
  const saved = await putFile(target, content, sha,
    `${isUpdate ? 'Обновлено' : 'Добавлено'} ${kind === 'noun' ? 'существительное' : 'глагол'} ${key} (Тлумач)`);
  if (!saved.ok) return fail(res, 502, saved.message);

  return res.status(200).json({ saved: true, word: key, total: Object.keys(sorted).length });
}

// ---------- разговорник ----------

async function savePhrases(res, body, target) {
  const list = validatePhrases(body.phrases);
  if (!list) return fail(res, 400, 'Список фраз пуст или составлен неверно.');

  // Файл кладётся как .js, а не .json, намеренно: service worker
  // не кэширует .json, и разговорник перестал бы работать офлайн.
  const content = [
    '/* Свой разговорник Тлумача. Файл перезаписывается из приложения,',
    '   правки руками будут затёрты при следующем сохранении. */',
    'window.TLUMACH_MY_PHRASES = ' + JSON.stringify(list, null, 2) + ';',
    ''
  ].join('\n');

  const current = await loadRaw(target);   // может не существовать
  const saved = await putFile(target, content, current ? current.sha : null,
    `Разговорник: ${list.length} фраз (Тлумач)`);
  if (!saved.ok) return fail(res, 502, saved.message);

  return res.status(200).json({ saved: true, total: list.length });
}

// ---------- GitHub ----------

function ghHeaders() {
  return {
    'authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'tlumach'
  };
}

async function loadRaw(target) {
  const url = `${API}/repos/${target.repo}/contents/${encodeURIComponent(target.path)}?ref=${encodeURIComponent(BRANCH)}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) {
    console.error('GitHub read failed', r.status, (await r.text().catch(() => '')).slice(0, 300));
    return null;
  }
  const meta = await r.json();
  return { text: Buffer.from(meta.content || '', 'base64').toString('utf8'), sha: meta.sha };
}

async function loadJson(target, mayBeMissing) {
  const raw = await loadRaw(target);
  if (!raw) return mayBeMissing ? { data: {}, sha: null } : null;
  let data;
  try { data = JSON.parse(raw.text); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return { data, sha: raw.sha };
}

async function putFile(target, content, sha, message) {
  const url = `${API}/repos/${target.repo}/contents/${encodeURIComponent(target.path)}`;
  const payload = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) payload.sha = sha;   // без sha GitHub создаёт новый файл

  const r = await fetch(url, {
    method: 'PUT',
    headers: Object.assign({ 'content-type': 'application/json' }, ghHeaders()),
    body: JSON.stringify(payload)
  });
  if (r.ok) return { ok: true };

  const detail = (await r.text().catch(() => '')).slice(0, 300);
  console.error('GitHub write failed', r.status, target.repo, target.path, detail);
  if (r.status === 409) return { ok: false, message: 'Файл изменился параллельно. Попробуй ещё раз.' };
  if (r.status === 401 || r.status === 403) {
    return { ok: false, message: `GitHub отклонил токен для ${target.repo}. Проверь, что репозиторий добавлен в права токена.` };
  }
  if (r.status === 404) return { ok: false, message: `Репозиторий ${target.repo} недоступен для этого токена.` };
  return { ok: false, message: `GitHub вернул ошибку (${r.status}).` };
}

// ---------- проверка данных ----------

const str = v => (typeof v === 'string' ? v.trim() : '');

function validateVerb(input) {
  if (!input || typeof input !== 'object') return null;

  const infinitiv = str(input.infinitiv).slice(0, 40);
  const bedeutung = str(input.bedeutung).slice(0, 200);
  const hauptformen = str(input.hauptformen).slice(0, 120);
  const hilfsverb = str(input.hilfsverb);

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
    key: infinitiv,
    niveau: str(input.niveau).slice(0, 4) || 'B1',
    typ: str(input.typ) || 'regelmäßig',
    hilfsverb,
    bedeutung,
    hauptformen: { text: hauptformen },
    tabelle
  };
}

function validateNoun(input) {
  if (!input || typeof input !== 'object') return null;

  const wort = str(input.wort).slice(0, 60);
  const artikel = str(input.artikel).toLowerCase();
  const plural = str(input.plural).slice(0, 80);
  const bedeutung = str(input.bedeutung).slice(0, 200);

  if (!wort || !/^[A-Za-zÄÖÜäöüß -]{2,60}$/.test(wort)) return null;
  if (ARTICLES.indexOf(artikel) === -1) return null;   // род обязателен, это суть карточки
  if (!plural || !bedeutung) return null;

  const beispiele = (Array.isArray(input.beispiele) ? input.beispiele : [])
    .filter(b => b && str(b.de) && str(b.ru))
    .slice(0, 3)
    .map(b => ({ de: str(b.de).slice(0, 200), ru: str(b.ru).slice(0, 200) }));

  return {
    key: wort,
    artikel,
    plural,
    genitiv: str(input.genitiv).slice(0, 80),
    bedeutung,
    niveau: str(input.niveau).slice(0, 4) || 'B1',
    beispiele
  };
}

function validatePhrases(input) {
  if (!Array.isArray(input)) return null;

  const list = input
    .filter(p => p && typeof p === 'object')
    .map(p => {
      const item = {
        id: str(p.id).slice(0, 40) || ('p' + Math.random().toString(36).slice(2, 10)),
        de: str(p.de).slice(0, 300),
        ru: str(p.ru).slice(0, 300),
        uk: str(p.uk).slice(0, 300)
      };
      return (item.de || item.ru || item.uk) ? item : null;
    })
    .filter(Boolean)
    .slice(0, 300);

  // Пустой список — это законное «удалить всё», но у него слишком высокая
  // цена случайного нажатия, поэтому его не принимаем.
  return list.length ? list : null;
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
