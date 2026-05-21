require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');

const {
  DISCORD_WEBHOOK_URL,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  GITHUB_TOKEN,
  BACKUP_CRON = '0 8 * * *',
  BACKUP_TIMEZONE = 'America/Sao_Paulo',
  BACKUP_MESSAGE = '',
} = process.env;

const BACKUP_DIR = path.join(__dirname, 'backups');
const DISCORD_FILE_LIMIT = 25 * 1024 * 1024; // 25MB (limite padrao do Discord)

// Diretorio onde o tamanho do ultimo backup eh persistido (pra deduplicar quando
// o repo nao mudou). No Railway, aponte DATA_DIR para o mount path do volume.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LAST_SIZE_FILE = path.join(DATA_DIR, '.last-backup-size');

function loadLastSize() {
  if (!fs.existsSync(LAST_SIZE_FILE)) return null;
  try {
    const raw = fs.readFileSync(LAST_SIZE_FILE, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function saveLastSize(size) {
  fs.writeFileSync(LAST_SIZE_FILE, String(size));
}

function log(msg) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${now}] ${msg}`);
}

function validateConfig() {
  const missing = [];
  if (!DISCORD_WEBHOOK_URL) missing.push('DISCORD_WEBHOOK_URL');
  if (!GITHUB_REPO) missing.push('GITHUB_REPO');
  if (missing.length) {
    throw new Error(`Variaveis faltando no .env: ${missing.join(', ')}`);
  }
  if (!cron.validate(BACKUP_CRON)) {
    throw new Error(`BACKUP_CRON invalido: "${BACKUP_CRON}"`);
  }
}

async function downloadRepoZip() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/zipball/${GITHUB_BRANCH}`;
  log(`Baixando ${GITHUB_REPO}@${GITHUB_BRANCH}...`);

  const headers = {
    'User-Agent': 'fivemboosts-backup-bot',
    Accept: 'application/vnd.github+json',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const response = await axios.get(url, {
    headers,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    maxContentLength: 500 * 1024 * 1024,
  });

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = GITHUB_REPO.replace('/', '_');
  const filename = `${safeName}_${GITHUB_BRANCH}_${timestamp}.zip`;
  const filepath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(filepath, response.data);
  const sizeMB = (response.data.length / 1024 / 1024).toFixed(2);
  log(`ZIP salvo: ${filename} (${sizeMB} MB)`);

  return { filepath, filename, size: response.data.length };
}

async function sendToDiscord({ filepath, filename, size }) {
  if (size > DISCORD_FILE_LIMIT) {
    const sizeMB = (size / 1024 / 1024).toFixed(2);
    log(`Arquivo muito grande (${sizeMB} MB > 25 MB). Enviando aviso ao Discord.`);
    await axios.post(DISCORD_WEBHOOK_URL, {
      content: `:warning: Backup de **${GITHUB_REPO}@${GITHUB_BRANCH}** gerado (${sizeMB} MB) mas excede o limite de upload de 25 MB do Discord. Arquivo salvo localmente em \`${filepath}\`.`,
    });
    return;
  }

  log('Enviando para o Discord...');
  const form = new FormData();
  form.append('files[0]', fs.createReadStream(filepath), filename);

  await axios.post(DISCORD_WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  log('Backup enviado ao Discord com sucesso.');
}

async function runBackup() {
  try {
    const file = await downloadRepoZip();

    const lastSize = loadLastSize();
    if (lastSize !== null && lastSize === file.size) {
      log(`Tamanho identico ao ultimo backup (${file.size} bytes). Pulando envio.`);
      try {
        fs.unlinkSync(file.filepath);
      } catch (_) {}
      return;
    }

    await sendToDiscord(file);
    saveLastSize(file.size);
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`
      : err.message;
    log(`ERRO: ${detail}`);

    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          content: `:x: Falha no backup de **${GITHUB_REPO}@${GITHUB_BRANCH}**: \`${detail.slice(0, 500)}\``,
        });
      } catch (_) {}
    }
  }
}

(async () => {
  validateConfig();

  if (process.argv.includes('--once')) {
    log('Executando backup unico (modo --once)...');
    await runBackup();
    return;
  }

  log(`Bot iniciado. Schedule: "${BACKUP_CRON}" (repo: ${GITHUB_REPO}@${GITHUB_BRANCH})`);
  log('Rodando backup inicial (confirmacao)...');
  await runBackup();

  cron.schedule(BACKUP_CRON, runBackup, { timezone: BACKUP_TIMEZONE });
  log(`Aguardando proximo backup agendado (cron "${BACKUP_CRON}" / TZ ${BACKUP_TIMEZONE})...`);
})();
