# FiveM Server List API — SantaGroup

API REST simples que devolve o **ranking de servidores FiveM por país**, ordenado por boosts (a métrica oficial de popularidade da plataforma).

Os dados vêm direto da API oficial do FiveM (`frontend.cfx-services.net`) com cache em memória de 45 segundos. Sem dependência de wrapper externo, sem hibernação, sem instabilidade.

---

## Autenticação

Todas as rotas (exceto `/` e `/health`) exigem uma **API key**. Você pode mandar ela de **3 formas**, escolha a que preferir:

| Forma | Como mandar | Exemplo |
|---|---|---|
| Header (recomendado) | `X-API-Key: <key>` | `curl -H "X-API-Key: ccd189..." .../BR` |
| Bearer token | `Authorization: Bearer <key>` | `curl -H "Authorization: Bearer ccd189..." .../BR` |
| Query string | `?api_key=<key>` | `curl ".../BR?api_key=ccd189..."` |

A key é configurada na env `API_KEY` no servidor. Pra gerar uma nova:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Respostas de erro:
- **401** `{"error":"missing_api_key"}` — não mandou a key
- **403** `{"error":"invalid_api_key"}` — key não confere

---

## Endpoints

### `GET /:country`

Retorna o top de servidores de um país.

| Param | Tipo | Default | Descrição |
|---|---|---|---|
| `country` | string (path) | **obrigatório** | Código do país: `BR`, `UK`, `PT`, `ES`, `US`, `FR`, `SA` |
| `limit` | int (query) | `20` | Quantidade de servers (mín 1, máx 200) |

**Exemplo:**

```bash
curl https://sua-api.railway.app/BR?limit=10
```

**Resposta:**

```json
{
  "country": "BR",
  "flag": "🇧🇷",
  "primaryLocale": "pt-BR",
  "locales": ["pt-BR", "pt-br"],
  "count": 10,
  "fetchedAtMs": 44,
  "updatedAt": "2026-06-01T17:55:35.435Z",
  "servers": [
    {
      "rank": 1,
      "name": "[BRASIL]✅CIDADE NOBRE🡺WIPOU HJ 01-JUN🡸",
      "boosts": 5018,
      "players": 1080,
      "maxPlayers": 2048,
      "locale": "pt-BR",
      "endpoint": "vxz4gq",
      "joinUrl": "https://servers.fivem.net/servers/detail/vxz4gq"
    },
    {
      "rank": 2,
      "name": "[BRASIL] HORIZONTE ROLEPLAY ➜ WIPOU HOJE",
      "boosts": 5010,
      "players": 88,
      "maxPlayers": 2048,
      "locale": "pt-BR",
      "endpoint": "pgaxlra",
      "joinUrl": "https://servers.fivem.net/servers/detail/pgaxlra"
    }
  ]
}
```

---

### `GET /countries`

Lista todos os países suportados e suas variantes de locale.

```bash
curl https://sua-api.railway.app/countries
```

**Resposta:**

```json
{
  "count": 7,
  "countries": [
    { "label": "BR", "flag": "🇧🇷", "primaryLocale": "pt-BR", "locales": ["pt-BR", "pt-br"] },
    { "label": "UK", "flag": "🇬🇧", "primaryLocale": "en-GB", "locales": ["en-GB", "en-UK", "en-uk"] },
    { "label": "PT", "flag": "🇵🇹", "primaryLocale": "pt-PT", "locales": ["pt-PT", "pt-pt"] },
    { "label": "ES", "flag": "🇪🇸", "primaryLocale": "es-ES", "locales": ["es-ES", "es-es"] },
    { "label": "US", "flag": "🇺🇸", "primaryLocale": "en-US", "locales": ["en-US", "en_US", "en-us"] },
    { "label": "FR", "flag": "🇫🇷", "primaryLocale": "fr-FR", "locales": ["fr-FR", "fr-fr"] },
    { "label": "SA", "flag": "🇸🇦", "primaryLocale": "ar-SA", "locales": ["ar-SA", "ar-sa"] }
  ]
}
```

---

### `GET /health`

Status check pra monitoramento.

```bash
curl https://sua-api.railway.app/health
```

```json
{ "ok": true, "ts": "2026-06-01T17:55:33.733Z" }
```

---

## Por que múltiplas variantes de locale?

Servidores FiveM cadastram a tag `vars.locale` de formas inconsistentes. Por exemplo, no Reino Unido alguns usam `en-GB` (ISO correto) e outros usam `en-UK` (ISO inválido, mas em uso). Sem mesclar todas as variantes, perde-se cobertura — no UK chegamos a perder **~22% do ranking** (incluindo servidores grandes como Trappin Southside e Trappin RP).

A API busca todas as variantes conhecidas por país, deduplica por `EndPoint` (joinId único do servidor) e mantém o maior boost se houver duplicata.

---

## Performance

- **Cache em memória de 45 segundos.** A primeira request fria leva ~1.5s (puxa ~33k servers em protobuf da API oficial e decodifica). Requests subsequentes dentro do TTL custam **<50ms**.
- **Filtros aplicados**: descarta servidores com `boosts <= 0` (servidores inativos ou sem boost).
- **Ordenação**: por `boosts DESC` (igual o ranking que o cliente FiveM mostra).

---

## Códigos de status

| Status | Significado |
|---|---|
| `200` | Sucesso |
| `404` | País não suportado — `body.supported` lista os disponíveis |
| `502` | Falha ao chamar a API oficial do FiveM |

---

## Como rodar

### Local

```bash
npm install
npm run api
```

Escuta em `http://localhost:3000` por padrão. Variável `API_PORT` permite trocar.

### Deploy (Railway / Render / qualquer Node)

Start command:
```
node api.js
```

Sem variáveis de ambiente obrigatórias. `API_PORT` é opcional (Railway define `$PORT` automaticamente — basta trocar `API_PORT` por `PORT` em `api.js` se quiser).

---

## Exemplos de uso

### Pegar top 3 servidores BR e mostrar nome + boosts

```bash
curl -s https://sua-api.railway.app/BR?limit=3 | jq '.servers[] | { name, boosts }'
```

### Verificar se uma cidade específica tá no top 20 do UK

```bash
curl -s https://sua-api.railway.app/UK?limit=20 | jq '.servers[] | select(.name | test("Trappin"))'
```

### Cron pra salvar snapshot horário em DB

```bash
0 * * * * curl -s https://sua-api.railway.app/BR | psql -c "INSERT INTO snapshots (data) VALUES ('$(cat)')"
```

---

## Stack

- **Node.js** + **Express 5**
- **protobufjs** pra decodificar o stream binário do FiveM
- Sem banco de dados, sem fila, sem dependência externa
- Single file, ~140 linhas

---

## Manutenção

Se a API oficial do FiveM mudar de endpoint novamente, a única linha a alterar é `STREAM_URL` em [cfx-fetcher.js](cfx-fetcher.js).

Pra descobrir o novo endpoint: abrir [servers.fivem.net](https://servers.fivem.net) num browser, abrir DevTools → Network, filtrar por `streamRedir` — a URL chamada é o endpoint atual.
