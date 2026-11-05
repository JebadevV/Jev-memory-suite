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

`doctor` mostra em `gateways` o estado dos gateways upstream de claude (porta 8789) e de codex (porta 8790). O gateway do agy (porta 8794) também aparece no status e no doctor; procedimentos na seção [gateway do agy](#gateway-do-agy-jev-gateway). A forma completa está em [saída de doctor dos gateways](../api/cli.md#saída-de-doctor-gateways).

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

`observability.pricing` define os preços usados para estimar custo. Há dois preços padrão verificados (modelos Gemini), e um preço configurado para o mesmo id vence o padrão. `observability.pricing.aliases`, `validUntil` e `observability.billing` (base de cobrança por cliente) também são configurados ali. Procedimento e cuidados em [configuração, preços para custo estimado](../guides/configuration.md#preços-para-custo-estimado).

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

Sem `--session`, o comando finaliza a sessão agy aberta mais recente do projeto. Após uma queda forçada do launcher, use a recuperação descrita abaixo. `Stop` é fim de turno e não encerra a sessão.

Logs de diagnóstico do hook: `.local/profiles/<perfil>/logs/hook-errors.log` e `hook-skips.log`. Não contêm conteúdo.

### Recuperação e fechamento da janela

- Cada lançamento grava `<launchId>.owner.json` (`pid`, `startedAt`, `workspace`, `project`, `cwd`; sem conteúdo), ao lado de `<launchId>.sessions`. Os dois são removidos ao finalizar.
- Fechar a janela do console envia `SIGHUP` ao launcher. Ele finaliza o próprio lançamento uma única vez, com prazo total de cerca de 7 s. O que não terminar nesse prazo fica registrado para a recuperação.
- Antes de cada lançamento, a recuperação automática finaliza só os lançamentos cujo dono tem pid morto. Ela faz claim por rename (`.sessions.recovering-<pid>`), e um claim de processo morto pode ser retomado. Usa o escopo gravado, não o config atual. Não lê outro perfil.
- Dono vivo, owner inválido ou escopo divergente do config atual não são tocados. O launcher avisa.
- Procedimento manual:

```bash
node bin/jev-memory.mjs agy-finalize --recover
node bin/jev-memory.mjs agy-finalize --recover --legacy
```

`--recover` também inclui lançamentos com escopo divergente, finalizados com o escopo gravado (a saída traz `scope: "recorded"`). `--recover --legacy` finaliza ainda os registros sem owner, de versões anteriores, com o config atual do perfil. Antes de usar `--legacy`, confirme que nenhum agy está rodando. A saída é JSON com `recovered` e `skipped`, e o motivo de cada pulo (por exemplo, `no-owner`). `--session` não se combina com `--recover`, e `--legacy` exige `--recover`.

## Gateway do agy (Jev Gateway)

`jev-memory-agy` (ou `jev-memory agy`) passa pelo Jev Gateway em modo passthrough, usando o Code Assist do agy, quando as verificações passam. Não há roteamento: o conteúdo não é enviado ao provedor do Jev. A ordem das checagens e os motivos de fallback estão em [clientes](../guides/clients.md#antigravity-cli-agy).

- Com o gateway, o stderr mostra `Jev gateway: http://127.0.0.1:8794 (passthrough)`.
- Sem o gateway, o stderr mostra `Jev not used: <motivo>`, e o agy segue direto ao Google com o mesmo código de saída.
- `JMS_AGY_GATEWAY=off` no ambiente desliga o uso do gateway. O agy segue direto ao Google.
- A porta vem de `JEV_AGY_PORT`; sem valor válido, usa 8794. O health fica em `http://127.0.0.1:<porta>/health`.
- Arquivos: `~/.jev-gateway/agy.log`, lido pelo dashboard, e `~/.jev-gateway/agy.pid`, conferido pelo launcher.
- Se o gateway estiver parado, o próximo `jev-memory-agy` o inicia sozinho.

Para parar o gateway agy:

```bash
node <gatewayDir>/bin/jev-agy.mjs --stop
```

`<gatewayDir>` é a pasta da versão ativa do gateway, dentro de `.local/engines/jev-gateway/` (a marcada como `current` em `gateway-versions`). Não use `kill` no PID do gateway.

Versões e rollback:

```bash
node bin/jev-memory.mjs install gateway
node bin/jev-memory.mjs gateway-versions
node bin/jev-memory.mjs gateway-rollback <id>
```

- `install gateway` imprime `{previous, current}`.
- `gateway-rollback <id>` troca só o ponteiro da versão ativa. Não apaga versões. Não reinicia gateways: o gateway agy em execução segue na versão anterior até parar e subir de novo. Os gateways Claude e Codex seguem o mesmo critério, no próximo start.
- O id tem 40 caracteres hexadecimais e precisa ser uma versão completa dentro de `.local/engines/jev-gateway/`. Id inválido ou versão inexistente saem com código 1.

O card "Antigravity" do painel só aparece depois de `node bin/jev-memory.mjs restart`. O restart reinicia memória e dashboard, mas não os gateways Claude e Codex.

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

### Rollback do zod e do hook

Use se os hooks passarem a falhar com `invalid_type` depois de trocar a versão do zod. O registro da troca de 4.3.6 para 4.6.7 está em `progress.md`, na seção de 2026-10-25. Os hooks carregam `dist/src/hook.js` e `node_modules` a cada chamada, então o rollback não exige reinício de serviço. Os comandos usam o backup `zod-activation-20261025T155037Z` como exemplo; troque pelo nome do backup que for usar.

Na raiz do repositório:

1. Volte o zod para 4.3.6:

```bash
mv node_modules/zod node_modules/.zod-4.6.7-failed && cp -r .local/backups/zod-activation-20261025T155037Z/zod-4.3.6 node_modules/zod
```

Se `node_modules/.zod-old-4.3.6` ainda existir, renomeie-o de volta para `node_modules/zod` no lugar da cópia.

2. Restaure `package.json`, `package-lock.json` e `node_modules/.package-lock.json`:

```bash
cp .local/backups/zod-activation-20261025T155037Z/package.json package.json
cp .local/backups/zod-activation-20261025T155037Z/package-lock.json package-lock.json
cp .local/backups/zod-activation-20261025T155037Z/node_modules.package-lock.json node_modules/.package-lock.json
```

3. Restaure o `dist/` do backup:

```bash
cp -r .local/backups/zod-activation-20261025T155037Z/dist/. dist/
```

4. Confirme a versão e os logs:

```bash
node -p "require('zod/package.json').version"
```

A saída esperada é `4.3.6`. Depois, confira que `.local/profiles/<perfil>/logs/hook-errors.log` não ganhou linhas novas em uma sessão de teste.

A cópia `node_modules/.zod-old-4.3.6` fica no lugar até a alteração ser commitada.

## Quando não reiniciar

- Se houver dúvida sobre a origem de um erro, não repita `start` em loop. Leia os logs e o `doctor` antes.
- Não use `kill` em PIDs. A parada é sempre feita pelo supervisor autenticado; se ele não responder, investigue o processo antes de encerrá-lo.

## Rollback da correção de handoff do AGY e do painel

Use se a correção de 2026-10-25 (`user-prompt` nativo por turno no agy e bloco AGY do painel) causar problema. Registro em `progress.md`, seção de 2026-10-25. O backup é `.local/backups/agy-handoff-20261025T163415Z`, com `dist` e `HEAD`. Ele é anterior à correção, então restaurá-lo remove o `user-prompt` nativo por turno. Há um segundo backup, `.local/backups/agy-marker-20261025T170408Z` (`dist` e `HEAD`), feito antes da troca do texto do turno para `<agy-user-turn/>` em 17:04:11Z. Ele tem a correção, com o texto antigo em inglês.

Na raiz do repositório:

1. Restaure o `dist` do backup. Para voltar à correção com o texto antigo, use `.local/backups/agy-marker-20261025T170408Z` no lugar:

```bash
cp -r .local/backups/agy-handoff-20261025T163415Z/dist/. dist/
```

2. Os hooks carregam `dist/src/hook.js` a cada chamada. O rollback do hook vale na próxima chamada do agy, sem reinício. Depois dele, sessões agy sem ferramentas voltam a ser lifecycle-only, e a reentrega de handoff volta a ser possível. Confira:

```bash
grep -c AGY_USER_TURN_PROMPT dist/src/hook.js
grep -c "agy-user-turn" dist/src/hook.js
```

Com o backup `agy-handoff`, a primeira dá `0`. Com o build atual do marcador, `grep -c "agy-user-turn"` dá `1`. Com o backup `agy-marker`, dá `0`, e `grep -c "Antigravity user turn" dist/src/hook.js` dá `1`.

3. O painel só volta ao código anterior depois de reiniciar o perfil com `node bin/jev-memory.mjs restart`. Esse comando para e sobe o supervisor do perfil `default`, que serve o painel. Exige aprovação. Os gateways 8789 e 8794 não são filhos do supervisor e não mudam com ele.

4. O rollback acima restaura só o `dist`. As alterações de `src/` seguem no working tree até serem revertidas ou commitadas.

## Validação real controlada do AGY (preparada)

Status: preparada, não executada. Exige aprovação explícita, porque usa cerca de 2 sessões agy e 4 a 8 gerações Gemini na cota Google normal. Não exige reinício. Registro em `progress.md`, seção de 2026-10-25 "marcador do turno".

Pré-condições:

- `dist` com o marcador: `grep -c "agy-user-turn" dist/src/hook.js` dá `1`.
- Linha de base: número de linhas de `.local/profiles/default/logs/hook-errors.log`, tamanho de `~/.jev-gateway/agy.log` e `memory_handoff_list` do projeto.
- Nenhuma outra sessão Claude, Codex ou agy iniciada em `D:\Dev\jev-memory-suite` durante a janela. Uma sessão nova reivindicaria o handoff aberto mais recente.

Passos:

1. Criar o handoff H1 pelo MCP `memory_handoff_begin` (workspace `jev-suite`, projeto `jev-memory-suite`) com uma palavra-código nova, `AGY-HANDOFF-<aleatório>`.
2. Entrega com ferramenta. Em `D:\Dev\jev-memory-suite`:

```bash
jev-memory-agy -p "Leia o package.json e diga o campo name. Depois, se houver handoff pendente, diga a palavra-código."
```

Esperado: saída 0; stderr `Jev gateway: http://127.0.0.1:8794 (passthrough)`; resposta com o campo `name` e a palavra-código.

3. Conferir a sessão S1: H1 `accepted` por `antigravity-cli`, com `accepted_by_session` = S1; auditoria com `accept_handoff` e sem `release_lifecycle_only_handoff` para S1; observações de S1 com session-start, `<agy-user-turn/>` (user-prompt), pre-tool-use, post-tool-use, stop e session-end; o handoff automático H2 de S1 sem `agy-user-turn` em `summary` nem em `open_questions`.
4. Consumo sem ferramentas, o caminho original do bug:

```bash
jev-memory-agy -p "Existe handoff pendente? Responda em uma linha."
```

Esperado: H2 entregue e a palavra-código de H1 não repetida. Depois do finalize, H2 `accepted` por S2 e não reaberto.

5. Conferir o gateway: linhas novas de `~/.jev-gateway/agy.log` todas `passthrough` ou `routing_disabled`, com status 200; zero `codeassist_*`; nenhuma ocorrência de `Bearer`, `ya29.`, `authorization`, `systemInstruction`, `thoughtSignature` nem da palavra-código; `hook-errors.log` sem linhas novas; `/gateways/status` com `agyLive.window.requests` crescendo.

Critérios de aborto: stderr `Jev not used`; qualquer erro de hook; H1 ainda `open` depois da S1; qualquer `release_lifecycle_only_handoff` para S1 ou S2; a palavra-código no log do gateway. Nesses casos, pare, restaure `dist` do backup `agy-marker-20261025T170408Z` (ou `agy-handoff-20261025T163415Z`) e registre o ocorrido.

## Escopo do `jev-memory restart`

Verificado em 2026-10-25 por PID e porta, somente leitura. A lista pode mudar com o tempo; confira de novo antes de executar.

- Para e sobe só o supervisor do perfil `default` (PID 12268; controle 18877; dashboard 18879) e o filho `ai-memory.exe` (PID 35960; servidor de memória 49375).
- Não muda: gateways 8789 (PID 17504), 8790 (PID 2428, filho do launcher `jev-codex`, PID 37580) e 8794 (PID 30284); o supervisor do perfil `project-b9b5f26bfe6b2ceb49cb` (PID 18892, `ai-memory.exe` 17368); os processos stdio `ai-memory.exe` de sessões Claude e Codex abertas.
- Efeito: alguns segundos sem a API de memória para o perfil `default`. Os hooks gravam localmente e drenam depois.
- O comando `start` lê os overrides de porta (`JEV_*_PORT`) do ambiente do shell que o chama. Rode-o a partir de um shell com os mesmos overrides. Hoje nenhum está definido, então valem os padrões.
- Só depois desse reinício o painel AGY novo aparece na porta 18879. O reinício exige aprovação.
