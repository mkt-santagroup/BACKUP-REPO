// Bootstrap unico que sobe os 3 servicos (bot Discord + API REST + backup do repo)
// no mesmo container. Substitui o "concurrently -k" que dependia do comando "ps"
// (inexistente em containers minimalistas como o do Railway).
//
// Se qualquer um morrer, mata os outros e sai com codigo != 0 - dai o Railway
// detecta e restarta o container inteiro (estado limpo).

const { spawn } = require('child_process');

const services = [
  { name: 'bot',    args: ['boost-listing-bot.js'] },
  { name: 'api',    args: ['api.js'] },
  { name: 'backup', args: ['index.js'] },
];

const children = [];
let terminating = false;

function prefixed(name, stream, data) {
  // Quebra em linhas e prefixa cada uma com [name]
  const lines = data.toString().split('\n');
  // ultima entrada pode ser linha vazia (split de buffer com \n final)
  const tail = lines.pop();
  for (const line of lines) stream.write(`[${name}] ${line}\n`);
  if (tail) stream.write(`[${name}] ${tail}`);
}

function killAll(signal) {
  if (terminating) return;
  terminating = true;
  for (const c of children) {
    try { c.kill(signal); } catch (_) {}
  }
}

for (const svc of services) {
  const child = spawn(process.execPath, svc.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);

  child.stdout.on('data', (d) => prefixed(svc.name, process.stdout, d));
  child.stderr.on('data', (d) => prefixed(svc.name, process.stderr, d));

  child.on('exit', (code, signal) => {
    console.error(`[${svc.name}] saiu com code=${code} signal=${signal}`);
    if (!terminating) {
      killAll('SIGTERM');
      // Da um tempinho pros outros encerrarem, dai mata o pai
      setTimeout(() => process.exit(code || 1), 2000);
    }
  });

  child.on('error', (err) => {
    console.error(`[${svc.name}] erro de spawn: ${err.message}`);
    if (!terminating) {
      killAll('SIGTERM');
      setTimeout(() => process.exit(1), 2000);
    }
  });
}

process.on('SIGTERM', () => killAll('SIGTERM'));
process.on('SIGINT', () => killAll('SIGINT'));

console.log('[start] subindo:', services.map((s) => s.name).join(', '));
