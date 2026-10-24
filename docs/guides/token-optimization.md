# Otimização de tokens

Propósito: registrar a auditoria de uso de tokens do Jev Gateway, o caminho de decisão do roteamento, o procedimento para medir com e sem Jev, o protocolo de teste do Ponytail, os achados sobre o harness de memória e a compressão opcional de contexto com o Headroom (Claude e Codex). Público: operadores e mantenedores. Data: 2026-10-24. Decisões associadas: [ADR 0011](../architecture/adr/0011-native-dashboard-and-token-observability.md), [ADR 0013](../architecture/adr/0013-headroom-context-compression.md) e [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md).

Este guia descreve o que foi medido e o que ainda não foi medido. Nenhuma configuração padrão foi alterada. As recomendações abaixo dependem de decisão do operador e de dados comparativos que ainda não existem.

## Resumo

- Em 2026-10-22, o Jev recebeu cerca de **304,6 M tokens de entrada** em **14.505 chamadas** (Claude e Codex somados). Medido nos logs de `~/.jev-gateway/`, somente com metadados.
- **Nenhuma chamada evitou o LLM.** O modo `direct` não apareceu nos logs. Economia não foi medida.
- **Não há período de referência com o roteamento desligado.** Por isso nenhuma afirmação de economia é feita aqui.
- O Claude opera quase sempre em modo `hint`, que nunca evita uma chamada ao LLM. A entrada do Jev no Claude é cerca de 120 vezes a entrada do LLM não descontada pelo cache (ver a tabela da auditoria).
- Custo do Jev a 0,042 USD por milhão de tokens de entrada (valor exibido pelo próprio upstream): **cerca de 12,8 USD** para os 304,6 M tokens. **Estimativa**, não cobrança confirmada.

## Auditoria de 2026-10-22

Evidência: `.local/evidence/jev-token-audit-2026-10-22.json`, `.local/evidence/jev-token-metrics-2026-10-22.txt` e `.local/evidence/unified-dashboard-status-2026-10-22.json`. Períodos: Claude de 2026-09-30 a 2026-10-22; Codex de 2026-09-22 a 2026-10-22.

| Métrica | Claude | Codex |
|---|---|---|
| Chamadas Jev com resposta | 7.440 | 7.065 |
| Erros do Jev | 598 | 408 |
| Tokens de entrada enviados ao Jev | 176,2 M | 128,4 M |
| Chamadas evitadas (`direct`) | 0 | 0 |
| Modos | `passthrough` 6.998; `hint` 1.167 | `passthrough` 5.815; `forced` 3.802; `none` 456 |
| Motivos principais | `low_confidence` 5.229; `no_tool_needed` 1.037; `jev_error` 598; `no_tools` 127 | `low_confidence` 2.726; `agent_message` 2.476; `jev_error` 408; `no_tools` 124; `namespaced_tool_selected` 75 |
| Entrada do LLM | 2.761 M, sendo 2.719 M lidos do cache e 40,4 M gravados no cache | 1.363,5 M, sendo 1.288,8 M lidos do cache |
| Entrada do LLM não descontada pelo cache | cerca de 1,43 M | cerca de 74,7 M |
| Ferramentas por requisição | p50 84, máximo 144 | até 13 |
| Latência do Jev (p50 / p90) | 426 ms / 551 ms | 423 ms / 1.121 ms |
| Tempo de bloqueio somado (requisições sem shadow) | cerca de 3.210 s | cerca de 3.907 s |
| Leitura do cache no total | 98,4% | 94,5% |

Leitura dos números:

- A entrada do Jev no Claude (176,2 M) é cerca de 120 vezes a entrada não descontada do LLM (cerca de 1,43 M). O Jev reenvia o estado da conversa em cada requisição, sem cache, e o Claude Code já envia `cache_control`, o que faz o gateway usar apenas a dica (`hint`) e não alterar `tool_choice`.
- No Codex, a entrada do Jev (128,4 M) é maior que a entrada não descontada do LLM (74,7 M). A comparação é necessária antes de concluir qualquer coisa.
- A latência do Jev não é desprezível: cerca de 0,43 s por chamada no p50, somados a cada requisição que espera a decisão.
- Jev por chamada: cerca de 23,7 mil tokens no Claude e cerca de 18,2 mil no Codex. A causa é o estado da conversa (até `JEV_MAX_STATE_CHARS`, 60.000 caracteres) somado às descrições de ferramentas (até 48.000 caracteres pelo orçamento `QUESTION_CHAR_BUDGET`). Os esquemas de ferramenta sozinhos não explicam o volume.

### Por modelo

Valores do relatório de auditoria: requisições, entrada do Jev, entrada do LLM não descontada pelo cache e decisões.

| Modelo | Requisições | Entrada do Jev | Entrada do LLM não descontada | Decisões |
|---|---|---|---|---|
| claude-opus-5-5 | 6.142 | 137 M | 0,53 M | 828 `hint` |
| claude-haiku-5-5 | 1.480 | 26,4 M | 0,63 M | 235 `hint` |
| claude-sonnet-5-5 | 628 | 14,8 M | 0,35 M | 116 `hint` |
| claude-haiku-4-5-20251001 | 59 | 0,6 M | cerca de 0 | não informado |
| gpt-6.1-sol | 6.015 | 72,4 M | 45,15 M | 1.692 `forced`, 321 `none` |
| gpt-6-sol | 2.532 | 47 M | 16,13 M | 1.747 `forced` |
| gpt-6-luna | 870 | 0,1 M | 2,88 M | quase todas `passthrough` |
| gpt-5.6-sol | 315 | 4,9 M | 2,19 M | não informado |
| gpt-5.6-terra | 266 | 3,2 M | 1,71 M | não informado |
| gpt-5.6-luna | 43 | 0 | 6,49 M | não informado |
| gpt-6-astra | 32 | 0,6 M | 0,17 M | não informado |

### Nota sobre a tabela por modelo

A tabela por modelo foi medida minutos depois do total, com o log ainda crescendo por tráfego ao vivo. Pequenas diferenças em relação aos totais vêm disso.

- Codex: a soma da entrada do Jev por modelo é 128,2 M (total 128,4 M). A soma da entrada não descontada é 74,7 M (total 74,7 M).
- Claude: a soma da entrada do Jev por modelo é 178,8 M (total 176,2 M). A entrada não descontada total é 1.433.621 tokens, calculada como 2.761.186.470 − 2.719.384.578 − 40.368.271.
### Métricas que o gateway não registra

- **Tokens de saída do Jev** não são registrados pelo upstream. O painel mostra "não registrado", e a estimativa de custo lista `jev-output-tokens` em `missing`.
- **Chamadas evitadas** só podem ser contadas no modo `direct`. Nas sessões auditadas, esse modo não ocorreu.

## Caminho de decisão do roteamento

O roteador do upstream decide por requisição se a chamada vai ao LLM sem mudança (`passthrough`), se recebe uma dica no fim da conversa (`hint`), se recebe escolha forçada de ferramenta (`forced`) ou se nada é feito (`none`). Referências no código do upstream, em `upstream/jev-gateway/src/`:

| Etapa | Arquivo e linha | Efeito |
|---|---|---|
| Pulo antes do Jev | `decide.ts:58` (`skipReason`) | Retorna `passthrough` com `no_messages`, `no_tools`, `too_many_tools`, `unsafe_tool_name`, `duplicate_tool_names`, `reserved_tool_name` ou `tool_choice_already_decided` |
| Contexto incompleto | `decide.ts:131` | `passthrough` com `incomplete_routing_context` quando `buildState` não consegue representar a conversa |
| Confiança mínima | `decide.ts:171` | `passthrough` com `low_confidence` quando a confiança do Jev fica abaixo de `minConfidence` |
| Dica ou escolha forçada (Claude) | `adapters/messages.ts:92-99` | Se a requisição tem `cache_control` ou pensamento estendido, usa `hint`; caso contrário, `tool_choice` |
| Dica no fim da conversa | `adapters/messages.ts:115-122` | Acrescenta um bloco de dica à última mensagem, sem alterar `tool_choice`, para não invalidar o cache |
| Pulo no Responses (Codex) | `adapters/responses.ts:104` | `previous_response_id` gera `passthrough` com `previous_response_id` |
| Pulo de mensagens de agente | `adapters/responses.ts:107` | `agent_message` gera `passthrough` com `agent_message` |
| Montagem do estado | `state.ts:79` (`buildState`) e `state.ts:127-142` | Mantém metadados e um sufixo contíguo de grupos completos; respeita `maxStateChars` e marca o corte |
| Limite do estado | `config.ts:119` | `JEV_MAX_STATE_CHARS`, padrão 60.000 |
| Limite por mensagem | `config.ts:120` | `JEV_MAX_MESSAGE_CHARS`, padrão 4.000 |
| Orçamento de ferramentas | `questions.ts:20` (`QUESTION_CHAR_BUDGET` = 48.000) e `questions.ts:74` | Descrição de cada ferramenta limitada a `min(MAX_DESCRIPTION_CHARS, orçamento / número de ferramentas)` |
| Fragmentação de ferramentas | `questions.ts:14` (`MAX_TOOLS` = 120) | Mais de 120 ferramentas são divididas em fragmentos |
| Tempo limite do Jev | `jev.ts:105` e `config.ts:112` | `AbortSignal.timeout(jevTimeoutMs)`, padrão `JEV_TIMEOUT_MS` = 4.000 ms |
| Uma nova tentativa | `jev.ts:116-125` | Uma única nova tentativa após 100 ms para status repetíveis; depois disso, a falha encaminha a requisição ao LLM (`jev_error`) |

Como ler: `hint` e `forced` são decisões sobre a chamada ao LLM. No Claude, a dica não remove a chamada ao LLM, então o Jev só acrescenta entrada e latência. Essa é a razão principal para medir o modo `metering` antes de qualquer ajuste.

## Procedimento de experimento

O objetivo é obter um período de referência com o roteamento desligado, para comparar tokens, latência e resultado com o período de roteamento ligado. A configuração é por cliente, em `gatewayExperiment` (ver [configuração](configuration.md#experimento-de-roteamento-e-preços)).

Modos:

- `default`: não define variáveis. Vale o comportamento do upstream.
- `shadow`: `JEV_ROUTING=true` e `JEV_SHADOW=true`. O Jev decide e a decisão é registrada, mas não é aplicada. Serve para comparar a decisão com o resultado do LLM.
- `metering`: `JEV_ROUTING=false` e `JEV_SHADOW=false`. O Jev não é chamado. É a referência sem roteamento.

Passos:

1. Escreva a configuração completa com o novo `gatewayExperiment` e pare o perfil: `node bin/jev-memory.mjs --profile <nome> stop`.
2. Aplique com `node bin/jev-memory.mjs --profile <nome> config <arquivo.json>` e inicie com `node bin/jev-memory.mjs --profile <nome> start`.
3. A variável só vale quando o roteador inicia. O lançador reutiliza um roteador que já está em execução. Para trocar o modo de um cliente, pare o gateway desse cliente com `node bin/jev-memory.mjs claude --stop` (ou `codex --stop`) e inicie de novo pelo lançador, `node bin/jev-memory.mjs claude` (ou `codex`).
4. Confirme o modo com `experiment` e `router` em `GET /gateways/status`, e com `node bin/jev-memory.mjs claude --status`.
5. Use o mesmo modo durante todo o período de medição. Anote a data de início e de fim.
6. Compare os períodos pela seção de observabilidade de tokens (entrada, cache, custo estimado e comparação com e sem Jev) e pela página original do gateway, que mostra os eventos retidos. Use o mesmo intervalo de datas e, quando possível, a mesma quantidade de requisições.

O interruptor de roteamento da página original altera o processo em execução, mas não substitui `gatewayExperiment`: o modo volta ao configurado quando o roteador reinicia.

Regras:

- Para o Claude, comece pelo `metering` por um período comparável. Sem isso, não há como estimar o que o Jev acrescenta.
- Para o Codex, compare `forced` com a referência por modelo. A tabela por modelo do painel serve para isso.
- Não altere limiares (`minConfidence`, `JEV_MAX_STATE_CHARS`) durante a medição. Qualquer mudança invalida a comparação.
- Os números de custo só valem se os preços forem preenchidos a partir da fonte oficial do provedor (ver [configuração](configuration.md#experimento-de-roteamento-e-preços)).

Recomendações ainda **não aplicadas**, que exigem decisão do usuário e dados comparativos:

- Rodar o Claude em `metering` por um período comparável, para obter a referência.
- Para o Codex, comparar `forced` com a referência por modelo.
- Reduzir `JEV_MAX_STATE_CHARS` somente depois de comparar o `shadow` com o resultado.

## Protocolo de benchmark do Ponytail

O Ponytail (plugin 5.3.2) está habilitado neste projeto (`.claude/settings.json`) e na configuração global do plugin. Ele injeta guia por hooks `SessionStart` e `SubagentStart` (cerca de 3,5 KB de `SKILL`) e tem um rastreador de modo em `UserPromptSubmit`. A opção de registro grava `~/.config/ponytail/band/<projeto>.csv`. Não está integrado ao Jev. A orientação de KISS e YAGNI repete parte de `~/.claude/rules/ecc/coding-style.md`. Nenhuma instalação, remoção ou reconfiguração foi feita.

Este protocolo ainda **não foi executado**. Ele existe para decidir, com dados, se o Ponytail e o Jev compensam o custo que adicionam.

Desenho:

- **Quatro braços em 2×2:** Jev ligado ou desligado, Ponytail ligado ou desligado. Um braço adicional, **shadow**, com Jev ligado em modo `shadow`.
- **Mesmo conjunto de tarefas** em todos os braços: um commit fixo do repositório, com pelo menos **20 tarefas por braço**, em ordem aleatória.
- **Mesmos modelos** em cada braço.
- **Sessões novas** para cada tarefa, com política fixa de aquecimento do cache, documentada antes do início.
- **Métricas** vindas do painel e dos logs: entrada não descontada, leitura e gravação de cache, saída, entrada do Jev, latência do Jev, sucesso (testes que passam), e qualidade das chamadas de ferramenta.
- **Execuções pagas** só com aprovação de orçamento. O custo do protocolo não foi estimado.

Critério de decisão: o braço só é considerado melhor se reduzir o custo sem queda de sucesso nas tarefas. Um resultado de sucesso menor, mesmo com custo menor, não é melhoria.

## Achados sobre o harness de memória

Todos os números são medidos, salvo quando indicado como estimativa.

- **Servidor MCP da memória:** `tools/list` retorna 24 ferramentas, com cerca de 64,9 mil caracteres. Desses, 37,5 mil são esquemas e 22,7 mil são descrições. As maiores são `memory_query` e `memory_write_page`. Estimativa: cerca de 16 mil tokens (4 caracteres por token).
- **Exposição no Claude Code:** o Claude Code carrega ferramentas MCP sob demanda (ToolSearch), então elas não entram em toda requisição.
- **Exposição no Codex:** as requisições roteadas tinham no máximo 13 ferramentas. As 24 ferramentas de memória não aparecem como declarações de nível superior, porque no Codex o MCP roda em code mode: o modelo descobre as ferramentas pelo `ALL_TOOLS` e as chama de dentro do `exec` como `tools.mcp__jev_memory_suite__<ferramenta>(...)`. Por isso os esquemas não viajam em toda requisição; eles entram no contexto quando o modelo consulta `ALL_TOOLS` ou chama uma ferramenta. Validado ao vivo no H5 (2026-10-23), com e sem Headroom. Não houve mudança na exposição.
- **Regras globais:** cerca de 16,8 KB (cerca de 4,2 mil tokens, estimativa) em `~/.claude/rules/ecc`, carregadas em cada sessão.
- **Lista de skills do plugin ECC:** presente em cada sessão. O tamanho não foi medido com precisão.
- **Handoff de início de sessão:** cerca de 2 KB.
- **Handoff automático de baixo valor:** foi observado um handoff que gravou o prompt do resumidor, em vez de um resumo. Comportamento do motor, não alterado.
- **Cache:** a leitura de cache representa 98,4% da entrada no Claude e 94,5% no Codex. O contexto do harness é quase todo lido do cache. Seu custo principal aparece como entrada do Jev, que reenvia o estado sem cache.
- **Sem mudança:** a busca semântica local e o isolamento de projeto não foram alterados.

## Headroom (opcional, Claude)

O Headroom é um proxy externo de compressão de contexto. É opcional e fica desligado por padrão. Quando ligado, o Claude passa por ele antes do gateway Jev claude: Claude Code → Headroom → Jev → Anthropic. Ele reduz sobretudo o JSON das saídas de ferramenta e não altera o prompt de sistema nem as mensagens anteriores. A fase 1 cobre o Claude; o Codex entra na fase 2, opcional, descrita em [Headroom com Codex](#headroom-com-codex-opcional). A suíte não incorpora o Headroom: ele é instalado pelo operador e executado pela suíte. Decisão e alternativas rejeitadas em [ADR 0013](../architecture/adr/0013-headroom-context-compression.md).

### Como ligar

1. Instale o Headroom 0.41.0 com uv. O padrão do uv é `~/.local/bin`; o executável também pode estar em outro lugar do PATH.
2. Confirme a versão: `headroom --version` deve imprimir `headroom, version 0.41.0`.
3. Pare o perfil: `node bin/jev-memory.mjs --profile <nome> stop`.
4. Copie o `suite.json` completo do perfil (`.local/profiles/<nome>/suite.json`) para `config/<nome>.json`, dentro do repositório, e acrescente o bloco `headroom`:

```json
"headroom": { "enabled": true, "port": 18880, "version": "0.41.0", "executable": "<caminho absoluto de headroom.exe>" }
```

No JSON, use barras normais (`C:/...`) ou barras invertidas escapadas (`C:\\...`).

5. Aplique e inicie: `node bin/jev-memory.mjs --profile <nome> config config/<nome>.json`, depois `node bin/jev-memory.mjs --profile <nome> start`.
6. Confirme: `node bin/jev-memory.mjs --profile <nome> doctor` (bloco `headroom` com `detected.ok: true`) e `node bin/jev-memory.mjs --profile <nome> status` (`services.headroom: "ready"`).
7. Use: `node bin/jev-memory.mjs --profile <nome> claude`. Se não aparecer `Headroom not used` em stderr, o Claude passou pelo Headroom.

Notas:

- `executable` é opcional, mas recomendado: sem ele, o primeiro `headroom` do PATH é usado (T40).
- `config` substitui o `suite.json` inteiro, então o arquivo precisa conter todos os campos. O arquivo não deve conter chaves de API, só nomes de variáveis.
- Para desligar, pare o perfil e grave `headroom.enabled: false` pelo mesmo procedimento. Para uma execução só, use `JMS_HEADROOM=off`. Ver [operação](../runbooks/operations.md#headroom-claude).

### O que foi medido

Medido com Claude Code real (login OAuth), passando pelo Headroom, depois por um Jev isolado e um provedor simulado local. Nenhuma chamada paga foi feita.

| Cenário | Resultado |
|---|---|
| Esquemas de ferramentas, em cada requisição do Claude | −337 tokens (cerca de 2,5%). Remove `$schema` e colapsa quebras de linha nas descrições. Prompt de sistema e mensagens não mudam. |
| Leitura de arquivo (`Read`) e `cat` pelo Bash | Não comprimidos (0%). O Headroom protege leituras de arquivo por desenho. |
| Comando Bash que imprime 25 KB de JSON | Requisição −23% (23.249 → 17.910 tokens estimados). Resultado da ferramenta −65%. As 120 linhas e as 3 linhas ERROR foram mantidas (JSON recodificado como tabela). |
| Resultado de ferramenta de 167 KB, enviado direto | 73.826 → 36.251 tokens (−51%). 800/800 linhas mantidas, sem perda. |
| Decisão do Jev | Cerca de −0,5% de tokens. O Jev já limita cada mensagem a 4.000 caracteres. |
| Opção `--lossless` | Nenhuma economia nesses testes. |
| `--mode cache --no-ccr` | Mesma economia que o modo CCR padrão. |
| Latência | +3 a 50 ms por requisição com o processo aquecido; primeira requisição de 0,3 a 0,5 s; primeira fria, 4,4 s. |
| Memória (RAM) | Headroom de 420 a 585 MB; Jev, 61 MB. |

Leitura:

- O Claude Code trunca saídas grandes de Bash (cerca de 30 mil caracteres). Texto truncado não é JSON válido e não é comprimido, então não há ganho nesses casos.
- A economia real depende de quanto JSON, MCP ou log a sessão carrega. **Estimativa, não medida:** cerca de 0 a 5% em sessões dominadas por Read e Edit, e 20 a 50% em sessões intensas em JSON, MCP ou log.
- A cobertura automatizada é `npm run test:headroom` (7 verificações, veja [desenvolvimento](development.md)). Evidência: `.local/evidence/headroom-e2e.json`.

### Limites do Headroom

- **Codex só com `headroom.codex`.** Sem essa opção, o Codex não passa pelo Headroom. Com login ChatGPT, o Headroom 0.41.0 envia `/responses`, `/responses/*`, WebSocket e `/models` direto a chatgpt.com. A fase 2 contorna isso com um shim de runtime, descrito em [Headroom com Codex](#headroom-com-codex-opcional). O Antigravity não tem integração de proxy.
- **Kompress não é usado.** A compressão de prosa e código com modelo precisaria baixar o modelo, e `HEADROOM_OFFLINE` bloqueia o download. O CCR também fica desligado (`--no-ccr`). `HEADROOM_LOSSLESS_ONLY=1` (definida pela suíte) liga o modo estrito do SmartCrusher: a compactação tabular sem perda continua, mas nenhum item de array JSON é descartado sem marcador. Sem ela, com `--no-ccr`, o SmartCrusher descartava itens sem aviso (24 → 11 no teste offline). A flag `--lossless` não serve: desliga a compactação tabular e não economizou nada.
- **Sem fallback durante a sessão.** Antes de o Claude iniciar, qualquer falha leva ao caminho original. Depois disso, se o Headroom cair, o supervisor o reinicia (até 3 vezes em 60 s) e as requisições falham nesse intervalo.
- **Custo real não medido.** A taxa de acerto do cache no provedor e o custo em dinheiro exigem chamadas pagas. Este guia não traz número de economia de custo.
- **Executável pelo PATH.** Sem `headroom.executable`, outro `headroom` no PATH pode ser usado. A versão exata é conferida, mas não há verificação de hash (T40).
- **Memória do processo.** O Headroom vê prompts e o bearer OAuth do Claude na memória, em loopback, com o mesmo nível de confiança do Jev Gateway (T38). Riscos T38 a T46 estão em [modelo de ameaças](../security/threat-model.md).

## Headroom com Codex (opcional)

Com `headroom.codex: true`, o Codex passa pelo mesmo processo Headroom do Claude: Codex → Headroom → Jev codex (`codexUpstreamPort`, padrão 8790) → ChatGPT ou OpenAI. O Jev não muda. Decisão, alternativas e riscos estão na [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md). A operação está no [runbook](../runbooks/operations.md#headroom-com-codex).

Motivo: com login ChatGPT, o Headroom 0.41.0 envia `/responses`, `/responses/*`, WebSocket e `/models` direto a chatgpt.com, e esse tráfego ignora o Jev. A suíte aponta essas rotas ao gateway Jev codex com um shim de runtime versionado, sem editar a instalação do Headroom. Detalhes em [patches do Headroom](../../patches/headroom/README.md).

### Como ligar

1. Confirme o Headroom 0.41.0 instalado com uv, como no Claude.
2. Localize o interpretador do ambiente `headroom-ai`. Com `uv tool dir`, é `<diretório>\headroom-ai\Scripts\python.exe` no Windows. Se ele não estiver em um dos diretórios de uv pesquisados, grave o caminho absoluto em `headroom.python`.
3. Confira o shim antes de iniciar. Use a porta do gateway Jev codex (`JEV_CODEX_PORT`, padrão 8790):

```powershell
$env:HEADROOM_CHATGPT_CODEX_BASE_URL = 'http://127.0.0.1:8790/v1'
& '<caminho absoluto de python.exe do headroom-ai>' -I patches\headroom\0.41.0\jms_headroom_shim.py --check
```

A saída é uma linha JSON com `"ok":true`. Os códigos de erro estão em [solução de problemas](troubleshooting.md#codex).

4. Pare o perfil e grave o bloco `headroom` com `config`:

```json
"headroom": { "enabled": true, "port": 18880, "version": "0.41.0", "executable": "<caminho absoluto de headroom.exe>", "codex": true, "python": "<caminho absoluto de python.exe do headroom-ai>" }
```

`python` pode ser omitido quando o interpretador está em um dos diretórios pesquisados (`UV_TOOL_DIR`, `uv tool dir` ou `%APPDATA%\uv\tools`).

5. Aplique e inicie, como no Claude.
6. Confirme: `doctor` (`headroom.codex.active: true` e `headroom.codex.python.ok: true`) e `status` (`headroom.codex: true`, com `codexUpstreamPort` igual à porta do Jev codex e sem `headroomCodexReason`).
7. Use: `node bin/jev-memory.mjs --profile <nome> codex`, ou `jev-memory-codex`. Se não aparecer `Headroom not used` em stderr, o Codex passou pelo Headroom.

### Como funciona

- O supervisor inicia o Headroom com o interpretador do `headroom-ai`, o shim e `HEADROOM_CHATGPT_CODEX_BASE_URL=http://127.0.0.1:<porta do Jev codex>/v1`. Para chave de API, o Headroom também recebe `--openai-api-url` com a mesma porta.
- O shim reatribui as URLs do Codex ao gateway, bloqueia conexões fora do loopback e faz autoteste antes de passar o controle ao CLI do Headroom. Nenhum arquivo instalado é alterado.
- O launcher `jev-memory-codex` inicia o `codex` diretamente, com as sobrescritas do provedor upstream apontando para o Headroom. Se alguma verificação falhar, o Codex segue pelo caminho original, com `Headroom not used` em stderr.
- Se o modo Codex falhar, o Claude continua no Headroom. `headroomCodexReason` mostra o motivo.

### Validação

`npm run test:headroom-codex` passou em 11/11, com Headroom 0.41.0 real pelo shim, Jev codex real, backend ChatGPT simulado e JWT falso. O teste cobre:

- streaming com `Authorization` e `ChatGPT-Account-ID` sem alteração;
- resultado de ferramenta reduzido de 27.883 para 11.430 bytes, com 120/120 ids e 3/3 linhas ERROR mantidas;
- prefixo dos turnos anteriores idêntico byte a byte;
- `/models` pelo Jev, caminho de chave de API e WebSocket só pelo Jev;
- nenhuma tentativa a chatgpt.com, e nenhum JWT, account id, chave ou canário nos logs;
- estado só no perfil, com `~/.headroom` inalterado, e rollback.

Os números de compressão vêm de backend simulado. Não são medição de economia nem de cobrança. Login ChatGPT real foi validado ao vivo em 2026-10-23 (H5), com medição de tokens de n=1; a cobrança real não foi medida.

### Limites do Codex

- Os hooks do Codex continuam exigindo confiança nativa em `/hooks`.
- Um processo Headroom por perfil atende Claude e Codex, com cerca de 600 a 700 MB de RAM.
- O guard de egress é do processo Python. Não é sandbox, e não cobre chamadas à API do SO fora do módulo `socket` (T44).
- O shim vale só para a versão 0.41.0. Outra versão exige nova pasta de patch; sem ela, o Codex segue pelo caminho direto (T43).
- As credenciais OAuth do Codex (JWT e `ChatGPT-Account-ID`) passam pelo processo do Headroom, em memória (T45).
- Kompress continua desligado.

## Limites deste documento

- Os dados são de duas semanas de uso real, sem período de referência. Não servem para estimar economia.
- A auditoria cobre metadados dos logs. Não há medição de qualidade das respostas.
- Os custos são estimativas de preço de API. Não representam o custo de uma assinatura.

Veja também: [ADR 0011](../architecture/adr/0011-native-dashboard-and-token-observability.md), [ADR 0013](../architecture/adr/0013-headroom-context-compression.md), [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md), [operação do painel](../runbooks/operations.md#painel-de-gateways), [modelo de ameaças](../security/threat-model.md) (T30 e T32) e [LGPD](../security/lgpd.md).
