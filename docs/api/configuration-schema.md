# Schema de configuração

Propósito: documentar os campos aceitos em `suite.json`, seus limites e as regras de validação de `src/config.ts`, inclusive o bloco `headroom`. Público: integradores e operadores. Data: 2026-10-23.

O schema é estrito: campos desconhecidos são rejeitados. Todo arquivo passa por validação antes de ser gravado, tanto em `init` quanto em `config`.

## Campos

| Campo | Tipo | Regra | Padrão (`config/default.json`) |
|---|---|---|---|
| `schemaVersion` | número | Exatamente `1` | `1` |
| `workspace` | texto | `^[a-z][a-z0-9-]{0,40}$` | `jev-suite` |
| `project` | texto | `^[a-z][a-z0-9-]{0,40}$` | `jev-memory-suite` |
| `projectRoot` | texto opcional | Caminho absoluto, até 4096 caracteres; limita arquivos de cliente e hooks ao projeto externo registrado | Ausente no perfil base |
| `controlPort` | inteiro | 1024 a 65535 | `18877` |
| `memory.enabled` | booleano | — | `true` |
| `memory.port` | inteiro | 1024 a 65535 | `49375` |
| `memory.semanticSearch` | booleano | `true` usa embeddings locais (`embedding_provider = "local"`); `false` grava `none` e deixa a busca só léxica. Ver [ADR 0007](../architecture/adr/0007-local-semantic-memory.md). | `true` |
| `dashboard.port` | inteiro | 1024 a 65535; default do schema quando ausente | `18879` |
| `gatewayExperiment.claude` | texto | `default`, `shadow` ou `metering`. Vale quando o roteador do Claude inicia. | `default` |
| `gatewayExperiment.codex` | texto | `default`, `shadow` ou `metering`. Vale quando o roteador do Codex inicia. | `default` |
| `observability.pricing.models` | objeto | Até 100 modelos configurados, mesclados aos padrões: o do usuário vence no mesmo id. Cada chave é o nome do modelo (`^[A-Za-z0-9._:/@-]{1,80}$`) e cada valor tem `inputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok` e `outputPerMTok` (números de 0 a 10000, por milhão de tokens), além de `currency` (`"USD"`), `source` (texto de 1 a 200 caracteres), `verifiedAt` (`AAAA-MM-DD`) e `validUntil` (opcional, `AAAA-MM-DD`, último dia de vigência, inclusive). | dois padrões Gemini verificados; ver [configuração](../guides/configuration.md#preços-padrão) |
| `observability.pricing.aliases` | objeto | Até 100 pares `modelo observado -> modelo com preço`, como equivalência assumida. Usado só quando o modelo observado não tem preço próprio e o alvo tem. A estimativa é marcada no painel. | `{}` |
| `observability.pricing.jev` | objeto opcional | `inputPerMTok`, `outputPerMTok`, `currency`, `source` e `verifiedAt`, com as mesmas regras. Ausente significa sem preço do Jev. | ausente |
| `observability.billing` | objeto | `claude`, `codex` e `agy`, cada um com `api`, `subscription` ou `unknown`. Define a base de cobrança exibida no card do cliente. Não altera o cálculo. | `claude` e `codex` `unknown`; `agy` `subscription` |
| `gateway.enabled` | booleano | — | `false` |
| `gateway.port` | inteiro | 1024 a 65535 | `18878` |
| `gateway.upstreamUrl` | URL | HTTPS, ou `http://127.0.0.1`; sem credenciais, query ou fragmento; host na allowlist | `https://api.openai.com/v1` |
| `gateway.jevUrl` | URL | Mesmas regras de `upstreamUrl` | `https://api.typesafe.ai/v1/systemone` |
| `gateway.allowedHosts` | lista | 1 a 16 itens, cada um `^[a-z0-9.-]+$` | `["api.openai.com", "api.typesafe.ai"]` |
| `gateway.upstreamKeyEnv` | texto | `^JMS_[A-Z0-9_]{1,60}$` | `JMS_UPSTREAM_KEY` |
| `gateway.jevKeyEnv` | texto | `^JMS_[A-Z0-9_]{1,60}$` | `JMS_JEV_KEY` |
| `headroom.enabled` | booleano | Liga o Headroom para o Claude (`jev-memory-claude`) e, com `headroom.codex`, para o Codex (`jev-memory-codex`). Desligado, o caminho dos launchers não muda. Ver [ADR 0013](../architecture/adr/0013-headroom-context-compression.md) e [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md). | `false` |
| `headroom.port` | inteiro | 1024 a 65535; deve ser distinta das outras quatro portas | `18880` |
| `headroom.version` | texto | `X.Y.Z`. A detecção exige igualdade exata com a saída de `headroom --version`. | `0.41.0` |
| `headroom.executable` | texto opcional | Caminho absoluto, até 4096 caracteres. Quando presente, é o único caminho considerado, sem fallback. | ausente |
| `headroom.codex` | booleano | Só vale com `headroom.enabled: true`. Roteia o Codex com login ChatGPT pelo gateway Jev codex, com o shim de runtime da versão fixada. O modo Codex também exige que o executável seja detectado (`headroom.executable` ou PATH) e que o interpretador do `headroom-ai` seja encontrado. Ver [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md). | `false` |
| `headroom.python` | texto opcional | Caminho absoluto, até 4096 caracteres, do `python.exe` do ambiente uv que contém `headroom-ai`. Quando presente, é o único caminho considerado, sem fallback. Só é usado com `headroom.codex`. | ausente |

Perfis que não têm o bloco `headroom` são lidos com os padrões acima.

## Regras globais

- As cinco portas `controlPort`, `memory.port`, `gateway.port`, `dashboard.port` e `headroom.port` devem ser distintas, mesmo quando um serviço estiver desabilitado. Perfis de projeto externo recebem uma quinta porta alocada para `headroom.port`.
- Os endpoints são validados pela própria URL: o hostname precisa estar em `allowedHosts`, e a URL não pode conter `userinfo`, `search` ou `hash`.
- Os valores das chaves nunca entram no arquivo. Apenas os **nomes** das variáveis de ambiente são configurados.

## Exemplo

O padrão do repositório, que é o conteúdo de `config/default.json`:

```json
{
  "schemaVersion": 1,
  "workspace": "jev-suite",
  "project": "jev-memory-suite",
  "controlPort": 18877,
  "memory": { "enabled": true, "port": 49375, "semanticSearch": true },
  "gateway": {
    "enabled": false, "port": 18878,
    "upstreamUrl": "https://api.openai.com/v1",
    "jevUrl": "https://api.typesafe.ai/v1/systemone",
    "allowedHosts": ["api.openai.com", "api.typesafe.ai"],
    "upstreamKeyEnv": "JMS_UPSTREAM_KEY", "jevKeyEnv": "JMS_JEV_KEY"
  },
  "headroom": { "enabled": false, "port": 18880, "version": "0.41.0" }
}
```

Observação: as URLs padrão do Gateway apontam para terceiros. Elas só são usadas quando `gateway.enabled` for `true`.
