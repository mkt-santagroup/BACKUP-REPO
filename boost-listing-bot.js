require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const SL_API = 'https://fivem-sl-api.onrender.com';
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
const LAST_GOOD_FILE = path.join(DATA_DIR, '.last-good-rankings.json');
const MIN_SERVERS_THRESHOLD = 10; // abaixo disso, considera resposta incompleta e usa cache

// Limites do detector de rush no podio
const MIN_BOOSTS_FOR_RUSH_ALERT = 100;  // top 1 abaixo disso e ruido (cidade muito pequena)
const RUSH_DIFF_PERCENT = 0.30;         // alerta quando rusher esta a <= 30% de boost da nossa top 1
const RUSH_DIFF_CLOSE_MIN = 50;         // o rusher precisa ter fechado o gap em >= isso (debounce)
const LOSS_THRESHOLD = 100;             // perda minima para flagar uma cidade como "doadora"
const RUSH_DM_ROLE_ID = '1476932779123150959'; // cargo que recebe DM desesperada quando ha rush

// Palavras-chave de promo/marketing - cortamos a string ANTES delas (na primeira ocorrencia
// que NAO seja o inicio do nome). O regex usa \b apenas na ABERTURA, entao "INAUGURA"
// tambem casa "INAUGURACAO", "INAUGURACION", "INAUGURADO" etc.
const PROMO_KEYWORDS = [
  'LAUNCH',
  'OPENING', 'OPENS', 'OPENED', 'OPEN',
  'WIPOU', 'WIPED', 'WIPES', 'WIPING', 'WIPE',
  'INAUGURA', 'INAUGUROU', 'INAUGURO',
  'APERTURA', 'ABRIU', 'ABERTURA',
  'COMEBACK',
  'UPDATE', 'UPDATED', 'UPDATES',
  'BEGINNER',
  'NOW', 'TODAY', 'HOJE', 'HOY',
  'SEASON', 'SAISON',
  'DISCORD', 'discord', 'DC\\b',
  'SERVEUR', 'SERVIDOR', 'SERVER',
  'SOBREVIVENCIA', 'APOCALIPSE',
  'SERIOUS', 'SÉRIEUX', 'SERIO', 'sérieux', 'serio',
  'FRESH', 'ECONOMY',
  'GANG\\b',
  'MAKING',
  'SUMMER', 'SPRING', 'AUTUMN', 'WINTER', 'VERAO', 'INVIERNO',
  'BIG', 'FUN',
  'VIBE', 'VIBES',
  'ULTIMATE',
  'EXCLUSIF', 'EXCLUSIVE',
  'NEW',
  'TRAMES', 'UNBAN',
  'ESSAYER', 'TENTER',
  'PROXIMAMENTE', 'PROXIMA', 'PROXIMO',
  'OUT\\b', 'SOON', 'SOON\\b',
  'ENTRA', 'ENTRE', 'ENTREZ', 'ENTRADAS',
  'REBORN', 'RELANC',
  'AIMLAB',
  'PACK',
  'ESTAMOS',
  'EVENTS', 'EVENTO', 'EVENEMENT',
  'ANOS', 'YEARS', 'ANNIVERSARY', 'ANIVERSARIO',
  'PRIVADO', 'PRIVATE',
  'CUSTOM',
  'WL\\b',
  'GROS',
  'AUTOMAT',
  'ADVANCED',
  'LO\\s+QUE', 'LO\\b',
  'SI\\s+EN',
  'GROUP\\b',
];

const {
  DISCORD_BOT_TOKEN,
  BOOSTS_CHANNEL_ID,
  CHANGES_CHANNEL_ID,
  RUSH_CHANNEL_ID,
  POSICOES_CHANNEL_ID,
  BOOSTS_DELTAS_CHANNEL_ID,
  DAILY_LIST_CHANNEL_ID,
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

// extraLocales: locales adicionais a buscar e mergear. Util quando server tagga
// `vars.locale` com codigo nao-padrao (ex: Trappin UK usa "en-UK" em vez do
// ISO "en-GB"). Resultados dedupados por nome de cidade, maior boost vence.
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
  US: ['LIBERTY 99', 'DISTRICT 99'],
  FR: ['GOAT'],
  SA: ['ORIZON'],
};

function log(msg) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${now}] ${msg}`);
}

function cleanCityName(raw = '') {
  let s = raw;

  // 1. Codigos de cor do FiveM (^1, ^2...)
  s = s.replace(/\^[0-9]/g, '');

  // 2. Conteudo entre colchetes/parenteses: [BR], [18+], [FRESH ECONOMY, (anything)
  s = s.replace(/\[[^\]]*\]?/g, ' ');
  s = s.replace(/\([^)]*\)?/g, ' ');

  // 3. Emojis e pictogramas
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ');

  // 4. Caracteres decorativos (setas, blocos, traços longos, etc.)
  s = s.replace(
    /[▬═║╗╔↭🡺🡸»«—–⟶⟵◥◤◣◢⌠⌡░▒▓▌▐╣╠╬¦│┃·•★☆◆◇■□●○⤳⤠⮕⮜<>«»―‐‑‒]/g,
    ' ',
  );
  s = s.replace(
    /[\u{2010}-\u{206F}\u{2580}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F800}-\u{1F8FF}\u{2900}-\u{297F}]/gu,
    ' ',
  );
  // Zero-width joiners, variation selectors, replacement char
  s = s.replace(/[\u{200B}-\u{200F}\u{FE00}-\u{FE0F}\u{FFFD}]/gu, '');

  // 4.5. Strip texto Arabe (servers da SA misturam nome latim com promo em arabe
  // tipo "Orizon RP🡺تنطلق الآن 19 دقائق🡸" = "lanca em 19 min"). Strip tambem
  // dos blocos de presentation forms / arabic supplement.
  s = s.replace(
    /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]+/gu,
    ' ',
  );

  // 5. Prefixo "Grand Opening!!" e similares - mantem apenas o que vem depois
  s = s.replace(/^\s*(?:GRAND\s+OPENING|GRAND\s+OPEN)\s*!*\s*/i, '');

  // 6. Adiciona espaco em camelCase agressivo: "RoleplayLAUNCHED" -> "Roleplay LAUNCHED"
  s = s.replace(/([a-z])([A-Z]{2,})/g, '$1 $2');

  // 7. Corta em separadores comuns " - ", " | ", " #"
  s = s.split(/\s+[-]\s+/)[0];
  s = s.split('|')[0];
  s = s.split(/\s+#/)[0];

  // 8. Colapsa "RP RP" -> "RP"
  s = s.replace(/\bRP\s+RP\b/gi, 'RP');

  // 9. Corta no primeiro keyword de promo (apenas se estiver depois da primeira palavra).
  // \b apenas na abertura: "INAUGURA" tambem casa "INAUGURACAO"/"INAUGURACION".
  // Keywords ja podem trazer \\b proprio no fim quando precisam ser exatos.
  const promoRe = new RegExp(
    '\\s(?:' +
      PROMO_KEYWORDS.map((p) =>
        // mantem \\b literal se ja vier no keyword, senao escapa o resto normalmente
        p.includes('\\b') || p.includes('\\s')
          ? p
          : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ).join('|') +
      ')',
    'i',
  );
  const m = s.match(promoRe);
  if (m && m.index > 0) s = s.slice(0, m.index);

  // 10. Strip de sufixos de data: "14-MAY", "14-05", "MAY 2ND"
  s = s.replace(/\s*\d{1,2}[-/]\w+/g, '');
  s = s.replace(/\s*\d{1,2}(?:ST|ND|RD|TH)\b/gi, '');

  // 11. Strip de marcadores de idade: "18+", "21+"
  s = s.replace(/\s*\b\d{1,2}\+/g, '');

  // 12. Corta em "!!"
  s = s.split('!!')[0];

  // 13. Strip pontuacao orfa
  s = s.replace(/[!*]+/g, '');
  s = s.replace(/^[\s\-:.,;]+/, '').replace(/[\s\-:.,;]+$/, '');

  // 14. Strip digito solto no final (1 digito apenas) - evita "META CITY 5" virar nome
  //     Nao afeta "LIBERTY 99" ou "Viper 3.5" (multi-digito ou com ponto).
  s = s.replace(/\s+\d\s*$/, '');

  // 15. Strip chars-lixo no final (qualquer coisa que nao seja letra/digito)
  s = s.replace(/(?:\s+[^\p{L}\p{N}]+)+$/u, '');

  // 16. Colapsa espacos
  s = s.replace(/\s+/g, ' ').trim();

  return s || raw;
}

function isOurCity(name, countryLabel) {
  const list = SANTA_BY_COUNTRY[countryLabel] || [];
  if (!list.length) return false;
  const lower = name.toLowerCase();
  return list.some((c) => lower.includes(c.toLowerCase()));
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

async function fetchByLocale(locale) {
  const url = `${SL_API}/fetchServersByLocale/${locale}`;
  const { data } = await axios.get(url, { timeout: 60000 });
  if (!Array.isArray(data)) return [];

  const mapped = data.map((srv) => {
    const d = srv.Data || {};
    const v = d.vars || {};
    const raw = v.sv_projectName || d.hostname || '';
    return {
      raw,
      city: cleanCityName(raw),
      boosts: d.upvotePower || 0,
    };
  });

  // Modo debug: se DEBUG_LOCALE bate com o locale atual, loga raw vs cleaned
  // de TODOS os servidores retornados (nao so o top 20). Util pra diagnosticar
  // sumiço de servidores especificos como "ele saiu do UK?".
  if (process.env.DEBUG_LOCALE === locale) {
    log(`[DEBUG ${locale}] API retornou ${mapped.length} servidores brutos:`);
    mapped
      .slice()
      .sort((a, b) => b.boosts - a.boosts)
      .forEach((s, i) => {
        log(`  ${i + 1}. ${s.boosts}b | raw="${s.raw}" | clean="${s.city}"`);
      });
  }

  return mapped
    .filter((s) => s.city)
    .map(({ city, boosts }) => ({ city, boosts }))
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

function loadLastGood() {
  if (!fs.existsSync(LAST_GOOD_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LAST_GOOD_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveLastGood(cache) {
  fs.writeFileSync(LAST_GOOD_FILE, JSON.stringify(cache, null, 2));
}

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

async function fetchAllRankings() {
  const cache = loadLastGood();
  const rankings = {};

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

    if (fresh.length >= MIN_SERVERS_THRESHOLD) {
      // Resposta saudavel - usa e atualiza cache
      rankings[c.label] = fresh;
      cache[c.label] = fresh;
      log(`  ${c.flag} ${c.label} (${c.locale}): ${fresh.length} servers`);
    } else if (cache[c.label] && cache[c.label].length >= MIN_SERVERS_THRESHOLD) {
      // Resposta incompleta - usa o ultimo bom cache
      rankings[c.label] = cache[c.label];
      log(
        `  ⚠️  ${c.flag} ${c.label} (${c.locale}): API retornou ${fresh.length}, usando cache (${cache[c.label].length})`,
      );
    } else {
      // Sem cache ainda - aceita o que veio
      rankings[c.label] = fresh;
      log(`  ${c.flag} ${c.label} (${c.locale}): ${fresh.length} servers (sem cache anterior)`);
    }
  }

  saveLastGood(cache);
  return rankings;
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
    return;
  }

  const now = new Date().toLocaleString('pt-BR', {
    timeZone: BACKUP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });

  // === 1. Alteracoes de posicao -> CHANGES_CHANNEL_ID + agrega p/ WhatsApp ===
  const allSantaChanges = []; // pra notificacao WhatsApp agregada

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

          // Ignora "movimento fantasma": posicao mudou mas a nossa cidade nao
          // ganhou nem perdeu boost. Isso acontece quando outra cidade entra/sai
          // de um empate alfabetico e empurra a nossa pra cima ou pra baixo, sem
          // nenhuma acao real da nossa parte.
          if (boostDelta === 0) continue;

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
      }

      if (totalChanges === 0) log('Nenhuma alteracao de posicao desde o ultimo snapshot.');
    }
  }

  // === 2. Alertas de RUSH no podio -> RUSH_CHANNEL_ID ===
  if (RUSH_CHANNEL_ID) {
    await detectRushers(client, rankings, previous, now);
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
}

async function detectRushers(client, rankings, previous, now) {
  const channel = await client.channels.fetch(RUSH_CHANNEL_ID);
  if (!channel) {
    log(`Canal de rush ${RUSH_CHANNEL_ID} nao encontrado.`);
    return;
  }

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

    // DM com o MESMO embed que foi pro canal (identico)
    try {
      const { sent, failed } = await dmRoleMembers(client, RUSH_DM_ROLE_ID, { embeds: [embed] });
      log(`  📩 DM rush enviada para ${sent} membros (${failed} falhas)`);
    } catch (err) {
      log(`  Erro ao enviar DMs de rush: ${err.message}`);
    }
  }
}

async function dmRoleMembers(client, roleId, payload) {
  let sent = 0;
  let failed = 0;
  const guilds = [...client.guilds.cache.values()];
  log(`  [DM] Bot esta em ${guilds.length} guild(s). Procurando cargo ${roleId}...`);

  for (const guild of guilds) {
    let role;
    try {
      role = await guild.roles.fetch(roleId);
    } catch (err) {
      log(`  [DM] Guild ${guild.name} (${guild.id}): erro ao buscar cargo: ${err.message}`);
      continue;
    }
    if (!role) {
      log(`  [DM] Guild ${guild.name} (${guild.id}): cargo nao existe aqui.`);
      continue;
    }

    log(`  [DM] Cargo encontrado em ${guild.name}. Buscando membros...`);
    try {
      await guild.members.fetch();
    } catch (err) {
      log(`  [DM] Erro ao listar membros do guild ${guild.id}: ${err.message}`);
      log(`  [DM] (Verifique se "Server Members Intent" esta ativo no Developer Portal)`);
      continue;
    }

    const members = [...role.members.values()];
    log(`  [DM] ${members.length} membro(s) com o cargo em ${guild.name}.`);
    if (members.length === 0) {
      log(`  [DM] Ninguem tem o cargo! Verifique se o ID ${roleId} esta correto.`);
    }

    for (const member of members) {
      if (member.user.bot) {
        log(`  [DM] Pulando bot: ${member.user.tag}`);
        continue;
      }
      try {
        await member.send(payload);
        sent++;
        log(`  [DM] ✓ Enviado para ${member.user.tag}`);
      } catch (err) {
        failed++;
        log(`  [DM] ✗ Falhou p/ ${member.user.tag}: ${err.message}`);
      }
      await sleep(300); // evita rate-limit do Discord
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
  try {
    await detectAndPostChanges(client, rankings, previous);
  } catch (err) {
    log(`Erro ao detectar alteracoes: ${err.message}`);
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
    log(`Bot logado como ${client.user.tag}`);
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
