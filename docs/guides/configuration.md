# Configuração

Propósito: explicar como alterar o `suite.json` de um perfil, habilitar a busca semântica local ou desligá-la, habilitar o Gateway, ajustar portas e criar perfis novos. Público: operadores. Data: 2026-10-22.

Os campos e limites estão em [schema de configuração](../api/configuration-schema.md). Este guia descreve os procedimentos.

## Alterar a configuração

`config` substitui o `suite.json` inteiro pelo arquivo informado. Por isso o arquivo deve conter todos os campos.

1. Pare o perfil: `node bin/jev-memory.mjs --profile <nome> stop`.
2. Crie um arquivo JSON completo **dentro do repositório** (por exemplo, `config/<nome>.json`).
3. Aplique: `node bin/jev-memory.mjs --profile <nome> config config/<nome>.json`.
4. Inicie: `node bin/jev-memory.mjs --profile <nome> start`.

`config` recusa a operação se o perfil estiver em execução e recusa arquivos fora do repositório ou que passem por links.

## Busca semântica local

Por padrão, `memory.semanticSearch` é `true`. Nesse modo, o motor de memória gera vetores com o modelo all-MiniLM-L6-v2, dentro do próprio processo, e nenhum texto sai da máquina. A suíte verifica o modelo por sha256 antes de cada `start`. Veja [ADR 0007](../architecture/adr/0007-local-semantic-memory.md) e [instalação](installation.md#modelo-de-embeddings).

Para desligar a busca vetorial e deixar só a busca léxica:

1. Pare o perfil: `node bin/jev-memory.mjs --profile <nome> stop`.
2. Edite o `suite.json` completo, com `"memory": { "enabled": true, "port": ..., "semanticSearch": false }`, e aplique com `config`.
3. Inicie: `node bin/jev-memory.mjs --profile <nome> start`.

No `start`, a linha `embedding_provider` do `config.toml` do perfil é sincronizada com o valor escolhido. Para voltar à busca semântica, repita o procedimento com `"semanticSearch": true`. Um provedor de embeddings que você tenha configurado manualmente no `config.toml` não é alterado pela suíte.

## Habilitar o Jev Gateway

1. Defina no ambiente as variáveis cujos **nomes** estão em `gateway.upstreamKeyEnv` (padrão `JMS_UPSTREAM_KEY`) e `gateway.jevKeyEnv` (padrão `JMS_JEV_KEY`). Os valores não devem ser gravados em arquivo.
2. Defina `"gateway": { "enabled": true, ... }` no `suite.json` por `config`.
3. Ajuste `upstreamUrl`, `jevUrl` e `allowedHosts` para os provedores que você usa. Os padrões apontam para terceiros.
4. Inicie. Se alguma das variáveis faltar, `start` recusa com `Gateway requires the two configured JMS_* key environment variables`.

Ao habilitar o Gateway, o conteúdo das requisições de modelo passa por ele e pelos provedores configurados. Antes de habilitar, verifique os termos desses provedores (veja [LGPD](../security/lgpd.md)).

No gateway da suíte (`gateway.enabled`), o roteamento Jev é ligado com `JEV_ROUTING=true` e `JEV_SHADOW=false`. Essas flags são fixas pela suíte. Nos gateways iniciados pelo launcher upstream, o modo é escolhido por `gatewayExperiment` (ver abaixo).

## Experimento de roteamento e preços

Os campos abaixo controlam o modo do roteamento Jev e os custos estimados do histórico no painel. Todos são opcionais: perfis antigos continuam válidos com os padrões. Para alterá-los, siga o procedimento de [alterar a configuração](#alterar-a-configuração).

### Experimento por cliente

`gatewayExperiment.claude` e `gatewayExperiment.codex` (padrão `default`):

| Modo | Variáveis definidas no roteador | Efeito |
|---|---|---|
| `default` | nenhuma | Comportamento do upstream |
| `shadow` | `JEV_ROUTING=true`, `JEV_SHADOW=true` | O Jev decide e a decisão é registrada, sem ser aplicada |
| `metering` | `JEV_ROUTING=false`, `JEV_SHADOW=false` | Sem chamadas ao Jev. Serve de referência para comparar |

```json
"gatewayExperiment": { "claude": "metering", "codex": "default" }
```

O interruptor de roteamento da página original do gateway não altera este modo. O modo vale quando o roteador inicia. O launcher reutiliza um roteador que já está em execução, então, para trocar o modo de um cliente, pare o gateway desse cliente com `node bin/jev-memory.mjs claude --stop` e inicie de novo. O procedimento completo está em [otimização de tokens](token-optimization.md#procedimento-de-experimento).

### Preços para custo estimado

`observability.pricing` guarda os preços que o painel usa para estimar custo. **Não há preço padrão.** Sem preço configurado, o painel mostra o custo como não configurado, e o campo `missing` diz o que falta.

Preencha cada modelo com valores da **página oficial de preços do provedor**, registrando a fonte e a data de verificação:

1. Abra a página oficial de preços do provedor do modelo.
2. Anote, por milhão de tokens, a entrada, a leitura de cache, a gravação de cache e a saída.
3. Em `source`, registre a URL ou o nome do documento. Em `verifiedAt`, a data em que você conferiu (`AAAA-MM-DD`).
4. Pare o perfil, aplique com `config` e inicie.

Os campos de preço são números. Os marcadores `<...>` do exemplo abaixo não são aceitos pelo schema: substitua cada um antes de aplicar. Não copie zeros como se fossem preços.

```json
"observability": {
  "pricing": {
    "models": {
      "<modelo, por exemplo claude-opus-5-5>": {
        "inputPerMTok": "<preço oficial de entrada>",
        "cacheReadPerMTok": "<preço oficial de leitura de cache>",
        "cacheWritePerMTok": "<preço oficial de gravação de cache>",
        "outputPerMTok": "<preço oficial de saída>",
        "currency": "USD",
        "source": "<URL ou nome da página oficial de preços>",
        "verifiedAt": "<AAAA-MM-DD da verificação>"
      }
    },
    "jev": {
      "inputPerMTok": 0.042,
      "outputPerMTok": "<preço de saída, a preencher a partir da fonte>",
      "currency": "USD",
      "source": "upstream/jev-gateway/src/dashboard.html:158 (JEV_USD_PER_MILLION_INPUT_TOKENS, v0.5.1)",
      "verifiedAt": "2026-10-22"
    }
  }
}
```

O valor 0,042 USD por milhão de tokens de entrada do Jev é o que o próprio upstream exibe (`dashboard.html`, linha 158). Ele não foi confirmado contra o provedor, por isso o `source` aponta para o upstream. O preço de saída do Jev não tem valor de referência neste projeto: preencha com a fonte oficial. Se não houver fonte, omita o objeto `jev` inteiro, porque o schema exige `outputPerMTok` dentro dele. Como o upstream não registra tokens de saída do Jev, o custo do Jev nunca inclui saída.

Os custos são **estimativas de preço de API**, calculadas a partir das contagens. Não são cobrança de assinatura e não são economia confirmada.

## Portas

Cada perfil precisa de cinco portas distintas, entre 1024 e 65535: `controlPort`, `memory.port`, `gateway.port`, `dashboard.port` e `headroom.port`. Um perfil novo copia os padrões (18877, 49375, 18878, 18879 e 18880). Se o perfil `default` estiver ativo, o novo perfil recebe conflito e não inicia.

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
| `embedding_provider` | `local` (com `memory.semanticSearch` em `true`) | Embeddings locais no processo do motor; nenhum texto sai da máquina. Com `semanticSearch` em `false`, vale `none`. |
| `backfill_on_start` | `false` | Não importa sessões antigas ao iniciar. O backfill de embeddings das páginas roda à parte, a cada `start`. |
| Decaimento (`lambda`, `cold_threshold`) | `0.0` | Decaimento desligado |
| `hard_delete_after_days` | `4294967295` | Sem exclusão automática |
| `require_approval` (melhoria automática) | `true` | Mudanças exigem aprovação |
| Agendador | `enabled = false` | Sem tarefas automáticas |
| `[maintenance]` | `enabled = false` | Manutenção desligada |

Sem decaimento, a memória é retida por tempo indefinido. Definir uma política de retenção é responsabilidade do operador. Veja [LGPD](../security/lgpd.md).
