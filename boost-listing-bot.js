require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cfxFetcher = require('./cfx-fetcher');
const { cleanCityName } = require('./clean-name');
const TOP_N = 20;
const MAX_NAME_LEN = 22; // truncamento p/ caber dentro do limite do embed
const EMBED_COLOR = 0x2b2d31; // cinza-escuro do tema do Discord
const ALERT_COLOR = 0xff3333; // vermelho p/ alertas de rush
// Diretorio onde os arquivos de estado sao gravados. No Railway, aponte
// DATA_DIR para o mount path do volume (ex: /data) p/ persistir entre deploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const MSG_ID_FILE = path.join(DATA_DIR, '.boost-message-id');
const POSICOES_MSG_FILE = path.join(DATA_DIR, '.posicoes-message-id');
const BOOSTS_DELTAS_MSG_FILE = path.join(DATA_DIR, '.boosts-deltas-message-id');
const RANKING_STATE_FILE = path.join(DATA_DIR, '.boost-rankings-state.json');
const MIN_SERVERS_THRESHOLD = 10; // abaixo disso, considera resposta incompleta e usa cache

// Limites do detector de rush no podio
const MIN_BOOSTS_FOR_RUSH_ALERT = 100;  // top 1 abaixo disso e ruido (cidade muito pequena)
const RUSH_DIFF_PERCENT = 0.30;         // alerta quando rusher esta a <= 30% de boost da nossa top 1
const RUSH_DIFF_CLOSE_MIN = 50;         // o rusher precisa ter fechado o gap em >= isso (debounce)
const LOSS_THRESHOLD = 100;             // perda minima para flagar uma cidade como "doadora"
const RUSH_DM_ROLE_ID = '1476932779123150959'; // cargo que recebe DM desesperada quando ha rush
const FETCH_ERROR_DM_ROLE_ID = '1494291006693310464'; // cargo que recebe DM quando o fetch falha
const FETCH_ERROR_COOLDOWN_MS = 15 * 60 * 1000; // nao spamma o mesmo erro: 15min entre DMs

const {
  DISCORD_BOT_TOKEN,
  BOOSTS_CHANNEL_ID,
  CHANGES_CHANNEL_ID,
  RUSH_CHANNEL_ID,
  POSICOES_CHANNEL_ID,
  BOOSTS_DELTAS_CHANNEL_ID,
  DAILY_LIST_CHANNEL_ID,
  LOG_CHANNEL_ID,
  ZAPI_BASE_URL,
  ZAPI_CLIENT_TOKEN,
  ZAPI_NOTIFICATION_NUMBERS,
  BOOSTS_LIST_CRON = '* * * * *',
  DAILY_LIST_CRON = '0 21 * * *',
  BACKUP_TIMEZONE = 'America/Sao_Paulo',
} = process.env;

const ZAPI_NUMBERS = (ZAPI_NOTIFICATION_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// cfx-fetcher ja normaliza case/separator (es_ES == es-es == ES-ES).
// extraLocales agora so pra ALIAS REAL (ex: en-UK <-> en-GB sao codigos diferentes).
const COUNTRIES = [
  { flag: '🇧🇷', label: 'BR', code: 'BR', locale: 'pt-BR' },
  { flag: '🇬🇧', label: 'UK', code: 'GB', locale: 'en-GB', extraLocales: ['en-UK'] },
  { flag: '🇵🇹', label: 'PT', code: 'PT', locale: 'pt-PT' },
  { flag: '🇪🇸', label: 'ES', code: 'ES', locale: 'es-ES' },
  { flag: '🇺🇸', label: 'US', code: 'US', locale: 'en-US' },
  { flag: '🇫🇷', label: 'FR', code: 'FR', locale: 'fr-FR' },
  { flag: '🇸🇦', label: 'SA', code: 'SA', locale: 'ar-SA' },
];

// Cidades do SantaGroup por pais (match parcial, case-insensitive).
// Vinculadas ao pais p/ evitar falso positivo entre regioes (ex: PRIME RP existe
// na ES e na FR, mas so a da ES eh nossa).
const SANTA_BY_COUNTRY = {
  BR: ['CIDADE NOBRE', 'CIDADE SANTA', 'CIDADE MARESIA', 'CIDADE GRANDE', 'FRONTEIRA'],
  UK: ['KNG ESTATE', 'BOOMERANG', 'ROYAL'],
  PT: ['MALTA RP'],
  ES: ['REAL RP', 'PRIME RP'],
  US: ['LIBERTY 99', 'DISTRICT 99', 'KROWN'],
  FR: ['GOAT'],
  SA: ['ORIZON'],
};

// ===== Logger: stdout sempre, + Discord se for erro =====
// Canal de logs de erro. Quando setado, qualquer log que tenha "Erro/erro/FALHOU/
// failed/❌/🚨/⚠️" eh agregado num buffer e enviado em batches pro Discord (a cada
// 3s ou no fim do processo). Debounce evita rate limit do Discord.
const ERROR_LOG_CHANNEL_ID =
  process.env.ERROR_LOG_CHANNEL_ID || '1518064632567304295';

// "🚨" intencionalmente fora daqui - eh usado em alertas normais de RUSH (que
// nao sao erros, sao notificacoes informativas).
const ERROR_PATTERNS = [
  /\bErro\b/i,
  /\bERRO\b/,
  /\bFALHOU\b/i,
  /\bfalhou\b/,
  /\bfailed\b/i,
  /❌/,
  /UNHANDLED|UNCAUGHT/,
];
function looksLikeError(msg) {
  return ERROR_PATTERNS.some((re) => re.test(msg));
}

let _discordClient = null;
const _errorBuffer = [];
let _flushTimer = null;

function setDiscordLogClient(client) {
  _discordClient = client;
}

function flushErrorBuffer() {
  _flushTimer = null;
  if (_errorBuffer.length === 0 || !_discordClient || !ERROR_LOG_CHANNEL_ID) return;
  const batch = _errorBuffer.splice(0, _errorBuffer.length);
  // 1900 chars pra caber dentro do limite de msg do Discord (2000) + envelope
  const body = batch.join('\n').slice(0, 1900);
  const content = '🔴 **Erros recentes:**\n```\n' + body + '\n```';
  _discordClient.channels
    .fetch(ERROR_LOG_CHANNEL_ID)
    .then((ch) => ch && ch.send({ content }))
    .catch((e) => console.error(`[error-log] falha ao enviar: ${e.message}`));
}

function log(msg) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${now}] ${msg}`;
  console.log(line);
  if (_discordClient && looksLikeError(msg)) {
    _errorBuffer.push(line);
    if (!_flushTimer) _flushTimer = setTimeout(flushErrorBuffer, 3000);
  }
}

// Captura rejeicoes/excecoes nao tratadas globalmente -> vai pro Discord tambem
process.on('unhandledRejection', (err) => {
  log(`UNHANDLED REJECTION: ${(err && err.stack) || err}`);
});
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${(err && err.stack) || err}`);
});

// Match com word boundary pra evitar falso positivo (ex: "Horizon RP" contem
// a substring "orizon" mas NAO eh a nossa cidade "Orizon").
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isOurCity(name, countryLabel) {
  const list = SANTA_BY_COUNTRY[countryLabel] || [];
  if (!list.length) return false;
  const lower = name.toLowerCase();
  return list.some((c) => {
    const re = new RegExp(`\\b${escapeRegex(c.toLowerCase())}\\b`);
    return re.test(lower);
  });
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

async function fetchByLocale(locale) {
  // Antes batia em fivem-sl-api.onrender.com (wrapper externo que parou de funcionar
  // quando o FiveM moveu o endpoint de servers-frontend.fivem.net pra
  // frontend.cfx-services.net). Agora puxa direto da API oficial nova via
  // cfx-fetcher (FrameReader + protobuf inline). Cache em memoria de 45s.
  const data = await cfxFetcher.fetchServersByLocale(locale);
  if (!Array.isArray(data)) return [];

  return data
    .map((srv) => {
      const d = srv.Data || {};
      const v = d.vars || {};
      return {
        city: cleanCityName(v.sv_projectName || d.hostname || ''),
        boosts: d.upvotePower || 0,
      };
    })
    .filter((s) => s.city)
    .sort((a, b) => {
      // Sort estavel: desempate alfabetico quando boosts sao iguais
      // (evita oscilacao de posicao entre cidades empatadas)
      if (b.boosts !== a.boosts) return b.boosts - a.boosts;
      return a.city.localeCompare(b.city);
    })
    .slice(0, TOP_N);
}

function formatList(ranking, countryLabel) {
  const lines = ranking.map((srv, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const marker = isOurCity(srv.city, countryLabel) ? '🟡 ' : '';
    const name = truncate(srv.city, MAX_NAME_LEN);
    return `${num}. ${marker}${name} - ${srv.boosts} Boosts`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

function buildEmbed(rankingByCountry) {
  const embed = new EmbedBuilder()
    .setTitle('🚀 LISTAGEM DE BOOSTS')
    .setColor(EMBED_COLOR);

  for (const c of COUNTRIES) {
    const ranking = rankingByCountry[c.label] || [];
    embed.addFields({
      name: `${c.flag} Servidores ${c.label}:`,
      value: formatList(ranking, c.label),
      inline: false,
    });
  }

  const now = new Date().toLocaleString('pt-BR', {
    timeZone: BACKUP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
  embed.setFooter({ text: `Atualizado hoje as ${now}` });

  return embed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Faz fetch, e se vier abaixo do threshold, tenta de novo apos um pequeno delay
async function fetchByLocaleResilient(locale, label) {
  let result = [];
  try {
    result = await fetchByLocale(locale);
  } catch (err) {
    log(`  Erro 1a tentativa ${label}: ${err.message}`);
  }
  if (result.length < MIN_SERVERS_THRESHOLD) {
    await sleep(2000);
    try {
      const retry = await fetchByLocale(locale);
      if (retry.length > result.length) result = retry;
    } catch (err) {
      log(`  Erro retry ${label}: ${err.message}`);
    }
  }
  return result;
}

// Mergeia duas listas [{city,boosts}], dedupando por nome (case-insensitive).
// Mantem o maior boost quando houver duplicata. Retorna top TOP_N ordenado.
function mergeRankings(a, b) {
  const map = new Map();
  for (const s of [...a, ...b]) {
    const key = s.city.toLowerCase();
    const existing = map.get(key);
    if (!existing || s.boosts > existing.boosts) {
      map.set(key, s);
    }
  }
  return [...map.values()]
    .sort((x, y) => {
      if (y.boosts !== x.boosts) return y.boosts - x.boosts;
      return x.city.localeCompare(y.city);
    })
    .slice(0, TOP_N);
}

// Resultado do ultimo fetchAllRankings: lista de paises que falharam.
// Lido pelo updateListing pra disparar DM ao cargo de fetch error.
let lastFetchFailures = [];

async function fetchAllRankings() {
  const rankings = {};
  const failures = [];

  for (const c of COUNTRIES) {
    let fresh = await fetchByLocaleResilient(c.locale, c.label);

    // Busca locales extras e merge (ex: UK busca en-GB + en-UK)
    for (const extra of c.extraLocales || []) {
      const extraResult = await fetchByLocaleResilient(extra, `${c.label}/${extra}`);
      if (extraResult.length > 0) {
        fresh = mergeRankings(fresh, extraResult);
        log(`    + ${c.label} mergeou ${extraResult.length} servers de ${extra}`);
      }
    }

    rankings[c.label] = fresh;

    if (fresh.length >= MIN_SERVERS_THRESHOLD) {
      log(`  ${c.flag} ${c.label} (${c.locale}): ${fresh.length} servers`);
    } else {
      log(`  ❌ ${c.flag} ${c.label} (${c.locale}): FALHOU (${fresh.length} servers retornados)`);
      failures.push({ country: c, freshCount: fresh.length });
    }
  }

  lastFetchFailures = failures;
  return rankings;
}

// Throttle por categoria (kind+labels). Evita mandar a mesma DM toda hora
// enquanto o problema persiste. Reseta quando o conjunto de falhas muda.
let lastFetchErrorKey = '';
let lastFetchErrorAt = 0;

async function notifyFetchFailures(client, failures) {
  if (!failures || failures.length === 0) return;
  if (!FETCH_ERROR_DM_ROLE_ID) return;

  const key = failures.map((f) => `${f.country.label}:${f.kind}`).sort().join('|');
  const now = Date.now();
  if (key === lastFetchErrorKey && now - lastFetchErrorAt < FETCH_ERROR_COOLDOWN_MS) {
    return; // mesmo conjunto de erros recente, nao spamma
  }
  lastFetchErrorKey = key;
  lastFetchErrorAt = now;

  const nowStr = new Date().toLocaleString('pt-BR', {
    timeZone: BACKUP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });

  const lines = failures.map(
    (f) =>
      `${f.country.flag} ${f.country.label} (${f.country.locale}) — retornou ${f.freshCount} servers`,
  );

  const allBroken = failures.length === COUNTRIES.length;
  const title = allBroken
    ? '🚨 BOT DE BOOSTS: API CAIU TOTALMENTE'
    : '⚠️ BOT DE BOOSTS: falha parcial na API';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(ALERT_COLOR)
    .setDescription(
      `Falhou ao puxar **${failures.length}/${COUNTRIES.length}** paises as ${nowStr}.\n\n` +
        '```\n' + lines.join('\n') + '\n```' +
        '\n_Vou tentar de novo no proximo tick. So volto a avisar daqui a ' +
        `${Math.round(FETCH_ERROR_COOLDOWN_MS / 60000)} min se persistir._`,
    );

  try {
    const { sent, failed } = await dmRoleMembers(
      client,
      FETCH_ERROR_DM_ROLE_ID,
      { embeds: [embed] },
    );
    log(`  📩 Alerta de fetch enviado: ${sent} DMs, ${failed} falhas`);
  } catch (err) {
    log(`  Erro ao enviar alerta de fetch: ${err.message}`);
  }
}

// ===== Detector de alteracoes de ranking =====

function loadRankingState() {
  if (!fs.existsSync(RANKING_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(RANKING_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveRankingState(state) {
  fs.writeFileSync(RANKING_STATE_FILE, JSON.stringify(state, null, 2));
}

// Converte [{city,boosts},...] em { cityName: { pos, boosts } }
function rankingToMap(ranking) {
  const m = {};
  ranking.forEach((srv, i) => {
    if (srv.city) m[srv.city] = { pos: i + 1, boosts: srv.boosts };
  });
  return m;
}

// Helpers para ler state em formato novo ou antigo (compat retro)
function getPos(info) {
  if (info == null) return null;
  return typeof info === 'object' ? info.pos : info;
}
function getBoosts(info) {
  if (info == null) return 0;
  return typeof info === 'object' ? info.boosts || 0 : 0;
}

function formatDelta(delta) {
  if (delta === 0) return '';
  return delta > 0 ? ` (+${delta})` : ` (${delta})`;
}

// ===== Helpers para mensagens estilo Python =====

// Extrai nome curto pra ID curto na mensagem do WhatsApp.
// "🟡 CIDADE NOBRE" -> "NOBRE", "BOOMERANG" -> "BOOMERANG", "MALTA RP" -> "MALTA"
function shortName(fullName) {
  const noEmoji = fullName.replace(/🟡\s*/g, '').trim();
  if (/^CIDADE\s/i.test(noEmoji)) return noEmoji.split(/\s+/)[1] || noEmoji;
  return noEmoji.split(/\s+/)[0];
}

// Procura cidade santa no ranking atual (substring case-insensitive)
function findSantaCity(santaPattern, ranking) {
  const p = santaPattern.toLowerCase();
  return ranking.find((s) => s.city.toLowerCase().includes(p));
}

// Helper generico: edita a mensagem do bot no canal se ja existir,
// senao envia uma nova e grava o ID no arquivo.
async function editOrSendEmbed(client, channelId, msgIdFile, embed, label) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`Canal ${channelId} (${label}) nao encontrado`);

  const savedId = fs.existsSync(msgIdFile)
    ? fs.readFileSync(msgIdFile, 'utf8').trim()
    : null;

  if (savedId) {
    try {
      const msg = await channel.messages.fetch(savedId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch {
      log(`Msg antiga em ${label} nao encontrada, criando nova...`);
    }
  }
  const msg = await channel.send({ embeds: [embed] });
  fs.writeFileSync(msgIdFile, msg.id);
}

// ===== Embed LISTAGEM DE POSIÇÕES (estilo Python) =====

function buildPositionsEmbed(rankings, previous) {
  const embed = new EmbedBuilder()
    .setTitle('🌐 LISTAGEM DE POSIÇÕES')
    .setColor(0x00b0f4)
    .setFooter({ text: 'Atualizado a cada 1 minuto' })
    .setTimestamp(new Date());

  for (const c of COUNTRIES) {
    const santas = SANTA_BY_COUNTRY[c.label] || [];
    if (!santas.length) continue;

    const ranking = rankings[c.label] || [];
    const oldMap = (previous && previous[c.label]) || {};

    const lines = [];
    for (const pattern of santas) {
      const found = findSantaCity(pattern, ranking);
      if (!found) {
        lines.push(`${pattern} → ⚠️ fora do top 20`);
        continue;
      }
      const cityName = found.city;
      const newPos = ranking.indexOf(found) + 1;
      const oldInfo = oldMap[cityName];
      const oldPos = oldInfo ? getPos(oldInfo) : null;

      if (oldPos === null) {
        lines.push(`${cityName} → ⏸ posição ${newPos}`);
      } else if (oldPos === newPos) {
        lines.push(`${cityName} → ⏸ (${oldPos} → ${newPos}) sem alteração`);
      } else if (newPos < oldPos) {
        const diff = oldPos - newPos;
        lines.push(`${cityName} → ⬆ (${oldPos} → ${newPos}) +${diff} posições`);
      } else {
        const diff = oldPos - newPos;
        lines.push(`${cityName} → ⬇ (${oldPos} → ${newPos}) ${diff} posições`);
      }
    }

    if (lines.length === 0) continue;
    embed.addFields({
      name: `**${c.flag} ${c.label}**`,
      value: '```\n' + lines.join('\n') + '\n```',
      inline: false,
    });
  }
  return embed;
}

// ===== Embed LISTAGEM DE BOOSTS (deltas, estilo Python) =====

function buildBoostsDeltasEmbed(rankings, previous) {
  const embed = new EmbedBuilder()
    .setTitle('🚀 LISTAGEM DE BOOSTS')
    .setColor(0xf4a200)
    .setFooter({ text: 'Atualizado a cada 1 minuto' })
    .setTimestamp(new Date());

  for (const c of COUNTRIES) {
    const santas = SANTA_BY_COUNTRY[c.label] || [];
    if (!santas.length) continue;

    const ranking = rankings[c.label] || [];
    const oldMap = (previous && previous[c.label]) || {};

    const lines = [];
    for (const pattern of santas) {
      const found = findSantaCity(pattern, ranking);
      if (!found) {
        lines.push(`${pattern} → ⚠️ fora do top 20`);
        continue;
      }
      const cityName = found.city;
      const newBoosts = found.boosts || 0;
      const oldInfo = oldMap[cityName];
      const oldBoosts = oldInfo ? getBoosts(oldInfo) : 0;

      if (oldBoosts === 0) {
        lines.push(`${cityName} → ⏸ ${newBoosts} boosts`);
      } else if (newBoosts === oldBoosts) {
        lines.push(`${cityName} → ⏸ (${oldBoosts} → ${newBoosts}) sem alteração`);
      } else if (newBoosts > oldBoosts) {
        const diff = newBoosts - oldBoosts;
        lines.push(`${cityName} → 📈 (${oldBoosts} → ${newBoosts}) +${diff} boosts`);
      } else {
        const diff = newBoosts - oldBoosts;
        lines.push(`${cityName} → 📉 (${oldBoosts} → ${newBoosts}) ${diff} boosts`);
      }
    }

    if (lines.length === 0) continue;
    embed.addFields({
      name: `**${c.flag} ${c.label}**`,
      value: '```\n' + lines.join('\n') + '\n```',
      inline: false,
    });
  }
  return embed;
}

// ===== Mensagem WhatsApp Z-API (estilo Python) =====

// Monta texto agrupando as linhas por cidade santa (igual o Python faz)
function buildZapiMessage(changes, hora) {
  // changes = [{ city, country, oldPos, newPos, oldBoosts, newBoosts }]
  let msg = `🕒 ${hora}\n`;
  // Agrupa por servidor_id
  const byCity = new Map();
  for (const ch of changes) {
    const short = shortName(ch.city);
    const id = `${ch.flag} ${short}`;
    if (!byCity.has(id)) byCity.set(id, []);

    if (ch.oldPos !== ch.newPos) {
      const icon = ch.newPos < ch.oldPos ? '⬆' : '⬇';
      const act = ch.newPos < ch.oldPos ? 'subiu' : 'desceu';
      byCity.get(id).push(`${icon} ${id}: ${act} posição (${ch.oldPos} → ${ch.newPos})`);
    }
    if (ch.newBoosts !== ch.oldBoosts) {
      const icon = ch.newBoosts > ch.oldBoosts ? '📈' : '📉';
      const diff = ch.newBoosts - ch.oldBoosts;
      const sign = diff > 0 ? `+${diff}` : `${diff}`;
      byCity.get(id).push(`${icon} ${id}: ${sign} boosts (${ch.oldBoosts} → ${ch.newBoosts})`);
    }
  }
  for (const lines of byCity.values()) {
    msg += '\n' + lines.join('\n') + '\n';
  }
  return msg.trim();
}

async function sendZapiNotification(message) {
  if (!ZAPI_BASE_URL || !ZAPI_CLIENT_TOKEN || !ZAPI_NUMBERS.length) return;
  if (!message.trim()) return;

  for (const phone of ZAPI_NUMBERS) {
    try {
      await axios.post(
        `${ZAPI_BASE_URL.replace(/\/$/, '')}/send-text`,
        { phone, message },
        {
          headers: {
            'Content-Type': 'application/json',
            'client-token': ZAPI_CLIENT_TOKEN,
          },
          timeout: 10000,
        },
      );
      log(`  WhatsApp enviado para ${phone}`);
    } catch (err) {
      log(`  Erro WhatsApp ${phone}: ${err.message}`);
    }
    await sleep(500);
  }
}

// Subset-sum: retorna um subconjunto de `items` cuja soma de items[i].lost == target,
// ou null se nao existe combinacao exata. Prefere subconjuntos menores (menos doadores).
// Funciona bem para ate ~20 candidatos (2^20 = 1M iteracoes).
function findExactSubset(items, target) {
  if (target <= 0 || items.length === 0) return null;
  if (items.length > 22) return null; // limite de seguranca

  const n = items.length;
  // Ordena descendente por valor (poda mais cedo casos sem solucao)
  const sorted = [...items].sort((a, b) => b.lost - a.lost);

  let best = null;
  let bestSize = Infinity;

  // Itera todos os subconjuntos
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        sum += sorted[i].lost;
        count++;
        if (sum > target) break; // sem chance, ja passou
      }
    }
    if (sum === target && count < bestSize) {
      best = sorted.filter((_, i) => mask & (1 << i));
      bestSize = count;
      if (bestSize === 1) return best; // menor possivel
    }
  }
  return best;
}

async function detectAndPostChanges(client, rankings, previous) {
  const currentState = {};
  for (const c of COUNTRIES) {
    currentState[c.label] = rankingToMap(rankings[c.label] || []);
  }

  if (!previous) {
    saveRankingState(currentState);
    log('Snapshot inicial de rankings salvo (sem comparacao na 1a vez).');
    return { positionChanges: 0, rushAlerts: 0 };
  }

  const now = new Date().toLocaleString('pt-BR', {
    timeZone: BACKUP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });

  // === 1. Alteracoes de posicao -> CHANGES_CHANNEL_ID + agrega p/ WhatsApp ===
  const allSantaChanges = []; // pra notificacao WhatsApp agregada
  let positionChanges = 0;

  if (CHANGES_CHANNEL_ID) {
    const channel = await client.channels.fetch(CHANGES_CHANNEL_ID);
    if (!channel) {
      log(`Canal de alteracoes ${CHANGES_CHANNEL_ID} nao encontrado.`);
    } else {
      let totalChanges = 0;

      for (const c of COUNTRIES) {
        const santas = SANTA_BY_COUNTRY[c.label] || [];
        if (!santas.length) continue;

        const oldMap = previous[c.label] || {};
        const newMap = currentState[c.label] || {};

        // Monitora APENAS cidades santa (qualquer posicao). Cidades nao-santa
        // sao ignoradas aqui - o canal de alteracoes nao deve fazer ruido com elas.
        const tracked = new Set();
        for (const city of Object.keys(oldMap)) {
          if (isOurCity(city, c.label)) tracked.add(city);
        }
        for (const city of Object.keys(newMap)) {
          if (isOurCity(city, c.label)) tracked.add(city);
        }

        const changes = [];
        for (const city of tracked) {
          const oldInfo = oldMap[city];
          const newInfo = newMap[city];
          if (!oldInfo || !newInfo) continue;
          const oldPos = getPos(oldInfo);
          const newPos = getPos(newInfo);
          if (oldPos === newPos) continue;

          const newBoosts = getBoosts(newInfo);
          const oldBoosts = getBoosts(oldInfo);
          const boostDelta = newBoosts - oldBoosts;

          changes.push({
            city,
            oldPos,
            newPos,
            newBoosts,
            oldBoosts,
            boostDelta,
            santa: isOurCity(city, c.label),
          });

          // Agrega para WhatsApp (com flag do pais)
          allSantaChanges.push({
            city,
            flag: c.flag,
            code: c.code,
            oldPos,
            newPos,
            oldBoosts,
            newBoosts,
          });
        }

        if (changes.length === 0) continue;

        changes.sort((a, b) => {
          if (a.santa !== b.santa) return a.santa ? -1 : 1;
          return Math.abs(b.newPos - b.oldPos) - Math.abs(a.newPos - a.oldPos);
        });

        const lines = changes.map(({ city, oldPos, newPos, newBoosts, boostDelta, santa }) => {
          const arrow = newPos < oldPos ? '↑' : '↓';
          const action = newPos < oldPos ? 'subiu' : 'desceu';
          const marker = santa ? '🟡 ' : '';
          const name = truncate(city, MAX_NAME_LEN);
          return `${arrow} ${marker}${c.code} ${name}: ${action} posicao (${oldPos} → ${newPos}) | ${newBoosts} boosts${formatDelta(boostDelta)}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('📊 ALTERAÇÕES DE POSIÇÃO')
          .setColor(EMBED_COLOR)
          .setDescription(`${c.flag} **${c.label}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``)
          .setFooter({ text: `Atualizado hoje as ${now}` });

        await channel.send({ embeds: [embed] });
        log(`  Alteracoes ${c.label}: ${changes.length} (postadas)`);
        totalChanges += changes.length;

        // DM identico do embed pro cargo de boost
        try {
          const { sent, failed } = await dmRoleMembers(
            client,
            RUSH_DM_ROLE_ID,
            { embeds: [embed] },
          );
          log(`  📩 DM alteracao ${c.label}: ${sent} enviadas, ${failed} falhas`);
        } catch (err) {
          log(`  Erro DM alteracao ${c.label}: ${err.message}`);
        }
      }

      if (totalChanges === 0) log('Nenhuma alteracao de posicao desde o ultimo snapshot.');
      positionChanges = totalChanges;
    }
  }

  // === 2. Detector de "alguem ultrapassou nossa santa" -> CHANGES + DM ===
  // Mais critico que rush porque ja aconteceu - nao eh ameaca, eh perda.
  if (CHANGES_CHANNEL_ID) {
    try {
      await detectAndPostPasses(client, previous, currentState, now);
    } catch (err) {
      log(`Erro ao detectar ultrapassagens: ${err.message}`);
    }
  }

  // === 3. Alertas de RUSH no podio -> RUSH_CHANNEL_ID ===
  let rushAlerts = 0;
  if (RUSH_CHANNEL_ID) {
    rushAlerts = await detectRushers(client, rankings, previous, now);
  }

  // === 3. Notificacao WhatsApp Z-API (formato igual ao bot Python) ===
  if (allSantaChanges.length > 0 && ZAPI_BASE_URL) {
    try {
      const zapiMsg = buildZapiMessage(allSantaChanges, now);
      await sendZapiNotification(zapiMsg);
    } catch (err) {
      log(`Erro ao enviar notificacao WhatsApp: ${err.message}`);
    }
  }

  saveRankingState(currentState);
  return { positionChanges, rushAlerts };
}

// Detecta cidades nao-santa que ultrapassaram alguma das nossas santa desde o
// snapshot anterior. Por cada par (santa, passer), gera 1 embed alerta e envia
// pro CHANGES_CHANNEL_ID + DM identica pro RUSH_DM_ROLE_ID.
async function detectAndPostPasses(client, previous, currentState, now) {
  if (!previous) return;
  const channel = await client.channels.fetch(CHANGES_CHANNEL_ID);
  if (!channel) return;

  for (const c of COUNTRIES) {
    if (!(SANTA_BY_COUNTRY[c.label] || []).length) continue;
    const oldMap = previous[c.label] || {};
    const newMap = currentState[c.label] || {};

    // Para cada santa no ranking novo
    for (const [santaName, santaNewInfo] of Object.entries(newMap)) {
      if (!isOurCity(santaName, c.label)) continue;
      const santaNewPos = getPos(santaNewInfo);
      const santaOldInfo = oldMap[santaName];
      if (!santaOldInfo) continue; // sem snapshot anterior pra comparar
      const santaOldPos = getPos(santaOldInfo);

      // Procura cidades nao-santa que estao ACIMA da santa agora
      for (const [otherName, otherNewInfo] of Object.entries(newMap)) {
        if (otherName === santaName) continue;
        if (isOurCity(otherName, c.label)) continue;
        const otherNewPos = getPos(otherNewInfo);
        if (otherNewPos >= santaNewPos) continue; // nao esta acima

        // Era abaixo (ou ausente do top 20) no snapshot anterior?
        const otherOldInfo = oldMap[otherName];
        const otherOldPos = otherOldInfo ? getPos(otherOldInfo) : null;
        const wasBelow =
          otherOldPos === null /* fora do top 20 */ ||
          otherOldPos > santaOldPos /* estava abaixo */;
        if (!wasBelow) continue; // nao houve ultrapassagem real

        // CONFIRMADO: nao-santa ultrapassou a santa
        const santaBoosts = getBoosts(santaNewInfo);
        const passerBoosts = getBoosts(otherNewInfo);
        const fromTxt =
          otherOldPos === null ? 'fora do top 20' : `top ${otherOldPos}`;

        const embed = new EmbedBuilder()
          .setTitle('🔥 NOS ULTRAPASSARAM 🔥')
          .setColor(ALERT_COLOR)
          .setDescription(
            `${c.flag} **${c.label}** — perdemos posicao pra uma cidade nao-santa!`,
          )
          .addFields(
            {
              name: '🟡 Nossa cidade',
              value:
                '```\n' +
                `${c.code} ${truncate(santaName, MAX_NAME_LEN)}: ${santaBoosts} boosts` +
                ` (top ${santaOldPos} → top ${santaNewPos})` +
                '\n```',
              inline: false,
            },
            {
              name: '⚠️ Quem nos passou',
              value:
                '```\n' +
                `${c.code} ${truncate(otherName, MAX_NAME_LEN)}: ${passerBoosts} boosts` +
                ` (${fromTxt} → top ${otherNewPos})` +
                '\n```',
              inline: false,
            },
          )
          .setFooter({ text: `Alerta gerado as ${now}` });

        await channel.send({ embeds: [embed] });
        log(`  🔥 PASSE ${c.label}: ${otherName} passou ${santaName}`);

        // DM identica pro cargo de boost
        try {
          const { sent, failed } = await dmRoleMembers(
            client,
            RUSH_DM_ROLE_ID,
            { embeds: [embed] },
          );
          log(`  📩 DM passe ${c.label}: ${sent} enviadas, ${failed} falhas`);
        } catch (err) {
          log(`  Erro DM passe ${c.label}: ${err.message}`);
        }
      }
    }
  }
}

async function detectRushers(client, rankings, previous, now) {
  const channel = await client.channels.fetch(RUSH_CHANNEL_ID);
  if (!channel) {
    log(`Canal de rush ${RUSH_CHANNEL_ID} nao encontrado.`);
    return 0;
  }

  let rushAlertCount = 0;
  for (const c of COUNTRIES) {
    const santas = SANTA_BY_COUNTRY[c.label] || [];
    if (!santas.length) continue;

    const ranking = rankings[c.label] || [];
    if (ranking.length === 0) continue;

    const top1 = ranking[0];
    // So gera alerta se NOSSA cidade for top 1 do pais
    if (!isOurCity(top1.city, c.label)) continue;

    // Cidades pequenas (< 1k boosts) nao entram no monitoramento de rush -
    // a "janela de 1k boosts" nao faz sentido pra elas. Ficam so com os
    // alertas padrao de alteracao de posicao.
    if (top1.boosts < MIN_BOOSTS_FOR_RUSH_ALERT) continue;

    const oldMap = previous[c.label] || {};
    const prevTop1Boosts = getBoosts(oldMap[top1.city]) || top1.boosts;

    // Detecta rushers: cidades nao-santa em top 20 que estao a <= RUSH_DIFF_PERCENT
    // (gap em % da nossa top 1) e que fecharam o gap em >= RUSH_DIFF_CLOSE_MIN
    // desde o snapshot anterior
    const rushers = [];
    for (let i = 1; i < ranking.length; i++) {
      const srv = ranking[i];
      if (isOurCity(srv.city, c.label)) continue;

      const currentDiff = top1.boosts - srv.boosts;
      const gapPct = currentDiff / top1.boosts; // 0 = empatado, 1 = rusher zerou
      if (gapPct > RUSH_DIFF_PERCENT) break; // ranking sorted; nada mais perto

      const prevRusherBoosts = getBoosts(oldMap[srv.city]);
      const prevDiff = prevTop1Boosts - prevRusherBoosts;
      const diffClosed = prevDiff - currentDiff;
      const rusherGain = srv.boosts - prevRusherBoosts;

      if (diffClosed < RUSH_DIFF_CLOSE_MIN) continue;

      rushers.push({
        city: srv.city,
        pos: i + 1,
        boosts: srv.boosts,
        gain: rusherGain,
        diff: currentDiff,
        gapPct,
        diffClosed,
      });
    }

    if (rushers.length === 0) continue;

    // Coleta TODAS as cidades que perderam boost no top 20 (sem threshold ainda)
    const allLosers = [];
    for (const srv of ranking) {
      const prevBoosts = getBoosts(oldMap[srv.city]);
      if (!prevBoosts) continue;
      const lost = prevBoosts - srv.boosts;
      if (lost > 0) {
        allLosers.push({ city: srv.city, boosts: srv.boosts, lost });
      }
    }

    // Transferencia de boost no FiveM eh EXATA: total ganho pelos rushers =
    // total perdido pelos doadores. Encontra o subconjunto exato dos candidatos.
    const totalGain = rushers.reduce((s, r) => s + r.gain, 0);
    const losers = findExactSubset(allLosers, totalGain) || [];

    const top1Delta = top1.boosts - prevTop1Boosts;
    const ourLine =
      `${c.code} ${truncate(top1.city, MAX_NAME_LEN)}: ${top1.boosts} boosts${formatDelta(top1Delta)}`;

    const rusherLines = rushers.map((r) => {
      const name = truncate(r.city, MAX_NAME_LEN);
      const pct = (r.gapPct * 100).toFixed(1);
      return `${c.code} ${name}: ${r.pos}o, ${r.boosts} boosts${formatDelta(r.gain)} | gap ${r.diff} (${pct}%)`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🚨 ALERTA DE RUSH NO PODIO 🚨')
      .setColor(ALERT_COLOR)
      .setDescription(`${c.flag} **${c.label}** — nossa cidade no topo esta sob ataque!`)
      .addFields(
        {
          name: '🟡 Nossa cidade (top 1)',
          value: '```\n' + ourLine + '\n```',
          inline: false,
        },
        {
          name: '⚠️ Rushando',
          value: '```\n' + rusherLines.join('\n') + '\n```',
          inline: false,
        },
      );

    if (losers.length > 0) {
      const loserLines = losers.map(
        (l) => `${c.code} ${truncate(l.city, MAX_NAME_LEN)}: ${l.boosts} boosts (-${l.lost})`,
      );
      const totalLoss = losers.reduce((s, l) => s + l.lost, 0);
      embed.addFields({
        name: `📉 Doadores identificados (transferencia exata de ${totalLoss} boosts)`,
        value: '```\n' + loserLines.join('\n') + '\n```',
        inline: false,
      });
    } else {
      embed.addFields({
        name: '📉 Doadores',
        value: 'Nenhum doador identificado dentro do top 20 (boosts vieram de fora).',
        inline: false,
      });
    }

    embed.setFooter({ text: `Alerta gerado as ${now}` });

    await channel.send({ embeds: [embed] });
    log(`  🚨 RUSH ${c.label}: ${rushers.length} rusher(s), ${losers.length} doador(es)`);
    rushAlertCount++;

    // DM com o MESMO embed que foi pro canal (identico)
    try {
      const { sent, failed } = await dmRoleMembers(client, RUSH_DM_ROLE_ID, { embeds: [embed] });
      log(`  📩 DM rush enviada para ${sent} membros (${failed} falhas)`);
    } catch (err) {
      log(`  Erro ao enviar DMs de rush: ${err.message}`);
    }
  }
  return rushAlertCount;
}

// Cache de fetch de membros por guild. Evita spammar opcode 8 (REQUEST_GUILD_MEMBERS)
// no gateway - Discord limita pesado (3 requests por 60s mais ou menos).
// Como o bot tem GuildMembers intent, novos membros entram no cache via eventos
// (GUILD_MEMBER_ADD) automaticamente; so precisamos do fetch inicial.
const _membersFetchedAt = new Map(); // guildId -> timestamp ms
const MEMBERS_FETCH_TTL = 10 * 60 * 1000; // 10 min entre fetches do mesmo guild

async function ensureMembersLoaded(guild) {
  const last = _membersFetchedAt.get(guild.id) || 0;
  if (Date.now() - last < MEMBERS_FETCH_TTL) return true; // cache valido
  try {
    await guild.members.fetch();
    _membersFetchedAt.set(guild.id, Date.now());
    return true;
  } catch (err) {
    // Se falhou por rate limit mas o cache previo existe, segue usando ele
    if (guild.members.cache.size > 0) {
      log(`  [DM] Fetch falhou (${err.message}) mas guild ja tem ${guild.members.cache.size} membros em cache, usando o que tem.`);
      // Marca como "recente" pra nao retentar imediato e pegar mais rate limit
      _membersFetchedAt.set(guild.id, Date.now());
      return true;
    }
    log(`  [DM] Erro ao listar membros do guild ${guild.id}: ${err.message}`);
    return false;
  }
}

async function dmRoleMembers(client, roleId, payload) {
  let sent = 0;
  let failed = 0;
  const guilds = [...client.guilds.cache.values()];

  for (const guild of guilds) {
    let role;
    try {
      role = await guild.roles.fetch(roleId);
    } catch (err) {
      continue;
    }
    if (!role) continue;

    // Garante membros carregados (com cache de 10min pra nao bater rate limit)
    const ok = await ensureMembersLoaded(guild);
    if (!ok) continue;

    const members = [...role.members.values()];
    if (members.length === 0) {
      log(`  [DM] Ninguem tem o cargo ${roleId} em ${guild.name}.`);
      return { sent, failed };
    }

    for (const member of members) {
      if (member.user.bot) continue;
      try {
        await member.send(payload);
        sent++;
      } catch (err) {
        failed++;
        log(`  [DM] Falhou p/ ${member.user.tag}: ${err.message}`);
      }
      await sleep(300); // evita rate-limit de HTTP /channels (envio de msg)
    }
    return { sent, failed }; // achou o role neste guild, nao precisa olhar os outros
  }
  return { sent, failed };
}

async function postDailyList(client) {
  log('Postando listagem diaria...');
  const rankings = await fetchAllRankings();
  const embed = buildEmbed(rankings);
  const payload = { embeds: [embed] };

  const channel = await client.channels.fetch(DAILY_LIST_CHANNEL_ID);
  if (!channel) {
    throw new Error(`Canal daily list ${DAILY_LIST_CHANNEL_ID} nao encontrado`);
  }
  await channel.send(payload);
  log(`Listagem diaria postada em ${DAILY_LIST_CHANNEL_ID}.`);

  // Mesmo embed por DM pra quem tem o cargo de boost
  try {
    const { sent, failed } = await dmRoleMembers(client, RUSH_DM_ROLE_ID, payload);
    log(`  📩 Daily list por DM: ${sent} enviadas, ${failed} falhas`);
  } catch (err) {
    log(`  Erro nas DMs da daily list: ${err.message}`);
  }
}

async function updateListing(client) {
  log('Buscando rankings dos paises...');
  const rankings = await fetchAllRankings();
  const previous = loadRankingState(); // carrega 1x e reutiliza

  // Se algum pais falhou, DM o cargo de alerta (com throttle pra nao spammar)
  if (lastFetchFailures.length > 0) {
    try {
      await notifyFetchFailures(client, lastFetchFailures);
    } catch (err) {
      log(`Erro ao notificar fetch failures: ${err.message}`);
    }
  }

  // 1. Listagem principal (top 20 de cada pais)
  try {
    await editOrSendEmbed(
      client,
      BOOSTS_CHANNEL_ID,
      MSG_ID_FILE,
      buildEmbed(rankings),
      'listagem top 20',
    );
    log('Listagem top 20 atualizada.');
  } catch (err) {
    log(`Erro listagem top 20: ${err.message}`);
  }

  // 2. Embed LISTAGEM DE POSIÇÕES (santa, estilo Python) - editado continuamente
  if (POSICOES_CHANNEL_ID) {
    try {
      await editOrSendEmbed(
        client,
        POSICOES_CHANNEL_ID,
        POSICOES_MSG_FILE,
        buildPositionsEmbed(rankings, previous),
        'posicoes',
      );
      log('Embed POSIÇÕES atualizado.');
    } catch (err) {
      log(`Erro embed POSIÇÕES: ${err.message}`);
    }
  }

  // 3. Embed LISTAGEM DE BOOSTS (top 20 por pais com santa em destaque) - editado continuamente
  if (BOOSTS_DELTAS_CHANNEL_ID) {
    try {
      await editOrSendEmbed(
        client,
        BOOSTS_DELTAS_CHANNEL_ID,
        BOOSTS_DELTAS_MSG_FILE,
        buildEmbed(rankings),
        'listagem boosts (top 20)',
      );
      log('Embed LISTAGEM DE BOOSTS (top 20) atualizado.');
    } catch (err) {
      log(`Erro embed LISTAGEM DE BOOSTS: ${err.message}`);
    }
  }

  // 4. Detector de alteracoes (ALTERAÇÕES + RUSH + WhatsApp)
  let detectStats = { positionChanges: 0, rushAlerts: 0 };
  try {
    detectStats = (await detectAndPostChanges(client, rankings, previous)) || detectStats;
  } catch (err) {
    log(`Erro ao detectar alteracoes: ${err.message}`);
  }

  // 5. Log do tick: mesma listagem top 20, mas como msg nova a cada tick
  if (LOG_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (channel) {
        await channel.send({ embeds: [buildEmbed(rankings)] });
      } else {
        log(`Canal de log ${LOG_CHANNEL_ID} nao encontrado.`);
      }
    } catch (err) {
      log(`Erro ao enviar log do tick: ${err.message}`);
    }
  }
}

function validateConfig() {
  const missing = [];
  if (!DISCORD_BOT_TOKEN) missing.push('DISCORD_BOT_TOKEN');
  if (!BOOSTS_CHANNEL_ID) missing.push('BOOSTS_CHANNEL_ID');
  if (missing.length) throw new Error(`Variaveis faltando no .env: ${missing.join(', ')}`);
}

async function main() {
  validateConfig();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
  const runOnce = process.argv.includes('--once');
  const runDailyNow = process.argv.includes('--daily-now');

  client.once('ready', async () => {
    setDiscordLogClient(client); // ativa o forward de erros pro canal de log
    log(`Bot logado como ${client.user.tag}`);
    log(`Erros sao reportados em DM/canal #${ERROR_LOG_CHANNEL_ID}`);

    // Pre-aquece o cache de membros de cada guild (1x no boot, depois GUILD_MEMBER_ADD
    // mantem atualizado via gateway). Evita o spam de opcode 8 a cada DM.
    for (const guild of client.guilds.cache.values()) {
      try {
        await guild.members.fetch();
        _membersFetchedAt.set(guild.id, Date.now());
        log(`  Pre-cache: ${guild.name} -> ${guild.members.cache.size} membros`);
      } catch (err) {
        log(`  Falha pre-cache em ${guild.name}: ${err.message}`);
      }
    }

    log('SantaGroup cities por pais:');
    for (const [country, list] of Object.entries(SANTA_BY_COUNTRY)) {
      log(`  ${country}: ${list.length ? list.join(', ') : '(nenhuma)'}`);
    }
    log(
      `Rush alerts: ativos quando santa eh top 1 com >= ${MIN_BOOSTS_FOR_RUSH_ALERT} boosts e rusher chega a <= ${(RUSH_DIFF_PERCENT * 100).toFixed(0)}% de gap. DM para cargo ${RUSH_DM_ROLE_ID}.`,
    );

    // Modo de teste: dispara a daily list AGORA e encerra
    if (runDailyNow) {
      log('Modo --daily-now. Disparando postDailyList agora...');
      try {
        await postDailyList(client);
      } catch (err) {
        log(`Erro no daily-now: ${err.message}`);
      }
      client.destroy();
      return;
    }

    try {
      await updateListing(client);
    } catch (err) {
      log(`Erro no update inicial: ${err.message}`);
    }

    if (runOnce) {
      log('Modo --once. Encerrando.');
      client.destroy();
      return;
    }

    cron.schedule(
      BOOSTS_LIST_CRON,
      async () => {
        try {
          await updateListing(client);
        } catch (err) {
          log(`Erro no update agendado: ${err.message}`);
        }
      },
      { timezone: BACKUP_TIMEZONE },
    );
    log(`Agendado: "${BOOSTS_LIST_CRON}" (TZ ${BACKUP_TIMEZONE})`);

    if (DAILY_LIST_CHANNEL_ID) {
      cron.schedule(
        DAILY_LIST_CRON,
        async () => {
          try {
            await postDailyList(client);
          } catch (err) {
            log(`Erro no daily list: ${err.message}`);
          }
        },
        { timezone: BACKUP_TIMEZONE },
      );
      log(`Daily list agendada: "${DAILY_LIST_CRON}" -> canal ${DAILY_LIST_CHANNEL_ID} (TZ ${BACKUP_TIMEZONE})`);
    }
  });

  await client.login(DISCORD_BOT_TOKEN);
}

main().catch((err) => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
