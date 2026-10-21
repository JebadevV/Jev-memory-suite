# Schema de configuração

Propósito: documentar os campos aceitos em `suite.json`, seus limites e as regras de validação de `src/config.ts`. Público: integradores e operadores. Data: 2026-10-21.

O schema é estrito: campos desconhecidos são rejeitados. Todo arquivo passa por validação antes de ser gravado, tanto em `init` quanto em `config`.

## Campos

| Campo | Tipo | Regra | Padrão (`config/default.json`) |
|---|---|---|---|
| `schemaVersion` | número | Exatamente `1` | `1` |
| `workspace` | texto | `^[a-z][a-z0-9-]{0,40}$` | `jev-suite` |
| `project` | texto | `^[a-z][a-z0-9-]{0,40}$` | `jev-memory-suite` |
| `controlPort` | inteiro | 1024 a 65535 | `18877` |
| `memory.enabled` | booleano | — | `true` |
| `memory.port` | inteiro | 1024 a 65535 | `49375` |
| `gateway.enabled` | booleano | — | `false` |
| `gateway.port` | inteiro | 1024 a 65535 | `18878` |
| `gateway.upstreamUrl` | URL | HTTPS, ou `http://127.0.0.1`; sem credenciais, query ou fragmento; host na allowlist | `https://api.openai.com/v1` |
| `gateway.jevUrl` | URL | Mesmas regras de `upstreamUrl` | `https://api.typesafe.ai/v1/systemone` |
| `gateway.allowedHosts` | lista | 1 a 16 itens, cada um `^[a-z0-9.-]+$` | `["api.openai.com", "api.typesafe.ai"]` |
| `gateway.upstreamKeyEnv` | texto | `^JMS_[A-Z0-9_]{1,60}$` | `JMS_UPSTREAM_KEY` |
| `gateway.jevKeyEnv` | texto | `^JMS_[A-Z0-9_]{1,60}$` | `JMS_JEV_KEY` |

## Regras globais

- As três portas `controlPort`, `memory.port` e `gateway.port` devem ser distintas, mesmo quando um serviço estiver desabilitado.
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
  "memory": { "enabled": true, "port": 49375 },
  "gateway": {
    "enabled": false, "port": 18878,
    "upstreamUrl": "https://api.openai.com/v1",
    "jevUrl": "https://api.typesafe.ai/v1/systemone",
    "allowedHosts": ["api.openai.com", "api.typesafe.ai"],
    "upstreamKeyEnv": "JMS_UPSTREAM_KEY", "jevKeyEnv": "JMS_JEV_KEY"
  }
}
```

Observação: as URLs padrão do Gateway apontam para terceiros. Elas só são usadas quando `gateway.enabled` for `true`.
