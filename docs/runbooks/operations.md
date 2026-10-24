# Operação

Propósito: descrever a rotina de iniciar, parar, verificar, diagnosticar e reiniciar um perfil, com suas portas, logs, reinício automático e gateways. Público: operadores. Data: 2026-10-23.

Os comandos usam o perfil padrão. Para outro perfil, acrescente `--profile <nome>` logo após `node bin/jev-memory.mjs`.

## Rotina

| Ação | Comando | Resultado esperado |
|---|---|---|
| Iniciar | `node bin/jev-memory.mjs start` | Imprime JSON com `phase: "ready"` |
| Verificar | `node bin/jev-memory.mjs status` | `phase: "ready"` e `services` com `ready` |
| Diagnosticar | `node bin/jev-memory.mjs doctor` | Relatório sem segredos |
| Testar MCP | `node bin/jev-memory.mjs mcp` | `handshake: true` e `status` com o escopo |
| Parar | `node bin/jev-memory.mjs stop` | Serviços encerrados |
| Reiniciar | `node bin/jev-memory.mjs restart` | Parada seguida de início |

`recover` executa a mesma sequência que `restart` na implementação atual. Ele não faz diagnóstico nem reparo adicional. Para diagnosticar, use `doctor`.

## Estados do supervisor

| `phase` | Significado | Ação |
|---|---|---|
| `starting` | Filhos ainda sobem | Aguarde. `start` espera até cerca de 45 s. |
| `ready` | Serviços habilitados saudáveis | Normal. Um serviço pode estar `restarting` por instantes. |
| `failed` | Um filho falhou antes de ficar pronto, ou esgotou os reinícios automáticos | Veja [recuperação automática](#recuperação-automática). Leia os logs antes de `start`. |
| `stopping` | Parada em andamento | Aguarde |
| `stopped` (saída de `status`) | Nada escutando na porta de controle | Normal para perfil parado |
| `port-conflict` (saída de `status`, código 1) | Porta de controle ocupada por outro processo ou perfil | Veja [solução de problemas](../guides/troubleshooting.md) |

Estados dos serviços em `services`: `starting`, `ready`, `restarting`, `failed` e `stopped`. Só o serviço `headroom` pode estar também em `unavailable` (veja [Headroom](#headroom-claude)). `restarts` mostra quantas vezes cada serviço foi reiniciado automaticamente nesta execução.

## Recuperação automática

Um serviço que cai depois de `ready` é reiniciado pelo supervisor, no máximo 3 vezes em 60 s, com espera de 1 s, 2 s e 4 s.

- Durante a espera, `status` mostra o serviço como `restarting` e o contador em `restarts`. Não é preciso agir.
- Se o serviço voltar, `status` volta a `ready` e o contador fica registrado. Um contador que sobe a cada poucos minutos indica problema repetido: leia `logs/memory.log` ou `logs/gateway.log` antes de reiniciar.
- Se o orçamento de 3 reinícios se esgotar, o serviço e a fase vão para `failed` e o supervisor encerra sozinho. Em seguida, `status` deve mostrar `stopped`.

O que fazer após `failed`:

1. Rode `node bin/jev-memory.mjs doctor` e confira `supervisor` e `services`.
2. Leia `logs/supervisor.log` e o log do serviço que falhou (`memory.log` ou `gateway.log`). Identifique a causa, como porta ocupada, modelo ausente ou erro de configuração.
3. Corrija a causa. Não repita `start` em loop: ele reinicia a partir do mesmo estado.
4. Rode `node bin/jev-memory.mjs start`. Se falhar de novo com a mesma mensagem, pare e investigue; não aumente tentativas manualmente.

O próximo lançamento (`jev-memory-codex` ou `jev-memory-claude`) também sobe os serviços que estiverem parados.

## Gateways

`doctor` mostra em `gateways` o estado dos dois gateways upstream, o de claude (porta 8789) e o de codex (porta 8790). A forma completa está em [saída de doctor dos gateways](../api/cli.md#saída-de-doctor-gateways).

- Esses gateways são iniciados e parados pelo launcher upstream, não pela suíte. A suíte só consulta o estado. Para parar o gateway de um cliente, use o próprio launcher: `node bin/jev-memory.mjs codex --stop` ou `node bin/jev-memory.mjs claude --stop`, que repassam a opção ao launcher upstream.
- `running` indica que `/health` respondeu. `stopped` indica conexão recusada. `unavailable` indica falha da sonda ou timeout de 1 s; não diz a causa. Para ver o estado do launcher, use `--status` no mesmo comando.
- `conflicts` não vazio indica que uma porta de perfil coincide com a de um gateway upstream. Mude a porta do perfil com `config` (perfil parado) e repita `start`.
- Nunca use `kill` em PID de gateway. Use o `--stop` do launcher.

### Painel de gateways

No painel (`http://127.0.0.1:18879/`, ou a porta de `dashboard.port`), a página incorpora a página original do Jev Gateway em um único iframe. O agregador é o Codex, se estiver em execução; caso contrário, o Claude. A página original mostra os dois roteadores, com filtros, interruptores de roteamento, cartões e gráficos. Ela consulta os roteadores pelas portas configuradas, incluindo as de `?peers=`.

Abaixo do iframe, a seção de observabilidade de tokens mostra o histórico do log do launcher (`~/.jev-gateway/<cliente>.log`), por cliente e combinado, com a tabela por modelo, o custo estimado e a comparação com e sem Jev.

Sintomas e ações:

| Sintoma | Causa provável | Ação |
|---|---|---|
| Bloco "Gateways offline" no lugar do iframe | Nenhum gateway (claude nem codex) respondeu à sonda `/health` quando a página foi carregada | Inicie um gateway com `node bin/jev-memory.mjs codex` ou `claude` e recarregue o painel. Os comandos `jev-memory-codex` e `jev-memory-claude` também aparecem no bloco. |
| Aviso "O gateway mudou desde que esta página foi carregada" | O agregador mudou, por exemplo quando o Codex subiu ou caiu | Recarregue a página. O painel não recarrega sozinho, para não trocar o iframe enquanto você lê. |
| Gateway fora da porta padrão não aparece | A porta não chegou ao `?peers=` | Confira `JEV_CLAUDE_PORT` e `JEV_CODEX_PORT`. Portas inválidas usam o padrão (8789 e 8790) e aparecem como `portValid: false` em `/gateways/status`. |
| Painel com iframe antigo ou duas visões | O supervisor ou o navegador guardou a página anterior | Rode `node bin/jev-memory.mjs restart` e recarregue a página sem cache (Ctrl+F5). Deve haver um iframe com `data-aggregator` igual a `cliente:porta`. |

Para ver o gateway de um cliente sem o painel, use `node bin/jev-memory.mjs codex --status` ou `claude --status`. As páginas diretas `http://localhost:8790/dashboard` e `http://localhost:8789/dashboard` continuam acessíveis e não redirecionam.

### Alternar o roteamento

A alternância de roteamento fica no interruptor da própria página original do gateway, que aparece dentro do iframe. A suíte não tem rota para alterar o roteamento. A mudança vale para o processo em execução; ao reiniciar o gateway, o valor volta ao definido pelo ambiente de lançamento.

Para medir com e sem Jev de forma controlada, use o experimento de `gatewayExperiment`, descrito em [otimização de tokens](../guides/token-optimization.md#procedimento-de-experimento). Ele define o modo de cada cliente ao iniciar o roteador, e não é o interruptor da página.

### Preços e custo

`observability.pricing` define os preços usados para estimar custo. Não há valor padrão. Procedimento e cuidados em [configuração, preços para custo estimado](../guides/configuration.md#preços-para-custo-estimado).

O custo é uma **estimativa de preço de API**. Não representa cobrança de assinatura e não confirma economia.

## Sessões do Antigravity CLI (agy)

O agy não tem evento de fim de sessão. Por isso, a suíte finaliza as sessões assim:

1. Ao abrir com `jev-memory-agy` (ou `jev-memory agy`), o launcher define um id de lançamento em `JEV_MEMORY_AGY_LAUNCH`. Os hooks registram os ids de conversa desse lançamento.
2. Ao sair, o launcher executa `ai-memory finalize-session --agent antigravity-cli --session-id <id> --reopen` somente para esses ids, e depois apaga o registro. Sessões concorrentes não relacionadas não são tocadas.
3. Falhas geram apenas aviso.

Para sessões não iniciadas pelo launcher, ou após uma queda do launcher, use o fallback manual:

```bash
node bin/jev-memory.mjs agy-finalize
node bin/jev-memory.mjs agy-finalize --session <id>
```

Sem `--session`, o comando finaliza a sessão agy aberta mais recente do projeto. Após uma queda forçada do launcher, a finalização automática não é garantida. `Stop` é fim de turno e não encerra a sessão.

Logs de diagnóstico do hook: `.local/profiles/<perfil>/logs/hook-errors.log` e `hook-skips.log`. Não contêm conteúdo.

## Headroom (Claude)

Opcional e desligado por padrão. Ele comprime o contexto que o Claude envia, antes do gateway Jev claude. Procedimento completo, medições e limites em [otimização de tokens](../guides/token-optimization.md#headroom-opcional-claude). Decisão em [ADR 0013](../architecture/adr/0013-headroom-context-compression.md).

Ligar: instale o Headroom 0.41.0 com uv, grave `headroom.enabled: true` com `config` (perfil parado) e inicie. Os comandos estão no guia.

| Ação | Comando | Resultado esperado |
|---|---|---|
| Verificar a detecção | `node bin/jev-memory.mjs doctor` | Bloco `headroom` com `enabled: true`, `detected.ok: true` e `state: "ready"` |
| Verificar o serviço | `node bin/jev-memory.mjs status` | `services.headroom: "ready"` e `headroom.upstreamPort` igual à porta do Jev claude |
| Usar | `node bin/jev-memory.mjs claude` | Nenhuma linha `Headroom not used` em stderr |
| Desligar numa execução | Bash: `JMS_HEADROOM=off node bin/jev-memory.mjs claude`. PowerShell: `$env:JMS_HEADROOM = 'off'` antes do comando | O Claude segue pelo caminho original, sem iniciar o Headroom |
| Desligar de vez | Pare o perfil, grave `headroom.enabled: false` com `config` e inicie | `doctor` mostra `enabled: false`, e o serviço não sobe |

Pontos de atenção:

- A troca de `JEV_CLAUDE_PORT` exige reiniciar o perfil. Sem isso, o launcher recusa o Headroom com `Headroom forwards to another Jev port` e segue pelo caminho original.
- Depois de trocar `headroom.version` ou o executável, reinicie o perfil. Só altere a versão depois de rodar `npm run test:headroom` com a nova.
- Antes de o Claude iniciar, qualquer falha leva ao caminho original. Depois disso não há fallback: se o Headroom cair durante a sessão, o supervisor o reinicia (até 3 vezes em 60 s) e as requisições falham nesse intervalo. Leia a [tabela de causas](../guides/troubleshooting.md#headroom).

Rollback: `headroom.enabled: false` ou `JMS_HEADROOM=off` por execução. Nenhum dado da memória ou do gateway muda. O Headroom mantém o estado dentro do perfil, em `.local/profiles/<nome>/headroom/`, e os logs em `logs/headroom*`. Com o perfil parado, esses arquivos podem ser removidos sem afetar a memória.

## Headroom com Codex

Opcional, desligado por padrão, e só vale com `headroom.enabled: true`. Com `headroom.codex: true`, o Codex passa pelo Headroom antes do gateway Jev codex, por um shim de runtime da versão fixada. Procedimento, medições e limites em [otimização de tokens](../guides/token-optimization.md#headroom-com-codex-opcional). Decisão em [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md). Ameaças em T43 a T46 do [modelo de ameaças](../security/threat-model.md).

### Ligar

1. Confirme o Headroom 0.41.0 e o interpretador do `headroom-ai`, e rode o `--check` do shim, nos passos 1 a 3 do guia.
2. Pare o perfil e grave `headroom.codex: true` com `config`. O bloco `headroom` mantém `enabled: true`, `executable` e, se necessário, `python`.
3. Inicie o perfil.

### Verificar

| Ação | Comando | Resultado esperado |
|---|---|---|
| Verificar a detecção | `node bin/jev-memory.mjs doctor` | Bloco `headroom.codex` com `enabled: true`, `python.ok: true` e `active: true` |
| Verificar o serviço | `node bin/jev-memory.mjs status` | `headroom.codex: true`, `headroom.codexUpstreamPort` igual à porta do Jev codex, e sem `headroomCodexReason` |
| Verificar o shim | `--check` descrito em [otimização de tokens](../guides/token-optimization.md#headroom-com-codex-opcional) | Linha JSON com `"ok":true` |
| Usar | `node bin/jev-memory.mjs --profile <nome> codex` | Nenhuma linha `Headroom not used` em stderr |

Pontos de atenção:

- A troca de `JEV_CODEX_PORT` exige reiniciar o perfil. Sem isso, o launcher recusa o Headroom com `Headroom forwards to another Jev port` e segue pelo caminho original.
- Uma falha do modo Codex não derruba o Headroom do Claude. O motivo fica em `headroomCodexReason`. Causas e ações estão em [solução de problemas](../guides/troubleshooting.md#codex).
- Antes de o Codex iniciar, qualquer falha leva ao caminho original. Depois disso, como no Claude, não há fallback: se o Headroom cair, o supervisor o reinicia (até 3 vezes em 60 s).

### Desligar e rollback

- Numa execução: `JMS_HEADROOM=off` antes de `jev-memory codex`. Em PowerShell, `$env:JMS_HEADROOM = 'off'`.
- Só o Codex: pare o perfil, grave `headroom.codex: false` com `config` e inicie. O Claude continua no Headroom.
- Tudo: pare o perfil e grave `headroom.enabled: false`, pelo mesmo procedimento.
- Os dados do Headroom ficam em `.local/profiles/<nome>/headroom/` e em `logs/headroom*`. Com o perfil parado, podem ser removidos sem afetar a memória. O Headroom não escreve em `~/.headroom` (verificado no teste E2E).

### Upgrade do Headroom

Faça isto só com um perfil de teste, nunca no perfil em uso. A regra está na [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md): cada versão tem sua pasta de patch, e a versão é fixada.

1. Instale a nova versão em um ambiente uv separado e confirme com `headroom --version`.
2. Crie `patches/headroom/<nova versão>/` com o shim adaptado e `SUPPORTED_VERSION` igual à nova versão. Revise os alvos: as quatro constantes, os módulos com `chatgpt.com` (`allowedStringHits` do `--check`) e as verificações de forma, que saem com código 4.
3. Rode o `--check` com o interpretador da nova versão. Ele precisa sair com código 0 e `"ok":true`.
4. O teste `test/headroom-codex-e2e.ts` fixa `HEADROOM_VERSION` em `0.41.0`. A troca de versão exige atualizar essa constante junto com a pasta de patch, na mesma alteração.
5. Rode `npm run test:headroom` e `npm run test:headroom-codex`. Os dois precisam passar.
6. Só então altere `headroom.version` no perfil, em alteração separada, e reinicie o perfil.
7. Se a forma do código mudou e não há patch seguro, mantenha `headroom.codex: false`. O Codex segue pelo caminho direto do Jev, e o Claude não muda.

### Retirada do shim

Quando uma versão do Headroom trouxer `HEADROOM_CHATGPT_CODEX_BASE_URL` nativamente, use essa versão, apague a pasta do shim e altere a suíte para definir a variável e iniciar `headroom.exe` diretamente. A contribuição proposta está em `patches/headroom/0.41.0/chatgpt-codex-base-url.patch`, que aplica com `patch -p1`. Essa alteração de código é tarefa própria. Ver [patches do Headroom](../../patches/headroom/README.md).

## Portas

| Serviço | Padrão | Chave |
|---|---|---|
| Controle | 18877 | `controlPort` |
| AI Memory | 49375 | `memory.port` |
| Jev Gateway | 18878 | `gateway.port` |
| Painel local | 18879 | `dashboard.port` |
| Headroom (opcional, Claude) | 18880 | `headroom.port` |

Todas escutam apenas em `127.0.0.1`. Em uma máquina com mais de um perfil, cada perfil precisa de cinco portas distintas (veja [configuração](../guides/configuration.md)).

## Logs

| Arquivo | Conteúdo | Limite |
|---|---|---|
| `.local/profiles/<p>/logs/supervisor.log` | Saída do supervisor | Sem limite implementado |
| `.local/profiles/<p>/logs/memory.log` | Saída do AI Memory | Cerca de 5 MB por execução |
| `.local/profiles/<p>/logs/gateway.log` | Saída do Gateway | Cerca de 5 MB por execução |
| `.local/evidence/*.log` | Saída de `install` e `update` | Sem limite |
| `.local/profiles/<p>/logs/headroom.log` | Saída do Headroom, com segredos redigidos (só com `headroom.enabled`) | Cerca de 5 MB por execução |
| `.local/profiles/<p>/logs/headroom-requests.jsonl` | Metadados das requisições que passam pelo Headroom, sem conteúdo de mensagens (só com `headroom.enabled`) | Limite não medido |

Os logs de filhos têm segredos redigidos. A redação não é exaustiva (veja [credenciais](../security/credentials-and-hook-isolation.md)).

Não há rotação de logs. Se o tamanho crescer demais, pare o perfil e mova o arquivo para fora do workspace, depois inicie de novo.

## Rotina de manutenção

1. Consulte `status` e `doctor` antes de iniciar ou parar.
2. Antes de alterar configuração, pare o perfil e faça um backup (veja [backup e recuperação](backup-and-recovery.md)).
3. Depois de qualquer `install`, reinicie o perfil. Versões novas só entram em uso com o processo reiniciado.
4. Verifique o espaço em `.local/engines/`, porque versões antigas não são apagadas automaticamente.
5. Revise `.local/client-backups/` periodicamente, porque backups de registro também não são apagados.

## Quando não reiniciar

- Se houver dúvida sobre a origem de um erro, não repita `start` em loop. Leia os logs e o `doctor` antes.
- Não use `kill` em PIDs. A parada é sempre feita pelo supervisor autenticado; se ele não responder, investigue o processo antes de encerrá-lo.
