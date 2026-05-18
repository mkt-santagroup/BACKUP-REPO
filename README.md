# SantaGroup - Bots FiveM

Esse projeto tem **2 bots independentes** que rodam separados:

1. **Backup Bot** ([index.js](index.js)) - baixa um repo do GitHub em ZIP e manda no Discord.
2. **Boost Listing Bot** ([boost-listing-bot.js](boost-listing-bot.js)) - posta a listagem das top 20 cidades FiveM por boost em 6 paises (BR/UK/PT/ES/US/FR).

---

## Setup inicial

```powershell
npm install
copy .env.example .env
```

Depois preenche o `.env` com seus valores. Cada bot usa um bloco de variaveis diferente (veja abaixo).

---

## 1. Backup Bot

Baixa um repositorio do GitHub como ZIP e envia para um canal do Discord via **webhook**.

### .env necessario

| Variavel | O que e |
|---|---|
| `DISCORD_WEBHOOK_URL` | URL do webhook do Discord (Config do canal > Integracoes > Webhooks) |
| `GITHUB_REPO` | Repo no formato `usuario/repositorio` (ex: `Zuntie/fivem-serverlist-api`) |
| `GITHUB_BRANCH` | Branch (padrao `main`) |
| `GITHUB_TOKEN` | Token PAT - so se o repo for privado |
| `BACKUP_CRON` | Quando rodar (padrao: `0 8 * * *` = todo dia 8h) |
| `BACKUP_TIMEZONE` | Padrao `America/Sao_Paulo` |

### Como rodar

```powershell
npm run once    # roda 1 backup agora
npm start       # roda em loop, agendado pelo cron
```

### Limites

- Webhook do Discord aceita ate **25 MB** por arquivo. Se passar, o bot avisa no canal mas mantem o ZIP em `backups/`.

---

## 2. Boost Listing Bot

Busca os servidores FiveM de 6 paises e posta um embed no Discord com o top 20 de cada um, ordenado por **boosts**. Edita a mesma mensagem a cada atualizacao (em vez de spam).

### .env necessario

| Variavel | O que e |
|---|---|
| `DISCORD_BOT_TOKEN` | Token do bot (https://discord.com/developers/applications) |
| `BOOSTS_CHANNEL_ID` | ID do canal onde a listagem sera postada |
| `BOOSTS_LIST_CRON` | Frequencia (padrao `*/15 * * * *` = 15 min) |

### Cidades do SantaGroup (marcador amarelo)

Configuradas direto no codigo, em [boost-listing-bot.js:33-40](boost-listing-bot.js#L33-L40). Edita o objeto `SANTA_BY_COUNTRY` pra adicionar/remover cidades por pais:

```js
const SANTA_BY_COUNTRY = {
  BR: ['CIDADE NOBRE', 'CIDADE SANTA', ...],
  UK: ['KNG ESTATE', 'BOOMERANG', 'ROYAL'],
  PT: ['MALTA RP'],
  ES: ['REAL RP', 'PRIME RP'],
  US: ['LIBERTY 99', 'DISTRICT 99'],
  FR: [],
};
```

O match e **case-insensitive e parcial** (ex: `'CIDADE NOBRE'` casa qualquer servidor cujo nome contenha esse texto).

### Como rodar

```powershell
npm run boosts:once    # publica/atualiza 1 vez e sai
npm run boosts         # roda em loop, atualiza a cada 15 min
```

### Estado

O bot grava o ID da mensagem que publicou em `.boost-message-id`. Enquanto esse arquivo existir, ele vai **editar** essa mensagem. Se vc deletar o arquivo (ou a mensagem no Discord), ele cria uma nova na proxima execucao.

---

## Estrutura do projeto

```
.
├── .env                  # Suas senhas/tokens (NAO vai pro git)
├── .env.example          # Template do .env
├── .gitignore
├── .boost-message-id     # Estado do boost bot (gitignored)
├── backups/              # ZIPs do backup bot (gitignored)
├── index.js              # Bot de backup
├── boost-listing-bot.js  # Bot de listagem de boosts
├── package.json
└── README.md
```

---

## Deploy no Railway

Os dois bots podem rodar simultaneamente. No Railway, voce pode:

- **Opcao A:** Criar 2 servicos separados, um com `npm start` e outro com `npm run boosts`.
- **Opcao B:** Adicionar um script `npm run all` que roda os dois em paralelo (use `concurrently` se for esse caminho).

Configure as variaveis de ambiente no painel do Railway (aba **Variables**) - nao precisa subir o `.env`.
