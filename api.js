// API REST simples que expoe a listagem de servidores FiveM por pais.
// Bate direto no endpoint oficial novo (frontend.cfx-services.net) via cfx-fetcher
// (parser protobuf inline). Cache em memoria de 45s -> requests subsequentes
// sao instantaneas.
//
// Endpoints:
//   GET /countries         -> lista dos paises suportados
//   GET /:country          -> top servers do pais (BR, UK, PT, ES, US, FR, SA)
//   GET /:country?limit=N  -> custom limit (default 20)
//   GET /health            -> status

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cfxFetcher = require('./cfx-fetcher');
const { cleanCityName } = require('./clean-name');

const PORT = process.env.PORT || process.env.API_PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

if (!API_KEY) {
  console.error('[api] FATAL: API_KEY nao setado no .env');
  process.exit(1);
}

// Comparacao timing-safe pra evitar timing attacks
function safeKeyEquals(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function extractKey(req) {
  const h = req.get('X-API-Key');
  if (h) return h.trim();
  const auth = req.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  if (req.query.api_key) return String(req.query.api_key).trim();
  return '';
}

// Middleware: exige key em todos os endpoints exceto /health e /
function requireApiKey(req, res, next) {
  const provided = extractKey(req);
  if (!provided) {
    return res.status(401).json({
      error: 'missing_api_key',
      message: 'Passe a key em X-API-Key, Authorization: Bearer <key>, ou ?api_key=<key>',
    });
  }
  if (!safeKeyEquals(provided, API_KEY)) {
    return res.status(403).json({ error: 'invalid_api_key', message: 'API key invalida.' });
  }
  next();
}

const COUNTRIES = [
  { flag: '🇧🇷', label: 'BR', locale: 'pt-BR', extraLocales: ['pt-br'] },
  { flag: '🇬🇧', label: 'UK', locale: 'en-GB', extraLocales: ['en-UK', 'en-uk'] },
  { flag: '🇵🇹', label: 'PT', locale: 'pt-PT', extraLocales: ['pt-pt'] },
  { flag: '🇪🇸', label: 'ES', locale: 'es-ES', extraLocales: ['es-es'] },
  { flag: '🇺🇸', label: 'US', locale: 'en-US', extraLocales: ['en_US', 'en-us'] },
  { flag: '🇫🇷', label: 'FR', locale: 'fr-FR', extraLocales: ['fr-fr'] },
  { flag: '🇸🇦', label: 'SA', locale: 'ar-SA', extraLocales: ['ar-sa'] },
];

const COUNTRY_BY_LABEL = new Map(COUNTRIES.map((c) => [c.label.toUpperCase(), c]));

// Pega top servers do pais. Mescla todas as variantes de locale, deduplica por
// EndPoint (= "joinId" curto do FiveM), descarta boosts <= 0, filtra por jogo
// (FiveM/GTA5 por padrao), ordena por boost.
async function getTopByCountry(country, limit, gameFilter) {
  const allLocales = [country.locale, ...(country.extraLocales || [])];
  const buckets = await Promise.all(
    allLocales.map((loc) => cfxFetcher.fetchServersByLocale(loc)),
  );

  const byEndpoint = new Map();
  for (const list of buckets) {
    for (const s of list) {
      const ep = s?.EndPoint;
      if (!ep) continue;
      const boosts = s?.Data?.upvotePower || 0;
      if (boosts <= 0) continue; // filtra servers sem boost
      const game = (s?.Data?.vars?.gamename || '').toLowerCase();
      if (gameFilter !== 'all' && game !== gameFilter) continue; // filtra por jogo
      if (!byEndpoint.has(ep)) byEndpoint.set(ep, s);
    }
  }

  return [...byEndpoint.values()]
    .sort((a, b) => {
      // 1. boosts DESC (criterio primario)
      const ba = b.Data?.upvotePower || 0;
      const aa = a.Data?.upvotePower || 0;
      if (ba !== aa) return ba - aa;

      // 2. jogadores online DESC (empate -> server mais ativo ganha)
      const bp = b.Data?.clients || 0;
      const ap = a.Data?.clients || 0;
      if (bp !== ap) return bp - ap;

      // 3. ordem alfabetica do nome (garante estabilidade entre requisicoes)
      const an = a.Data?.vars?.sv_projectName || a.Data?.hostname || '';
      const bn = b.Data?.vars?.sv_projectName || b.Data?.hostname || '';
      return an.localeCompare(bn);
    })
    .slice(0, limit)
    .map((s, i) => ({
      rank: i + 1,
      name: cleanCityName(s.Data?.vars?.sv_projectName || s.Data?.hostname || ''),
      boosts: s.Data?.upvotePower || 0,
      players: s.Data?.clients || 0,
    }));
}

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/countries', requireApiKey, (req, res) => {
  res.json({
    count: COUNTRIES.length,
    countries: COUNTRIES.map((c) => ({
      label: c.label,
      flag: c.flag,
      primaryLocale: c.locale,
      locales: [c.locale, ...(c.extraLocales || [])],
    })),
  });
});

app.get('/:country', requireApiKey, async (req, res) => {
  const label = String(req.params.country || '').toUpperCase();
  const country = COUNTRY_BY_LABEL.get(label);
  if (!country) {
    return res.status(404).json({
      error: 'country_not_found',
      message: `Pais "${req.params.country}" nao suportado.`,
      supported: COUNTRIES.map((c) => c.label),
    });
  }

  let limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
  if (limit < 1) limit = 1;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // ?game= : gta5 (FiveM, default = bate com servers.fivem.net), rdr3 (RedM), all
  const gameFilter = String(req.query.game || 'gta5').toLowerCase();

  try {
    const servers = await getTopByCountry(country, limit, gameFilter);
    res.json({
      country: country.label,
      game: gameFilter,
      count: servers.length,
      updatedAt: new Date().toISOString(),
      servers,
    });
  } catch (err) {
    res.status(502).json({
      error: 'upstream_failed',
      message: err.message,
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'FiveM Server List API (SantaGroup)',
    version: '1.0.0',
    endpoints: {
      'GET /:country': 'top servers do pais (BR, UK, PT, ES, US, FR, SA)',
      'GET /:country?limit=N': 'idem com limite custom (1-200, default 20)',
      'GET /countries': 'lista paises suportados e seus locales',
      'GET /health': 'status check',
    },
    example: '/BR?limit=10',
  });
});

// Em ambientes tipo Railway, escutar em 0.0.0.0 (nao 127.0.0.1) eh
// obrigatorio pro proxy externo conseguir alcancar o app.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] Listening on 0.0.0.0:${PORT}`);
  console.log(`[api] (process.env.PORT=${process.env.PORT || '<nao setado>'})`);
  console.log(`[api] Try: curl http://localhost:${PORT}/BR`);
});
