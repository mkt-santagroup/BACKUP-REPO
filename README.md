# Backup Bot - GitHub para Discord

Bot simples que baixa um repositorio do GitHub como ZIP e envia para um canal do Discord via webhook, em intervalos definidos.

## Setup

1. Instalar dependencias:
   ```
   npm install
   ```

2. Criar o `.env` a partir do exemplo:
   ```
   copy .env.example .env
   ```

3. Editar `.env` e preencher:
   - **DISCORD_WEBHOOK_URL**: No Discord, va em `Configuracoes do canal > Integracoes > Webhooks > Novo Webhook` e copie a URL.
   - **GITHUB_REPO**: No formato `usuario/repositorio`.
   - **GITHUB_BRANCH**: A branch que sera baixada (padrao `main`).
   - **GITHUB_TOKEN**: Somente necessario se o repo for privado. Gere em https://github.com/settings/tokens com escopo `repo`.
   - **BACKUP_CRON**: Frequencia do backup (formato cron).

## Uso

Rodar uma vez (teste):
```
npm run once
```

Rodar em modo agendado (fica em loop):
```
npm start
```

## Limites

- Discord aceita arquivos ate **25 MB** via webhook normal. Se o ZIP passar disso, o bot avisa no canal mas mantem o arquivo salvo localmente em `backups/`.
- Para repos grandes, considere dividir o ZIP ou hospedar em outro lugar (Google Drive, S3) e mandar so o link.

## Exemplos de cron

| Quando            | Cron            |
|-------------------|-----------------|
| A cada 6 horas    | `0 */6 * * *`   |
| Todo dia as 3h    | `0 3 * * *`     |
| Toda segunda 9h   | `0 9 * * 1`     |
| A cada 30 min     | `*/30 * * * *`  |
