// Bootstrap unico — sobe bot Discord + API REST + backup do repo no MESMO
// processo Node. Substitui o modelo antigo que spawneava 3 child processes
// (concurrently/child_process.spawn), economizando ~40% de RAM:
//   - 1 v8 runtime em vez de 3 (~160MB menos)
//   - cfx-fetcher cache compartilhado entre bot e api (~150MB menos)
//   - 1 Discord client em vez de N
//
// Cada modulo expoe um start() e so auto-executa quando rodado direto
// (require.main === module). Aqui chamamos os 3 explicitamente.

require('dotenv').config();

console.log('[start] subindo bot + api + backup num unico processo Node...');

// API: rapido, listen() eh sincrono. Sobe primeiro pra o /health ficar disponivel
// rapido (Railway/healthcheck).
try {
  require('./api').start();
} catch (e) {
  console.error('[start] api falhou ao iniciar:', e && (e.stack || e.message));
}

// Backup: schedule + initial run (async). Nao bloqueia o boot do bot.
try {
  require('./index')
    .start()
    .catch((e) => console.error('[start] backup erro async:', e && (e.stack || e.message)));
} catch (e) {
  console.error('[start] backup falhou ao iniciar:', e && (e.stack || e.message));
}

// Bot Discord: login eh async (handshake gateway). Tambem nao bloqueia.
// O proprio boost-listing-bot.js ja registra handlers de unhandledRejection /
// uncaughtException que encaminham erros pro canal de log do Discord.
try {
  require('./boost-listing-bot')
    .start()
    .catch((e) => console.error('[start] bot erro async:', e && (e.stack || e.message)));
} catch (e) {
  console.error('[start] bot falhou ao iniciar:', e && (e.stack || e.message));
}

console.log('[start] modulos requisitados. Aguardando eventos…');
