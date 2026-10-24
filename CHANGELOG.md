# Changelog

Propósito: registrar as mudanças de cada versão da suíte, em ordem cronológica inversa. Público: usuários e mantenedores. Data: 2026-10-23.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## Não lançado

Gaps G1 a G3 de paridade com a instalação original do AI Memory, validados conforme [progress.md](progress.md). Marco de estabilização 3 (ciclo de vida do Gateway, supervisor, harness e isolamento de testes), também em [progress.md](progress.md).

### Adicionado

- Busca semântica local: embeddings com o modelo all-MiniLM-L6-v2 (384 dimensões) dentro do motor de memória. O modelo é verificado por sha256 e provisionado por perfil a partir de cache verificado ou da instalação original. A opção `memory.semanticSearch` controla o recurso (padrão `true`). ([ADR 0007](docs/architecture/adr/0007-local-semantic-memory.md))
- Comando `migrate-history --from <dir> [--apply]`: importa o histórico da instalação original do AI Memory por inserção aditiva, com IDs preservados, dry-run por padrão, backup antes do apply, transação única e relatório JSON. ([ADR 0008](docs/architecture/adr/0008-history-migration.md) e [guia](docs/guides/migration.md))
- Hooks `PreCompact`, `Stop`, `SubagentStart` e `SubagentStop`, com schema por evento. `PreCompact` e `Stop` passam a ser instalados também no Codex; os eventos de subagente só no Claude Code. O Claude recebe 9 eventos e o Codex, 7, como a instalação original.
- Guia de migração e runbook de rollback da migração.
- Migração com escopo: `migrate-history --project <workspace>/<projeto> [--as <workspace>/<projeto>]` copia só um projeto de origem para um projeto existente no destino. Handoffs com `cwd` fora da raiz do projeto de destino não são inseridos e são contados em `excluded.handoffsOutsideProject`. ([guia](docs/guides/migration.md#migração-por-projeto))
- Registro de hooks ignorados em `<perfil>/logs/hook-skips.log` (`memory-disabled` e `no-scope-marker`), sem `cwd`, caminhos, ids de sessão nem payload.
- Bridge MCP com sessão para o Claude: `CLAUDE_CODE_SESSION_ID` validado é repassado ao motor, que resolve o projeto pela sessão. ([API](docs/api/hooks-and-bridge.md#bridge-mcp))
- Testes da migração com escopo, da bridge com sessão e do registro de hooks ignorados.
- Módulo `src/gateways.ts`: descobre as portas dos gateways do launcher upstream (claude 8789, codex 8790) a partir da instalação e sonda `/health` somente em `127.0.0.1` e `localhost`, sem texto de erro e com timeout de 1 s. Os gateways continuam sendo iniciados e parados pelo launcher. ([ADR 0009](docs/architecture/adr/0009-gateway-ownership-and-recovery.md))
- `doctor` passa a mostrar `gateways` (claude e codex) e `conflicts`, com as portas de perfil que coincidem com um gateway upstream. ([API](docs/api/cli.md#saída-de-doctor-gateways))
- Reinício automático limitado: um serviço que cai depois de `ready` é reiniciado até 3 vezes em 60 s, com espera de 1 s, 2 s e 4 s. `/status` mostra o estado `restarting` e o mapa `restarts`. Esgotado o orçamento, a fase vai para `failed` e o supervisor encerra. ([API](docs/api/supervisor-http.md#reinício-automático), [operação](docs/runbooks/operations.md#recuperação-automática))
- Painel unificado do Jev Gateway, restaurado: um único iframe do agregador (Codex se estiver em execução, senão Claude), com `?peers=` para as demais portas configuradas, CSP `frame-src` restrita às origens de loopback do agregador e aviso "Gateways offline" quando nenhum gateway responde. ([ADR 0010](docs/architecture/adr/0010-unified-dashboard.md))
- Rota `GET /gateways/status` no painel local: estado, histórico do log, modelos, comparação com e sem Jev, custo estimado e eco dos preços; sem chave, `pid`, URL de upstream com credenciais ou texto de prompt; cache de 5 s; `Host` exato; somente `GET`. ([API](docs/api/supervisor-http.md#painel-local), [T30](docs/security/threat-model.md))
- Observabilidade de tokens complementar ao painel incorporado: seção com o histórico do log do launcher por cliente e combinado, tabela por modelo, custo estimado com preços configurados (`observability.pricing`, sem valores padrão) e comparação com e sem Jev. Auditoria de 2026-10-22 em [otimização de tokens](docs/guides/token-optimization.md): 304,6 M tokens de entrada do Jev, nenhuma chamada evitada e sem período de referência. ([ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md))
- Experimento de roteamento por cliente em `gatewayExperiment` (`default`, `shadow` ou `metering`). ([configuração](docs/guides/configuration.md#experimento-de-roteamento-e-preços))
- Teste de regressão do hook do Codex no Windows (win32): executa o comando real gerado pelo `clients install codex` com `powershell.exe -Command` e confirma que o `hook.js` inicia.
- Integração com o Antigravity CLI (`agy` 1.4.5): `jev-memory clients install|remove|check antigravity [dir]` registra hooks em `.agents/hooks.json` e a entrada MCP global `jev_memory_suite`, com o mesmo modelo transacional de Claude e Codex. ([guia](docs/guides/clients.md#antigravity-cli-agy), [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md))
- Launcher `jev-memory-agy` (e `jev-memory agy`), que finaliza ao sair as sessões do próprio lançamento, e o comando `jev-memory agy-finalize` para sessões que não foram finalizadas.
- Validação real do agy na CLI: sessão capturada com `agent_kind` `antigravity-cli`, handoff entregue na sessão seguinte e `memory_status` pelo MCP. IDE e App não verificados.
- Headroom opcional para o Claude (`headroom.enabled`, desligado por padrão): proxy externo de compressão de contexto, com versão fixada (`headroom.version`, 0.41.0). O supervisor o inicia depois de `ready`, e o `jev-memory-claude` o usa com fallback antes de o cliente iniciar. Não é vendorizado. Na fase 1 só o Claude era coberto; o Codex entra na fase 2 (ver a entrada seguinte). Medições e limites em [otimização de tokens](docs/guides/token-optimization.md#headroom-opcional-claude); decisão em [ADR 0013](docs/architecture/adr/0013-headroom-context-compression.md); riscos em [T38 a T42](docs/security/threat-model.md); teste `npm run test:headroom` (7/7).

- Headroom para o Codex (`headroom.codex`, com `headroom.enabled`, desligado por padrão): o Codex com login ChatGPT passa pelo Headroom e depois pelo gateway Jev codex, por um shim de runtime versionado (`patches/headroom/0.41.0/jms_headroom_shim.py`), sem editar a instalação do Headroom. O shim aponta as rotas do Codex ao gateway e recusa conexões fora do loopback. `headroom.python` fixa o interpretador do `headroom-ai`. Se o modo Codex falhar, o Claude segue no Headroom e `headroomCodexReason` mostra o motivo. `jev-memory codex` usa o Headroom com fallback para `jev-codex`. Validação: `npm run test:headroom-codex` 11/11, com backend ChatGPT simulado; login ChatGPT real não validado. ([ADR 0014](docs/architecture/adr/0014-headroom-codex-routing.md), [operação](docs/runbooks/operations.md#headroom-com-codex))

### Alterado

- Validação de portas: `headroom.port` entra na regra de portas distintas, que passa a valer para cinco portas. Perfis antigos recebem o padrão 18880. Perfis de projeto externo recebem uma quinta porta alocada.
- Painel: uma interface nativa criada em 2026-10-22 foi retirada, e a integração da [ADR 0010](docs/architecture/adr/0010-unified-dashboard.md) foi mantida. A [ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md) passa a registrar a observabilidade de tokens complementar. Modelo de ameaças: T32 adicionada (provedor do Jev); T31 retirada; T30 atualizada.
- Perfis novos gravam `embedding_provider = "local"` no lugar de `none`. Em perfis existentes, a linha gerida pela suíte é sincronizada a cada `start`; um provedor configurado pelo usuário não é alterado.
- Hooks `PreCompact`, `Stop`, `SubagentStart` e `SubagentStop` respondem `{}` fixo, sem `decision`.
- `transcript_path`, `agent_transcript_path` e `last_assistant_message` são removidos do payload antes de chegar ao motor.
- Codex com `subagent-start` ou `subagent-stop` é rejeitado.
- Registros do Claude passam a usar `bridge.js <perfil> claude-code`. Para atualizar um registro existente, rode `clients install claude <dir>` e abra uma nova sessão. O Codex mantém a bridge sem sessão.
- Pendente: captura em sessão interativa (TUI) do Claude Code. Os 9 eventos do Claude foram verificados em sessões reais no marco 3, com `PreCompact` confirmado por `/compact`. A captura real do Codex CLI foi validada no Farol, com bypass de confiança só naquela invocação. Pendentes: a revisão normal dos 7 hooks do Codex em `/hooks` (ação do usuário) e a validação do Codex Desktop, que segue não verificada.
- Pendente: rotação da credencial que ficou exposta na configuração global do Codex (ação do usuário). A suíte não altera credenciais nem configuração global.

### Corrigido

- Headroom: a dependência litellm buscava a tabela de preços em `raw.githubusercontent.com` ao ser importada, apesar de `HEADROOM_OFFLINE`. `headroomEnv` passa a definir `LITELLM_LOCAL_MODEL_COST_MAP=True`, o que vale também para o Claude.
- Busca vetorial estava desligada em perfis novos, e as consultas dependiam só do léxico.
- Eventos `PreCompact` e `Stop` não eram instalados, e `SubagentStart` e `SubagentStop` também não eram instalados no Claude Code.
- O histórico da instalação original não estava disponível no perfil da suíte.
- `SubagentStop` real do Claude Code era rejeitado (`agent_type:too_small`) porque o schema exigia `agent_type` não vazio; o cliente real envia string vazia. O schema passa a aceitar string vazia e mantém presença, tipo e limite de 200 caracteres. Testes com o formato real do payload. ([progress.md](progress.md))
- Claude sem sessão caía no último projeto ativo do servidor (`shared_slot`), que podia ser de outro projeto. A bridge com sessão corrige o caso para o Claude; o Codex segue sem correlação de sessão. ([ameaça T28](docs/security/threat-model.md))
- Histórico dividido entre escopos foi reunido: `default/jev-memory-suite` foi para `jev-suite/jev-memory-suite` com `move-session`, e o histórico do Farol foi levado ao perfil do próprio projeto. Dados locais, sem alteração de código. ([progress.md](progress.md), Marco de estabilizacao 2)
- Codex no Windows não capturava nada: o comando do hook não tinha o operador de chamada `& ` do PowerShell, e o Codex executa hooks por PowerShell, que não analisa caminho entre aspas no início. Registros novos usam `& ` no Codex/Windows; registros antigos precisam de `clients install codex <dir>` e revisão dos hooks em `/hooks`. ([progress.md](progress.md))
- Painel incorporava `http://localhost:8790/dashboard` fixo, sem considerar a porta do cliente. Agora cada cliente usa a porta do próprio gateway upstream, descoberta a partir da instalação. ([ADR 0009](docs/architecture/adr/0009-gateway-ownership-and-recovery.md))
- Painel com dois iframes, que repetiam a mesma visão do agregador e dobravam as consultas ao upstream. Agora há um único iframe. ([ADR 0010](docs/architecture/adr/0010-unified-dashboard.md))
- Iframe sem `?peers=`: um gateway em porta fora do padrão não aparecia no agregador. A URL agora inclui as portas configuradas. ([ADR 0010](docs/architecture/adr/0010-unified-dashboard.md))
- Iframe quebrado quando um gateway estava parado: a lista era resolvida só na partida do supervisor. Agora o estado é consultado a cada 5 s e aparece o fallback "Gateways offline" em vez de um quadro com erro. ([ADR 0010](docs/architecture/adr/0010-unified-dashboard.md))
- Isolamento dos testes: perfis de teste usavam fixtures dentro do repositório e liam o `.ai-memory.toml` e o registro de cliente da raiz. As 3 falhas de `test/launch.test.ts` e a falha "both disabled" de `npm run test:e2e` foram corrigidas. Os perfis de teste recebem `projectRoot` em diretório temporário fora do repositório, e uma asserção da bridge passou a esperar `[name, 'claude-code']`. Estado atual: `npm test` 197/197 e `npm run test:e2e` 4/4. ([guia de desenvolvimento](docs/guides/development.md#isolamento-de-testes))
- Perfis de teste criados por `npm run test:e2e`, `npm run test:projects` e pelo teste de ciclo de vida não eram removidos ao final. Agora são parados e removidos. Perfis de execuções antigas não foram apagados, e a remoção depende de aprovação.

### Segurança

- Headroom no Codex: T43 a T46 cobrem patch de runtime dependente da versão, egress fora do loopback, credenciais OAuth do Codex no processo do Headroom e interpretador escolhido pelo ambiente. Registrados no [modelo de ameaças](docs/security/threat-model.md) e na [ADR 0014](docs/architecture/adr/0014-headroom-codex-routing.md).
- O agy carrega `.agents/hooks.json` de qualquer repositório sem prompt de confiança. Risco do upstream, registrado como T33 no [modelo de ameaças](docs/security/threat-model.md).
- Os hooks do agy não leem transcrições, removem `transcriptPath` e aceitam `artifactDirectoryPath` somente no diretório de artefatos da CLI da conversa.
- O MCP global do agy é compartilhado entre projetos. O escopo deve ser informado em cada chamada (T36).

## [0.1.0] - 2026-10-22

Primeira publicação. Validada apenas no Windows 10. O estado de cada cliente está em [tests.json](tests.json): Claude Code CLI aprovado; Codex CLI parcial (MCP aprovado, captura por hooks pendente da confiança nativa); Codex Desktop pendente de validação dentro do app.

### Adicionado

- Gerenciador local que instala, configura e inicia o Jev Gateway 0.5.1 e o AI Memory 3.1.2, importados sem modificação em `upstream/` por `git subtree --squash`.
- Comandos `init`, `install`, `start`, `stop`, `restart`, `status`, `doctor`, `recover`, `mcp`, `dashboard`, `launch`, `clients` e os atalhos `codex` e `claude`.
- Instalações versionadas e imutáveis dos motores, com ponteiro atômico e sem sobrescrever executáveis em uso.
- Registro transacional de MCP e hooks em Claude CLI e Codex CLI, com preflight, backup, rollback e preservação de MCPs e configurações existentes.
- Hooks de captura SessionStart, UserPromptSubmit, PreToolUse e PostToolUse, com validação de payload antes de gravar.
- Quatro modos de execução (gateway, memória, ambos e nenhum), verificados por testes E2E com processos reais.
- Painel local em `127.0.0.1` (`src/dashboard.ts`), com o painel de memória do AI Memory e a incorporação do painel do Jev Gateway.
- Suporte a projetos externos: lançamento a partir de qualquer pasta, com perfis, bancos e portas isolados pela raiz Git ou pela pasta ([ADR 0006](docs/architecture/adr/0006-external-projects.md)).
- Escopo de memória por marcador `.ai-memory.toml`, verificado dentro da fronteira do projeto (`src/scope.ts`).
- Comandos curtos `jev-memory`, `jev-memory-codex` e `jev-memory-claude` (launchers `.cmd` em `bin/`), e o ativador `scripts/enable-shell.mjs`, que com `--persist` acrescenta `bin/` ao PATH do usuário preservando as entradas existentes.
- Documentação de arquitetura, ADRs, API, guias, segurança e runbooks.

### Alterado

- Launchers de Claude e Codex passam a usar o perfil do projeto atual ou o informado com `--dir`.
- Correções durante a validação: falhas de launch do Claude e do Codex, descoberta do executável do Codex e fixture de regressão do painel.

### Segurança

- Serviços escutam apenas em `127.0.0.1`. O token do roteador é separado do token de controle, e testes E2E comprovam o 401 em ambos os sentidos.
- Hooks rejeitam raízes fora da fronteira, escapes, junctions e payloads inválidos, com limites de stdin, stdout e profundidade. A leitura de MCP é limitada a 4 MB.
- O painel grava títulos, caminhos e nomes de projeto apenas como texto.
- Revisão OWASP Top 10, ASVS e LGPD documentada em [docs/security](docs/security/README.md). Atualizações de `smol-toml` 1.9.1 e `pnpm` 10.34.6.
- Pendências registradas: `esbuild` (baixa, uso de desenvolvimento), `hono` (moderada, `serveStatic` não usado), `paste` sem manutenção, `cargo deny` não executado e permissões de arquivo 0600 sem efeito no Windows.
- A alteração do PATH do usuário só ocorre com `scripts/enable-shell.mjs --persist`, após backup local.
