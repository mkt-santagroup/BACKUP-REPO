// Fetcher embutido pro server list do FiveM, batendo direto no endpoint
// oficial da CFX. Substitui a dependencia do wrapper externo
// (fivem-sl-api.onrender.com) que quebrou quando o FiveM moveu o endpoint de
//   servers-frontend.fivem.net  (agora bloqueado pelo Akamai Bot Manager)
// para
//   frontend.cfx-services.net   (o novo host, acessivel sem fingerprinting).
//
// Descoberto rodando Puppeteer e interceptando os requests da SPA oficial em
// servers.fivem.net.
//
// Logica: baixa o dump protobuf streamado, parseia frames (length-prefixed),
// decodifica via cfx-master.js (schema do wrapper Zuntie/fivem-serverlist-api)
// e cacheia o array em memoria por CACHE_TTL_MS.

const { master } = require('./cfx-master');

const STREAM_URL = 'https://frontend.cfx-services.net/api/servers/streamRedir/';
const CACHE_TTL_MS = 45_000;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.6',
  Origin: 'https://servers.fivem.net',
  Referer: 'https://servers.fivem.net/',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

let cache = { at: 0, servers: [] };
let inflight = null;

// Parseia frames length-prefixed (uint32 LE seguido do payload protobuf)
// a partir de um Uint8Array completo.
function parseFrames(buf, onFrame) {
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
    if (len <= 0 || len > 65535) {
      // frame invalido, aborta
      break;
    }
    if (pos + 4 + len > buf.length) break; // payload incompleto
    const frame = buf.subarray(pos + 4, pos + 4 + len);
    onFrame(frame);
    pos += 4 + len;
  }
}

async function fetchAllServers() {
  const res = await fetch(STREAM_URL, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} de ${STREAM_URL}`);

  const ab = await res.arrayBuffer();
  const buf = new Uint8Array(ab);

  const seen = new Map();
  parseFrames(buf, (frame) => {
    try {
      const srv = master.Server.decode(frame);
      if (srv.EndPoint && !seen.has(srv.EndPoint)) seen.set(srv.EndPoint, srv);
    } catch (_) {
      // frame inv  alido, ignora
    }
  });
  return [...seen.values()];
}

async function getAllServers() {
  const now = Date.now();
  if (cache.servers.length > 0 && now - cache.at < CACHE_TTL_MS) {
    return cache.servers;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const servers = await fetchAllServers();
      cache = { at: Date.now(), servers };
      return servers;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Normaliza locale: lowercase + troca "_" por "-". Servers cadastram inconsistente
// (es_ES, es-ES, es-es, ES_es, etc) - tudo isso colapsa pro mesmo "es-es".
function normLocale(s) {
  return String(s || '').toLowerCase().replace(/_/g, '-');
}

// Filtra por locale (insensitive a case e a separador). Mantem o shape compativel
// com o retorno antigo do fivem-sl-api: array de { Data: { vars, upvotePower, ... } }.
async function fetchServersByLocale(locale) {
  const all = await getAllServers();
  const target = normLocale(locale);
  return all.filter((s) => normLocale(s?.Data?.vars?.locale) === target);
}

module.exports = { fetchServersByLocale, getAllServers };
