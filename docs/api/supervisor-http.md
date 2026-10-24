# Endpoint de controle do supervisor

Propósito: documentar as rotas HTTP do supervisor de um perfil e do painel local que ele hospeda, a autenticação, os estados retornados, os campos do Headroom (opcional), o estado dos gateways e os reinícios automáticos. Público: integradores e mantenedores. Data: 2026-10-23.

O supervisor escuta em `127.0.0.1:<controlPort>`. Não é uma API pública: serve apenas à CLI do próprio perfil. O painel local tem listener próprio, descrito na seção [Painel local](#painel-local).

## Autenticação

- Cabeçalho `Authorization: Bearer <token>`, em que o token é o `control-token` do perfil (64 caracteres hexadecimais).
- O cabeçalho `Host` precisa ser exatamente `127.0.0.1:<controlPort>`.
- A comparação do token usa `timingSafeEqual`.
- Falha em qualquer uma das duas verificações responde `401` sem corpo.
- O token nunca é impresso pela CLI. `doctor` informa apenas se o arquivo existe.

## Rotas

| Método e caminho | Resposta de sucesso | Efeito |
|---|---|---|
| `GET /status` | `200` com JSON de estado | Nenhum |
| `POST /stop` | `200` com `{"stopping":true}` | Encerra os filhos e o supervisor |
| Qualquer outra | `404` | Nenhum |

## Formato de `/status`

```json
{
  "phase": "ready",
  "services": { "memory": "ready", "gateway": "ready" },
  "restarts": { "memory": 1 },
  "pid": 12345
}
```

Este exemplo mostra a forma; os valores reais dependem do perfil.

- `phase`: `starting`, `ready`, `failed` ou `stopping`.
- `services`: contém apenas os serviços habilitados. Valores: `starting`, `ready`, `restarting`, `failed` ou `stopped`. Só o serviço `headroom` pode ter também o valor `unavailable`.
- `restarts`: contagem de reinícios automáticos por serviço, desde o início desta execução do supervisor. Um serviço sem reinício não aparece no mapa.
- `pid`: PID do próprio supervisor.

### Campos do Headroom

Aparecem somente com `headroom.enabled: true`. O serviço `headroom` começa depois que a fase fica `ready`, em segundo plano, e uma falha dele não altera a fase.

```json
{
  "services": { "memory": "ready", "gateway": "ready", "headroom": "ready" },
  "headroom": { "port": 18880, "upstreamPort": 8789, "version": "0.41.0", "codex": false }
}
```

- `services.headroom`: `starting` durante a inicialização; `ready` quando `/livez` responde; `restarting` durante a espera de um reinício; `unavailable` quando a detecção falha (executável, versão ou porta do Jev claude); `failed` quando a porta está ocupada, o processo não fica saudável ou os reinícios se esgotam.
- `headroom`: porta do proxy, porta do Jev claude para a qual ele encaminha, versão detectada e `codex`. Aparece quando o serviço fica pronto pela primeira vez nesta execução. `codex: false` é o modo só Claude. Com `codex: true`, `codexUpstreamPort` traz a porta do Jev codex para a qual o Headroom encaminha o Codex.
- `headroomReason`: causa em texto curto, presente quando o início do serviço falha. Os textos estão em [solução de problemas](../guides/troubleshooting.md#headroom).
- `headroomCodexReason`: no nível da raiz de `/status`, causa em texto curto quando `headroom.codex` está ligado e o modo Codex não foi iniciado ou não ficou saudável. Nesse caso o serviço segue no modo só Claude. Uma falha do modo Codex, por si só, não muda `services.headroom`. Os textos estão em [solução de problemas](../guides/troubleshooting.md#codex).
- Com o Headroom desligado, nenhum desses campos aparece e `services` não contém `headroom`.

## Reinício automático

Um serviço que sai depois de ficar `ready` é reiniciado pelo supervisor, inclusive o Headroom:

- No máximo 3 tentativas dentro de uma janela de 60 s, com espera de 1 s, 2 s e 4 s. Antes de cada tentativa, a porta é conferida.
- Durante a espera, o serviço aparece como `restarting` e a fase continua `ready` ou `starting`, conforme o estado dos outros serviços.
- Um serviço que sai antes do primeiro `ready` não é reiniciado: a inicialização falha, como antes.
- Esgotado o orçamento, o serviço vai para `failed`, a fase vai para `failed` e o supervisor encerra. A próxima chamada a `start`, ou um lançamento que garanta os serviços, sobe o perfil de novo.

Procedimento para o operador: [operação](../runbooks/operations.md#recuperação-automática).

## Interpretação pela CLI

`supervisorState` em `src/lifecycle.ts` classifica a resposta:

- `running`: resposta 2xx.
- `foreign`: `401` ou `403`. A porta responde, mas não com o token do perfil; outro processo ou outro perfil a ocupa.
- `stopped`: conexão recusada.
- Qualquer outro código lança erro.

Cada requisição tem timeout de 2 s.

## Sinais e encerramento

`SIGINT` e `SIGTERM` disparam o mesmo encerramento de `POST /stop`. Cada filho recebe `SIGTERM` e, se não sair em 6 s, `SIGKILL`. O supervisor só termina filhos que ele mesmo criou.

## Painel local

O painel escuta em `127.0.0.1:<dashboard.port>` (padrão 18879), no mesmo processo do supervisor, em um listener separado do controle. Ele não usa bearer. A página incorpora a página original do Jev Gateway em um único iframe, do agregador (ADR 0010, complementada pela [ADR 0011](../architecture/adr/0011-native-dashboard-and-token-observability.md)). As barreiras são:

- o cabeçalho `Host` precisa ser exatamente `127.0.0.1:<porta>` ou `localhost:<porta>`; qualquer outro valor responde `403`;
- todas as rotas aceitam somente `GET`; outros métodos respondem `405` com `Allow: GET`; caminhos desconhecidos respondem `404`;
- a CSP de `/` (abaixo) e `cache-control: no-store`, `x-content-type-options: nosniff` e `referrer-policy: no-referrer` em todas as respostas.

| Rota | Resposta | Observação |
|---|---|---|
| `GET /` | HTML da página | CSP: `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src <origens>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. `frame-src` lista só as duas origens de loopback do agregador (`http://localhost:<porta>` e `http://127.0.0.1:<porta>`), ou `'none'` quando nenhum gateway está em execução. A página é montada a cada requisição, a partir do snapshot em cache. |
| `GET /gateways/status` | JSON, abaixo | Estado e histórico dos gateways. Cache de 5 s, com uma única atualização em voo. |
| `GET /app.js` | Script do painel | Script da página. |
| `GET /memory/projects` | `{ ok, projects }` | Projetos do AI Memory com `online`. |
| `GET /memory/summary?project=<id>` | Resumo do projeto | `project` ausente usa o padrão. Id desconhecido responde `400` com `unknown project`. Memória indisponível responde `200` com `ok: false`. |
| `GET /memory/feed?project=<id>` | `{ ok, items }` | Mesma regra de `project` do resumo. |

### Iframe do agregador

- Um único `<iframe id="gateway-slot">`, com `data-aggregator="<cliente>:<porta>"`, `sandbox="allow-scripts allow-same-origin"` e `src` igual a `http://localhost:<porta>/dashboard?peers=<demais portas configuradas>`.
- O agregador é o Codex, se estiver em execução; caso contrário, o Claude. Sem gateway em execução, o lugar do iframe mostra o bloco "Gateways offline", com os comandos `jev-memory-codex` e `jev-memory-claude`, e `frame-src` vira `'none'`.
- As portas vêm de `JEV_CLAUDE_PORT` e `JEV_CODEX_PORT` (padrão 8789 e 8790). Um valor inválido usa o padrão e aparece como `portValid: false`. As demais portas configuradas entram no `?peers=`, para que uma porta fora do padrão apareça.
- Se o agregador mudar com a página aberta, aparece o aviso "O gateway mudou desde que esta página foi carregada. Recarregue a página." O painel não recarrega sozinho.
- A alternância de roteamento fica no interruptor da própria página original. A suíte não expõe rota de alteração.

### Estado dos gateways

`GET /gateways/status` responde `200` com `{ ok, generatedAt, aggregator, gateways, combined, pricing }`. Os valores abaixo são ilustrativos; os reais dependem dos gateways em execução.

```json
{
  "ok": true,
  "generatedAt": "2026-10-22T15:00:00.000Z",
  "aggregator": { "client": "codex", "port": 8790 },
  "gateways": [
    {
      "client": "claude", "label": "Claude", "port": 8789, "portValid": true,
      "state": "running", "metrics": "ok",
      "router": { "routing": true, "shadow": false, "minConfidence": 0.5, "recorded": 1000, "startedAt": "<instante>", "upstream": "<origem e caminho>", "jevModel": "<modelo>", "jevProvider": "<provedor>" },
      "history": { "complete": true, "...": "contagens do log incremental" },
      "historyCompare": { "...": "Com Jev x Baseline" },
      "cost": { "history": { "currency": "USD", "llm": null, "jev": null, "total": null, "missing": ["llm-price", "jev-price", "jev-output-tokens"] } },
      "models": { "history": [{ "model": "<modelo>", "metrics": {}, "cost": {} }] },
      "experiment": { "mode": "default" }
    }
  ],
  "combined": { "history": {}, "historyCompare": null, "cost": { "history": {} }, "models": { "history": [] } },
  "pricing": { "models": { "<modelo>": { "source": "<fonte>", "verifiedAt": "2026-10-22" } }, "jev": null }
}
```

- `aggregator`: `null` quando nenhum gateway está em execução. Caso contrário, o cliente e a porta do iframe. Só esses dois campos saem do servidor.
- `state`: `running` (`/health` respondeu), `stopped` (conexão recusada) ou `unavailable` (falha ou timeout de 1 s). A causa não é informada.
- `metrics`: `ok`; `auth-required` (o upstream respondeu `401` ou `403` em `/dashboard/events`; nenhuma chave é enviada); `unavailable` (resposta inválida ou acima de 2 MB, timeout de 1500 ms ou erro); `offline` (gateway parado).
- `router`: estado do roteador. `upstream` contém só origem e caminho. Campos de `router` que não coincidem com o formato esperado são omitidos.
- `history`: contagens lidas do log `~/.jev-gateway/<cliente>.log`. `complete` vem do leitor incremental: `false` quando a leitura ainda não chegou ao fim do log dentro do limite de 8 MiB por atualização.
- `models`: uma entrada por modelo. A chave de cobrança é `sentModel ?? model`.
- `cost`: estimativa de API-equivalente, a partir das contagens e dos preços configurados. Sem preço, o campo vem `null` e `missing` lista o que falta. `jev-output-tokens` aparece sempre, porque o upstream não registra tokens de saída do Jev.
- `experiment`: o modo configurado em `gatewayExperiment` para esse cliente (ver [configuração](../guides/configuration.md#experimento-de-roteamento-e-preços)).
- `combined`: soma as contagens dos dois clientes. Percentis não são combinados.
- `pricing`: eco da configuração, só com `source` e `verifiedAt`.
- A resposta não contém chave, `pid`, texto de prompt nem URL de upstream com credenciais, query ou fragmento.
- Se a verificação falhar por completo, a resposta é `200` com `gateways: []`, e a falha vai para o stderr do supervisor.

Procedimento para o operador: [operação, painel de gateways](../runbooks/operations.md#painel-de-gateways). Decisão: [ADR 0010](../architecture/adr/0010-unified-dashboard.md) e [ADR 0011](../architecture/adr/0011-native-dashboard-and-token-observability.md). Ameaças: [T30](../security/threat-model.md) e [T32](../security/threat-model.md).
