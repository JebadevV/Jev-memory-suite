# Configuração

Propósito: explicar como alterar o `suite.json` de um perfil, habilitar o Gateway, ajustar portas e criar perfis novos. Público: operadores. Data: 2026-10-21.

Os campos e limites estão em [schema de configuração](../api/configuration-schema.md). Este guia descreve os procedimentos.

## Alterar a configuração

`config` substitui o `suite.json` inteiro pelo arquivo informado. Por isso o arquivo deve conter todos os campos.

1. Pare o perfil: `node bin/jev-memory.mjs --profile <nome> stop`.
2. Crie um arquivo JSON completo **dentro do repositório** (por exemplo, `config/<nome>.json`).
3. Aplique: `node bin/jev-memory.mjs --profile <nome> config config/<nome>.json`.
4. Inicie: `node bin/jev-memory.mjs --profile <nome> start`.

`config` recusa a operação se o perfil estiver em execução e recusa arquivos fora do repositório ou que passem por links.

## Habilitar o Jev Gateway

1. Defina no ambiente as variáveis cujos **nomes** estão em `gateway.upstreamKeyEnv` (padrão `JMS_UPSTREAM_KEY`) e `gateway.jevKeyEnv` (padrão `JMS_JEV_KEY`). Os valores não devem ser gravados em arquivo.
2. Defina `"gateway": { "enabled": true, ... }` no `suite.json` por `config`.
3. Ajuste `upstreamUrl`, `jevUrl` e `allowedHosts` para os provedores que você usa. Os padrões apontam para terceiros.
4. Inicie. Se alguma das variáveis faltar, `start` recusa com `Gateway requires the two configured JMS_* key environment variables`.

Ao habilitar o Gateway, o conteúdo das requisições de modelo passa por ele e pelos provedores configurados. Antes de habilitar, verifique os termos desses provedores (veja [LGPD](../security/lgpd.md)).

O roteamento Jev é ligado com `JEV_ROUTING=true` e `JEV_SHADOW=false`. Essas flags são definidas pela suíte e não são configuráveis em `suite.json`.

## Portas

Cada perfil precisa de três portas distintas, entre 1024 e 65535. Um perfil novo copia os padrões (18877, 49375 e 18878). Se o perfil `default` estiver ativo, o novo perfil recebe conflito e não inicia.

Exemplo de arquivo para outro perfil, com portas de exemplo:

```json
{
  "schemaVersion": 1,
  "workspace": "jev-suite",
  "project": "meu-projeto",
  "controlPort": 28877,
  "memory": { "enabled": true, "port": 29375 },
  "gateway": {
    "enabled": false, "port": 28878,
    "upstreamUrl": "https://api.openai.com/v1",
    "jevUrl": "https://api.typesafe.ai/v1/systemone",
    "allowedHosts": ["api.openai.com", "api.typesafe.ai"],
    "upstreamKeyEnv": "JMS_UPSTREAM_KEY", "jevKeyEnv": "JMS_JEV_KEY"
  }
}
```

## Criar um perfil novo

1. `node bin/jev-memory.mjs --profile <nome> init`
2. Ajuste as portas com `config`, como acima. Não inicie antes disso.
3. `node bin/jev-memory.mjs --profile <nome> start`

Para o `install`, não é preciso repetir a compilação: os motores são compartilhados por todos os perfis.

## Configuração padrão da memória

Na primeira execução com um diretório de dados novo, a suíte grava estes valores em `memory/config.toml`:

| Ajuste | Valor | Efeito |
|---|---|---|
| `embedding_provider` | `none` | Nenhum provedor de embeddings; nenhum dado sai para embeddings |
| `backfill_on_start` | `false` | Não importa histórico ao iniciar |
| Decaimento (`lambda`, `cold_threshold`) | `0.0` | Decaimento desligado |
| `hard_delete_after_days` | `4294967295` | Sem exclusão automática |
| `require_approval` (melhoria automática) | `true` | Mudanças exigem aprovação |
| Agendador | `enabled = false` | Sem tarefas automáticas |
| `[maintenance]` | `enabled = false` | Manutenção desligada |

Sem decaimento, a memória é retida por tempo indefinido. Definir uma política de retenção é responsabilidade do operador. Veja [LGPD](../security/lgpd.md).
