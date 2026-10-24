# Solução de problemas

Propósito: associar sintomas e mensagens do gerenciador às causas prováveis e às ações seguras, inclusive a busca semântica, a migração do histórico, os hooks novos, o Headroom (opcional, Claude) e o Antigravity CLI (agy). Público: operadores e usuários. Data: 2026-10-23.

Comece sempre por `node bin/jev-memory.mjs --profile <nome> doctor`. Ele não mostra valores de segredos.

## Tabela de sintomas

| Sintoma ou mensagem | Causa provável | Ação |
|---|---|---|
| `Profile is already running` | `start` chamado com o supervisor ativo | Use `status`. Para reiniciar, use `restart`. |
| `Control port <porta> is used by another supervisor or process` | A porta de controle responde com `401` ou `403`: outro processo ou outro perfil a ocupa | Mude `controlPort` com `config` (perfil parado). Não mate o processo cegamente; identifique-o primeiro. |
| `port-conflict` em `status` | Mesma causa, com saída `1` | Igual à linha anterior |
| Perfil novo não inicia enquanto `default` roda | Perfis novos copiam as portas padrão 18877, 49375, 18878, 18879 e 18880 | Defina cinco portas distintas com `config` antes do `start` |
| `401` ao chamar `/status`, `/stop` ou MCP | Token errado: outro perfil ou arquivo de token diferente | Confirme `--profile`. Use `launch` ou `clients` para configurar os clientes, em vez de copiar tokens. Não cole tokens em chats ou arquivos versionados. |
| `Gateway requires the two configured JMS_* key environment variables` | Variáveis de chave ausentes no ambiente | Defina as duas variáveis cujos nomes estão em `gateway.upstreamKeyEnv` e `gateway.jevKeyEnv` |
| `Memory engine not installed; run: jev-memory install memory` | Ponteiro sem motor de memória | Execute `install memory` |
| `Gateway engine not installed; run: jev-memory install gateway` | Ponteiro sem Gateway | Execute `install gateway` |
| `doctor` mostra `installed` falso | Motor ausente ou ponteiro removido | Execute `install <motor>` |
| `Referenced gateway version is incomplete; refusing to remove it` | Diretório referenciado por `current.json` sem `.jev-suite-complete` ou sem `dist/index.js` | Repare manualmente. Não apague o diretório referenciado. |
| `Upstream source modified; refusing to build` | Alterações não commitadas em `upstream/` | Reverta-as ou faça commit; não compile a partir de fonte alterada |
| `Startup timeout; inspect local logs` | Filho não ficou saudável em cerca de 45 s | Leia `logs/memory.log` ou `logs/gateway.log` e `logs/supervisor.log` |
| `Supervisor failed; inspect local logs` ou `Service startup failed` | Um filho saiu ou falhou no health check | Mesma ação da linha anterior |
| `restarting` em `services` do `status`, com `restarts` subindo | Um filho caiu depois de `ready`, e o supervisor o reinicia (até 3 vezes em 60 s) | Aguarde. Se o contador continuar subindo, leia `logs/memory.log` ou `logs/gateway.log`. Ver [recuperação automática](../runbooks/operations.md#recuperação-automática). |
| `phase: failed` com o supervisor encerrado, depois de 3 reinícios em 60 s | Causa repetida, que a reinicialização automática não resolve | Leia `logs/supervisor.log` e o log do serviço, corrija a causa e rode `start` uma vez. Não repita `start` em loop. |
| `gateways.<cliente>.state` = `unavailable` no `doctor` | A sonda `/health` falhou ou passou de 1 s. A causa não é informada | Rode `node bin/jev-memory.mjs codex --status` (ou `claude --status`) para ver o launcher upstream. Não use `kill`. |
| `gateways.<cliente>.state` = `stopped` no `doctor` | Conexão recusada: o gateway upstream do cliente não está no ar | Inicie-o pelo launcher, com `node bin/jev-memory.mjs codex` ou `claude`, ou confirme a porta com `doctor`. |
| `gateways.<cliente>.portValid` = `false` | `JEV_CODEX_PORT` ou `JEV_CLAUDE_PORT` não é decimal entre 1024 e 65535 | Corrija ou remova a variável. Enquanto estiver inválida, a suíte usa a porta padrão. |
| `conflicts` não vazio no `doctor` | Uma porta de perfil é igual à de um gateway upstream (8789 ou 8790) | Defina outra porta no perfil com `config` (perfil parado) e repita `start`. Ver [saída de doctor](../api/cli.md#saída-de-doctor-gateways). |
| `Stop profile before changing configuration` | `config` com perfil em execução | Execute `stop` e repita |
| `Hook rejected or unavailable; run doctor` (stderr do hook) | Payload inválido, `cwd` fora do workspace, timeout de 20 s, saída acima de 256 KiB ou binário ausente | Rode `doctor`. Verifique se o `cwd` está dentro do workspace e se o perfil está `ready`. |
| `No .ai-memory.toml scope marker between ...` | Nenhum marcador nos ancestrais do diretório | Registre com `clients install <host> <dir>`. Sem marcador, a captura fica desligada. |
| `skip=no-scope-marker` em `logs/hook-skips.log` | O hook foi ignorado porque o diretório não tem marcador `.ai-memory.toml` acima dele. O resultado para o cliente não muda | Se o projeto deveria ser capturado, registre-o com `clients install <host> <dir>`. Se não, o registro é o esperado. |
| `skip=memory-disabled` em `logs/hook-skips.log` | A memória está desabilitada no perfil. O resultado para o cliente não muda | Habilite a memória no perfil se a captura for desejada. Caso contrário, o registro é o esperado. |
| `scope.resolved_by = shared_slot` no `memory_status` do Claude | A chamada usou o último projeto ativo do servidor, não o da sessão. Registro feito antes da bridge com sessão | Rode `clients install claude <dir>` e abra uma nova sessão do Claude. O esperado é `resolved_by = session`. Veja [clientes](clients.md#atualização-de-registros-existentes). |
| `Scope marker <path> declares ..., profile expects ...` | Marcador de outro projeto | Revise o marcador. Não o altere sem confirmar o projeto correto. |
| `Workspace client registration belongs to profile <x>` | Registro de outro perfil no diretório | Remova com o perfil dono ou lance com ele |
| `Managed MCP entry changed; refusing overwrite` ou `Managed hook changed` | Alteração manual nas entradas registradas | Revise o diff. A suíte não sobrescreve alterações manuais. |
| `MCP name already in use; refusing overwrite` | Já existe `jev_memory_suite` sem manifesto | Remova ou renomeie a entrada existente após revisão |
| `Registration failed and rollback was incomplete` | Falha de escrita com rollback parcial | Restaure a partir de `.local/client-backups/<timestamp>-<host>/` ([backup e recuperação](../runbooks/backup-and-recovery.md)) |
| `mcp` falha com `Required memory tools missing` | Servidor respondeu sem as ferramentas esperadas | Confirme a versão do motor instalada e o perfil iniciado |
| `MCP response too large` | Resposta acima de 4 MB | Reduza o escopo da consulta |
| Claude ou Codex não listam o servidor | Confiança nativa não concedida | Veja [clientes](clients.md#etapas-de-confiança-nativa) |
| Codex ignora hooks | Hooks não revisados ou alterados | Revise em `/hooks` no Codex. Depois de reinstalar, devem aparecer 7 hooks do jev-memory-suite. |
| Codex mostra `untrusted` para `PreCompact` ou `Stop` depois de reinstalar | Hooks novos ainda não revisados pelo usuário | Abra `/hooks` no Codex e aprove os hooks do jev-memory-suite. A suíte não aprova hooks por conta própria. |
| Codex com hooks confiáveis, mas nada capturado e sem linhas em `hook-errors.log` nem em `hook-skips.log` | Registro anterior à correção de 2026-10-22: no Windows, o comando do hook não tinha `& `, e o PowerShell do Codex não o analisa | Rode `npm run build`, depois `clients install codex <dir>` e revise os 7 hooks em `/hooks`. |
| Codex avisa que o timeout do `SessionEnd` foi reduzido para 3 s | Limite do próprio Codex. A suíte declara 25 s | Nada a corrigir. Veja [clientes](clients.md#etapas-de-confiança-nativa). |
| `Hook event not supported by agent` | Codex recebendo `subagent-start` ou `subagent-stop`, que só o Claude Code envia | Nada a corrigir: a rejeição é intencional. Confira se o hook do Codex foi gerado por `clients install codex`. |
| `agent_type:too_small` em `logs/hook-errors.log` | `dist/src/hook.js` anterior à correção de 2026-10-22, que exigia `agent_type` não vazio e rejeitava todo `SubagentStop` real do Claude Code | Rode `npm run build`. O comando do hook não muda, então não é preciso reinstalar os hooks. |
| Hooks novos não disparam no Claude Code | O processo do Claude foi iniciado antes da reinstalação | Feche a sessão e abra outra. Os hooks são lidos no início do processo. |
| `/compact` não chega ao Claude ao rodar `claude -p --resume <sessão> "/compact"` no Git Bash | O Git Bash converte um argumento que começa com `/` em caminho | Rode com `MSYS_NO_PATHCONV=1` antes do comando. Ver [clientes](clients.md#validação-de-2026-10-22-claude-code-em-sessão-nova). |
| Eventos chegando à instalação original depois da migração | Um processo do Claude iniciado antes da remoção dos hooks antigos ainda envia para `127.0.0.1:49374` | Feche e reabra a sessão do Claude. Ver [migração](migration.md#pontos-de-atenção). |
| `Model file <nome> fails its checksum; refusing to overwrite it. Move it aside and retry.` | Um arquivo do modelo no perfil não confere com o sha256 fixado. A suíte não sobrescreve arquivos do perfil. | Pare o perfil, mova o arquivo para fora de `memory/models/all-MiniLM-L6-v2/` e rode `start`. A suíte recria o arquivo a partir do cache verificado. Ver [busca semântica](#busca-semântica-e-modelo). |
| `Copied model failed checksum verification` ou `Provisioned model failed checksum verification` | A cópia do modelo não confere, por exemplo por corrupção de disco | Pare o perfil, apague `.local/models/all-MiniLM-L6-v2/` (cache regenerável) e rode `start`. |
| `Esquemas incompatíveis; nada foi gravado` ou `Versão de schema da origem ... é maior que a do destino` | A origem da migração tem schema incompatível ou mais novo que o destino | A migração recusa e não grava nada. Não force a execução. Compare as versões do motor antes de tentar de novo. |
| `pare a suíte: jev-memory stop` no `migrate-history --apply` | O perfil está em execução, ou a porta da memória responde | Execute `node bin/jev-memory.mjs stop`, confirme com `status` e repita o `--apply`. |
| `Validação pós-migração falhou; cópia de wiki não executada` | O destino não passou na validação depois da transação | Nada da wiki foi copiado. Leia `validation` no relatório. Se o destino ficou inconsistente, faça o rollback do [guia de migração](migration.md#rollback). |
| Conflitos no relatório da migração | Sessões ou páginas já existentes no destino com conteúdo diferente | Comportamento esperado. A versão da suíte é mantida. Veja [conflitos esperados](migration.md#conflitos-esperados). |
| Handoff antigo sendo oferecido no `SessionStart` | Handoff importado da instalação original, ainda aberto | Cancele com a ferramenta `memory_handoff_cancel`, usando o identificador de `handoffs --json`. Ver [handoffs abertos](migration.md#handoffs-abertos). |
| Perfil novo herdando a porta de controle 18877 reporta `port-conflict` | O perfil copiou as portas padrão enquanto `default` ou outro processo usa 18877 | Defina portas distintas com `config` (perfil parado) e repita `start` |
| `codex exec` não lança o servidor MCP da suíte, mesmo com `-c` | `-c` colocado antes do subcomando `exec` é ignorado pelo `codex exec` | O lançamento da suíte já insere os overrides depois de `exec`, `e`, `resume`, `review` ou `fork`. Se usar o Codex manualmente, coloque `-c` depois do subcomando. |
| `codex exec` fica parado sem resposta | `codex exec` espera stdin | Feche a entrada, por exemplo com `< /dev/null` |
| O modelo chama uma ferramenta de outro servidor MCP com o mesmo nome | Outro servidor MCP global (por exemplo, um `ai-memory` do usuário) expõe ferramentas de mesmo nome | Nomeie `jev_memory_suite` explicitamente nos prompts. Veja [modelo de ameaças](../security/threat-model.md) (T19). |
| Bloco "Gateways offline" no lugar do iframe | Nenhum gateway respondeu à sonda `/health` quando a página foi carregada | Inicie um gateway com `node bin/jev-memory.mjs codex` ou `claude` e recarregue o painel. Ver [painel de gateways](../runbooks/operations.md#painel-de-gateways). |
| Aviso "O gateway mudou desde que esta página foi carregada" | O agregador mudou, por exemplo quando o Codex subiu ou caiu | Recarregue a página. O painel não recarrega sozinho, para não trocar o iframe enquanto você lê. |
| Gateway de porta fora do padrão não aparece na página | A porta não chegou ao `?peers=` | Confira `JEV_CLAUDE_PORT` e `JEV_CODEX_PORT`. Valores inválidos usam o padrão e aparecem como `portValid: false` em `/gateways/status`. |
| Painel mostra iframe antigo ou duas visões | O supervisor ou o navegador guardou a página anterior | Rode `node bin/jev-memory.mjs restart` e recarregue a página sem cache (Ctrl+F5). Deve haver um iframe com `data-aggregator` igual a `cliente:porta`. |
| Interruptor de roteamento não aparece | A página original do gateway não carregou dentro do iframe | Confira o bloco "Gateways offline" e o aviso de agregador. O interruptor fica na página original; a suíte não tem rota de alteração. |
| Cartão com "Métricas indisponíveis" | `state: running`, mas `metrics: unavailable`: resposta inválida ou acima de 2 MB, timeout de 1500 ms ou erro em `/dashboard/events` | Aguarde o próximo ciclo de 5 s. Se persistir, rode `node bin/jev-memory.mjs codex --status` (ou `claude`) e leia `logs/gateway.log`. O painel não mostra a causa. |
| Cartão com "Autenticação exigida" | O gateway respondeu `401` ou `403` em `/dashboard/events`. Os gateways do launcher não usam chave de roteador, então isso não é esperado para eles | Confira no launcher (`--status`) e no log do gateway se outro processo configurou chave. O painel não envia credenciais e não deve receber a chave. O gateway do supervisor (`gateway.enabled`) não aparece nesta seção. |
| Requisições travadas em 1.000 ("Requisições (até 1.000 retidas)") | O upstream retém no máximo 1000 eventos por processo, e a seção conta só essa janela | Esperado, não é erro. A seção não mostra total histórico. Para o histórico completo, use os logs do gateway. |
| Custo aparece como "não configurado" | `observability.pricing` não tem o modelo, ou falta algum campo de preço | Preencha o modelo com a fonte oficial, `source` e `verifiedAt`. Ver [preços para custo estimado](../guides/configuration.md#preços-para-custo-estimado). |
| agy: `mcp_config.json` não é lido, ou a entrada `jev_memory_suite` não aparece | O arquivo global `~/.gemini/config/mcp_config.json` começa com BOM UTF-8, que o agy não aceita | Rode `clients install antigravity <dir>`. A suíte grava o backup `mcp_config.json.jev-bom-<timestamp>.bak` ao lado do arquivo e remove só o BOM. Confira o backup antes de descartá-lo. |
| agy: `clients install antigravity` falha com erro de caminho (espaços ou caracteres de shell) | O agy não usa shell e separa os comandos de hook por espaços. O repositório está em caminho com espaços, ou nomes 8.3 estão desabilitados no volume | Mova o repositório para um caminho sem espaços ou use um volume com nomes 8.3 habilitados. Depois repita o registro e confira com `clients check antigravity <dir>`. |
| agy: ferramenta bloqueada com erro de hook no `PreToolUse` | Saída de hook inválida ou código diferente de 0 bloqueia a ferramenta, e `{}` nega. O hook da suíte responde `allow` e sai com 0, mesmo em erro interno | Leia `logs/hook-errors.log`. Procure outro grupo de hooks no `.agents/hooks.json` ou um hook global que responda `{}` ou saída inválida. |
| agy headless (`-p`): ferramentas MCP negadas sem mensagem de conexão | Sem permissão, o modo `-p` nega ferramentas MCP | Adicione a permissão em `permissions.allow` do agy (por exemplo `mcp(...)`), ou use `--dangerously-skip-permissions` se aceitar o risco. A suíte não altera permissões. |
| agy: sessão sem `session-end` no perfil | O launcher caiu antes de finalizar, ou a sessão não foi aberta por `jev-memory-agy` | Rode `jev-memory agy-finalize` (última sessão do projeto) ou `jev-memory agy-finalize --session <id>`. Após queda forçada, a finalização automática não é garantida. Veja [operação](../runbooks/operations.md#sessões-do-antigravity-cli-agy). |
| agy: `jev-memory-agy` não encontra o `agy` | O agy não está no PATH, nem em `%LOCALAPPDATA%\agy\bin\agy.exe` | Adicione o diretório do agy ao PATH ou instale-o no caminho padrão. |
| agy: `clients remove antigravity` não removeu o MCP | A entrada global é compartilhada por outros projetos e é mantida de propósito | Remova com `agy mcp remove jev_memory_suite`, se nenhum outro projeto a usar. |
| agy: `clients install antigravity` recusa o MCP porque o nome `jev_memory_suite` já existe | A entrada global pertence a outro servidor | Revise a entrada em `~/.gemini/config/mcp_config.json`. Remova ou renomeie-a só depois de revisar, e repita o registro. |

## Headroom

O Headroom é opcional e desligado por padrão. Ele atende o Claude (`headroom.enabled`) e, com `headroom.codex`, o Codex. Em caso de fallback, o cliente segue pelo caminho original e o motivo aparece em stderr. Decisões em [ADR 0013](../architecture/adr/0013-headroom-context-compression.md) e [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md).

### Mensagens do launcher (`jev-memory claude` e `jev-memory codex`)

Formato: `Headroom not used: <motivo>; launching through jev-claude.`

| Motivo | Causa provável | Ação |
|---|---|---|
| `Headroom bypassed by JMS_HEADROOM=off` | A variável `JMS_HEADROOM=off` está no ambiente | Esperado. Remova a variável para voltar a usar o Headroom. |
| `Headroom service is starting` ou `restarting` | O serviço não ficou `ready` em 60 s | Na validação, o Headroom ficou pronto em 11,1 s. Rode `status` de novo depois de alguns segundos. Se continuar assim, leia `logs/headroom.log`. |
| `Headroom service is unavailable` | A detecção falhou antes do início | Leia `headroomReason` em `status` e siga a tabela de textos abaixo. |
| `Headroom service is failed` | Porta ocupada, processo não saudável ou reinícios esgotados | Leia `headroomReason` e `logs/headroom.log`. |
| `Headroom service is stopped` | O serviço está parado, por exemplo porque o perfil foi parado | Rode `status`. Se o perfil não estiver em execução, rode `start`. |
| `Headroom service is not running` | O supervisor não informou o estado do serviço | Rode `start` e tente de novo. |
| `Headroom forwards to another Jev port; restart the profile` | `JEV_CLAUDE_PORT` mudou depois que o Headroom iniciou | Rode `node bin/jev-memory.mjs --profile <nome> restart`. O Headroom passa a usar a porta atual. |
| `Headroom did not answer its health check` | `/livez` não respondeu ao launcher | Confira `doctor`. Se outro processo ocupa a porta, siga a linha de porta ocupada abaixo. |
| `jev-claude --start failed` | O launcher upstream não iniciou o gateway do Claude | Rode `node bin/jev-memory.mjs claude --status` e leia a saída. Não use `kill`. |
| `Jev gateway is not running` | O gateway iniciou, mas a sonda não o encontrou | Rode `node bin/jev-memory.mjs claude --status`. Não use `kill`. |
| `Jev claude gateway port is unknown` | A instalação do launcher upstream não informou a porta do Claude. O mesmo texto aparece em `headroomReason`. | Confira `gateways.claude` no `doctor` e a instalação do `jev-claude`. |
| `Headroom check failed` | Erro inesperado durante a verificação | Rode `doctor` e leia `logs/supervisor.log`. |

Para `jev-memory codex`, o formato é o mesmo, com `launching through jev-codex`. Os motivos próprios do Codex estão na seção [Codex](#codex).

### Textos de `headroomReason` (início do serviço)

Aparecem em `status` e em `doctor`, em `headroom.reason`, quando o início falha.

| Texto | Causa provável | Ação |
|---|---|---|
| `Headroom executable not found; install it with uv or set headroom.executable` | Não há `headroom` no caminho configurado, no PATH nem em `~/.local/bin` | Instale o Headroom 0.41.0 com uv, ou defina `headroom.executable` com caminho absoluto. Depois, reinicie o perfil. |
| `Headroom version could not be read` | `headroom --version` falhou ou não imprimiu o banner `headroom, version X.Y.Z` | Rode `headroom --version` à mão. Se o executável encontrado não for o Headroom, defina `headroom.executable`. |
| `Headroom X found; this profile requires Y` | A versão instalada é diferente de `headroom.version` | Instale a versão fixada. Altere `headroom.version` só depois de rodar `npm run test:headroom` com a nova versão. |
| `Headroom port is in use` | Outro processo ocupa `headroom.port` | Identifique o processo antes de agir. Não o encerre às cegas. Troque a porta com `config`, com o perfil parado. |
| `Headroom did not become healthy` | O processo subiu, mas `/livez` não respondeu no tempo do supervisor | Leia `logs/headroom.log`, corrija a causa e rode `start` uma vez. |

### Serviço `failed` depois dos reinícios

Quando os reinícios se esgotam, `services.headroom` vai para `failed` sem novo `headroomReason`, e `restarts.headroom` mostra quantos reinícios houve. A fase do perfil continua `ready` e a memória segue disponível. Leia `logs/headroom.log`, corrija a causa e rode `restart` uma vez. Não repita em loop; veja [recuperação automática](../runbooks/operations.md#recuperação-automática).

### Codex

Com `headroom.codex: true`, `jev-memory codex` tenta a rota pelo Headroom. O motivo de início aparece em `headroomCodexReason` (em `status`, na raiz; em `doctor`, em `headroom.codex.reason`). O motivo da rota aparece em stderr, prefixado por `Headroom not used:`. Uma falha do Codex nunca tira o Headroom do Claude: o serviço segue em modo só Claude. Decisão em [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md).

**Motivos de início (`headroomCodexReason`)**

| Texto | Causa provável | Ação |
|---|---|---|
| `Headroom python not found; install headroom-ai with uv or set headroom.python` | Não há `python.exe` do ambiente `headroom-ai` nos diretórios de uv pesquisados, e `headroom.python` não está definido | Instale o Headroom 0.41.0 com uv, ou grave `headroom.python` com caminho absoluto. Reinicie o perfil. |
| `Headroom X found; this profile requires Y` | O pacote `headroom-ai` do interpretador tem versão diferente de `headroom.version` | Instale a versão fixada no mesmo ambiente uv. |
| `Headroom version could not be read from its python` | O interpretador não informou a versão do `headroom-ai` | Confirme `headroom.python`. Rode o interpretador com `-I` e leia `importlib.metadata.version('headroom-ai')`. |
| `No Codex patch for Headroom X` | Não existe a pasta `patches/headroom/X/` para a versão instalada | Instale 0.41.0. Não copie o shim de outra versão. |
| `Codex shim check failed` ou `Codex shim check printed no report` | O `--check` do shim falhou, ou não imprimiu o relatório | Rode o `--check` à mão ([otimização de tokens](token-optimization.md#headroom-com-codex-opcional)). Leia o campo `reason` do JSON e a tabela de códigos abaixo. |
| `Headroom Codex mode did not become healthy` | O processo do Codex não respondeu `/livez` no tempo do supervisor. Ele foi parado, e o serviço voltou ao modo só Claude | Leia `logs/headroom.log`, corrija a causa e reinicie o perfil. |
| `Jev codex gateway port is unknown` | A instalação do launcher upstream não informou a porta do Codex | Confira `gateways.codex` no `doctor` e a instalação de `jev-codex`. |

**Códigos de saída do `--check` do shim**

| Código | Significado | Ação |
|---|---|---|
| 2 | Base inválida. Precisa ser exatamente `http://127.0.0.1:<porta>/v1`, com porta de 1024 a 65535 | Confira `JEV_CODEX_PORT`. A suíte monta a base a partir da porta atual do gateway. |
| 3 | Versão do Headroom diferente da que o shim suporta | Instale 0.41.0, ou use a pasta de patch da versão instalada, se existir. |
| 4 | Forma do código diferente: módulo que não importa, ou atributo com valor inesperado | Não force o patch. Mantenha `headroom.codex: false` e siga o procedimento de upgrade do [runbook](../runbooks/operations.md#headroom-com-codex). |
| 5 | Autoteste falhou: alguma URL não aponta para o gateway, sobrou `chatgpt.com` em constante, ou o guard não se comportou como esperado | Não use o modo Codex nesse estado. Mantenha `headroom.codex: false` e revise a instalação e o patch. |

**Motivos da rota (launcher `jev-memory codex`)**

| Texto | Causa provável | Ação |
|---|---|---|
| `Headroom Codex routing is not active: <motivo>` | O modo Codex não está ativo no supervisor. O motivo é o `headroomCodexReason` | Trate o motivo pela tabela acima. |
| `Jev codex gateway is not running` | O gateway do Codex não respondeu à sonda | Rode `node bin/jev-memory.mjs codex --status` e leia a saída. Não use `kill`. |
| `Jev codex gateway port is unknown` | A porta do gateway do Codex não foi informada pela instalação | Confira `gateways.codex` no `doctor`. |
| `Codex provider spec unavailable` | A especificação do provedor do Codex não foi lida da instalação de `jev-codex` (`clients.mjs`) | Confirme a instalação de `jev-codex`. Enquanto isso, o Codex segue pelo caminho original. |
| `Headroom forwards to another Jev port; restart the profile` | `JEV_CODEX_PORT` mudou depois que o Headroom iniciou | Reinicie o perfil com `restart`. |

## Busca semântica e modelo

Confirme o estado da busca vetorial no log do motor de memória, `.local/profiles/<perfil>/logs/memory.log`:

```text
embedder enabled provider="local" model="all-MiniLM-L6-v2" dim=384
```

Se a linha não aparecer com `semanticSearch` em `true`, o motor não habilitou o embedder. Use esta lista:

- **Modelo ausente e sem rede.** O perfil não tem cópia verificada e não há como baixá-la do Hugging Face. O motor não inicializa o embedder, e a inicialização pode terminar com `Startup timeout` ou `Service startup failed`. A causa aparece em `memory.log`. Ações: restaure a instalação original em `%LOCALAPPDATA%\ai-memory\models\all-MiniLM-L6-v2`, ou conecte-se à rede e rode `start` de novo. Para operar sem vetores enquanto isso, desligue a busca semântica (veja [configuração](configuration.md#busca-semântica-local)).
- **Modelo offline depois de instalado.** Não é necessário rede: a cópia do perfil basta. Se o `start` reclamar de checksum, siga a linha de checksum acima.
- **`backfill` com falhas.** A linha `startup embedding backfill completed ... failed=N` com `N` maior que zero indica páginas sem vetor. Rode `start` de novo depois de corrigir o modelo.

## Diagnóstico passo a passo

1. `doctor`: confira `installed`, `engines`, `enabled`, `credentials` (somente presença) e `supervisor`.
2. `status`: `ready` indica que os serviços habilitados estão saudáveis. `stopped` indica que nada está rodando. `port-conflict` indica porta ocupada.
3. Leia os logs em `.local/profiles/<perfil>/logs/`. Os logs de filhos são limitados a cerca de 5 MB por execução e têm segredos redigidos por padrão.
4. Para falhas de build, leia `.local/evidence/memory-build.log` e `gateway-build.log`.
5. `mcp`: confirma o handshake e o escopo, sem depender de cliente nativo.

## Quando parar

- Não apague `.local/engines/`, `.local/profiles/` ou `.local/client-backups/` como primeiro passo. Esses diretórios podem conter o único estado que permite recuperação.
- Se o problema envolver `ai-memory purge-project`, `reset` ou `restore`, pare e leia [operação e recuperação](../runbooks/README.md) antes de executar qualquer comando.
