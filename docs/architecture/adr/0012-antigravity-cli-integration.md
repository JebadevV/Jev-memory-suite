# ADR 0012 — integração com o Antigravity CLI (agy): hooks de workspace, MCP global e finalização pelo launcher

Propósito: registrar por que a suíte integra o Antigravity CLI (`agy`) pelos hooks do workspace e pelo MCP global, por que usa um subconjunto dos eventos, como a sessão é finalizada sem evento de fim de sessão e quais riscos permanecem. Público: mantenedores e revisores de segurança. Data: 2026-10-23. Estado: aceito (validado na CLI agy 1.4.5; IDE e App não verificados).

## Contexto

O Antigravity CLI lê hooks de `.agents/hooks.json` no workspace e lê MCP de usuário somente em `~/.gemini/config/mcp_config.json`. Três fatos moldam a integração:

- O agy não tem evento de fim de sessão. Ele tem `SessionStart` e `PostInvocation`, mas o motor nativo do AI Memory inicia a sessão só em `PreInvocation` com `invocationNum = 0`, e deduplica por `conversationId`. O `invocationNum` volta a 0 a cada turno do usuário. `Stop` é fim de turno.
- O Jev Gateway faz proxy de OpenAI e Anthropic, e desde a versão 0.5.1 tem a rota Gemini API com API key (`jev-gemini`). O agy não usa essa rota: fala com a Code Assist API interna e usa a conta Google do próprio usuário.
- O arquivo global `~/.gemini/config/hooks.json` é compartilhado com a IDE e o App, e fica fora do escopo de um workspace.

## Decisão

1. **Registro por workspace, com o modelo transacional de Claude e Codex.** `clients install|remove|check antigravity [dir]` gerencia `.agents/hooks.json` (grupo `jev-memory-suite`), `.ai-memory.toml` e `.jev-memory-antigravity.json`. Há manifesto de propriedade, backup em `.local/client-backups/`, escrita atômica, rollback, idempotência, detecção de alteração e preservação de outros grupos. O BOM é tolerado na leitura e o arquivo é gravado sem BOM.
2. **Eventos usados:** `PreInvocation` para `session-start`, além de `PreToolUse`, `PostToolUse` e `Stop`. `SessionStart` e `PostInvocation` não são usados, pelo motivo descrito no contexto.
3. **Saídas fixas e falha aberta.** `PreToolUse` responde sempre `{"decision":"allow"}`. A suíte só observa e não contorna os prompts de permissão do agy. O hook sempre sai com código 0, inclusive em erro interno, e registra diagnósticos sem conteúdo. `Stop` responde `{"decision":""}`. O handoff é injetado por `injectSteps[].ephemeralMessage`.
4. **Filtro de superfície.** O hook processa apenas payloads cujo `artifactDirectoryPath` está em `~/.gemini/antigravity-cli/brain/<conversationId>`. Os demais são ignorados com `skip=non-cli-surface`.
5. **MCP global.** A instalação registra `jev_memory_suite` com `agy mcp add`, somente se a entrada não existir, e recusa se o nome já pertencer a outro servidor. Se o arquivo começar com BOM UTF-8, a suíte grava o backup `mcp_config.json.jev-bom-<timestamp>.bak` e remove exatamente o BOM. `clients remove` mantém a entrada, porque ela é compartilhada; a remoção é manual, com `agy mcp remove jev_memory_suite`. O bridge é stateless, por isso o agente informa `workspace` e `project` em cada chamada.
6. **Launcher.** `jev-memory-agy` (ou `jev-memory agy`) resolve o `agy` pelo PATH ou em `%LOCALAPPDATA%\agy\bin\agy.exe`, verifica memória, hooks, MCP e marcador (apenas avisos), repassa argumentos, diretório e stdio, e devolve o código de saída do `agy`. Não há roteamento pelo Jev Gateway.
7. **Finalização pelo launcher.** O launcher define `JEV_MEMORY_AGY_LAUNCH` com um id aleatório. Os hooks registram os ids de conversa daquele lançamento. Ao sair, o launcher executa `ai-memory finalize-session --agent antigravity-cli --session-id <id> --reopen` somente para esses ids, e apaga o registro. Falhas geram aviso. Para sessões fora do launcher ou após queda, o fallback é `jev-memory agy-finalize [--session <id>]`. Acréscimo do Marco 3 (2026-10-24): cada lançamento grava também `<launchId>.owner.json` (`pid`, `childPid` opcional, gravado depois do spawn do agy, `startedAt`, `workspace`, `project`, `cwd`; sem conteúdo), ao lado de `<launchId>.sessions`; os dois são removidos ao finalizar. Fechar a janela do console envia `SIGHUP` ao launcher, que finaliza o próprio lançamento uma única vez, com prazo total de cerca de 7 s; o que não terminar nesse prazo fica registrado para a recuperação. Antes de cada lançamento, a recuperação automática finaliza só os lançamentos cujo dono tem pid morto (o do wrapper e, se houver, o `childPid`), com claim atômico por rename (`.sessions.recovering-<pid>`; um claim de processo morto pode ser retomado), usando o escopo gravado. Dono vivo, owner inválido ou escopo divergente do config atual não são tocados e geram aviso. Registros sem owner, de versões anteriores, ficam para `--recover --legacy`. Acréscimo de 2026-10-24: a autofinalização (saída normal ou SIGHUP) também usa claim por rename, em até 3 passadas, sem `unlink` incondicional. Um id anexado por hook durante a finalização vai para um novo `.sessions` e é pego na passada seguinte. Rename bloqueado no Windows (EBUSY, EPERM, EACCES) tem 5 novas tentativas de 100 ms. Ao finalizar com sucesso, o breadcrumb do feed do agy é limpo (ver [ADR 0011](0011-native-dashboard-and-token-observability.md)). Detalhes em [operação](../../runbooks/operations.md#recuperação-e-fechamento-da-janela).
8. **Caminhos no Windows.** Os comandos de hook são tokens simples, sem shell, com `node.exe` no caminho 8.3. A instalação falha com erro claro se algum caminho ainda tiver espaços ou caracteres de shell.

## Alternativas rejeitadas

- **Iniciar e finalizar a sessão com `SessionStart` e `PostInvocation`.** O motor nativo só inicia sessão em `PreInvocation` com `invocationNum = 0`, então esses eventos não cumprem o papel.
- **Finalizar a sessão no `Stop`.** `Stop` é fim de turno. Finalizaria a sessão a cada resposta.
- **Finalizar todas as sessões agy abertas.** Poderia encerrar sessões concorrentes e não relacionadas. Por isso a finalização usa só os ids do próprio lançamento.
- **Auto-aprovar ferramentas pelo hook (`auto_approve` ou saída que permita sem prompt).** Contornaria as permissões do agy. Não foi adotado.
- **Roteamento pelo Jev Gateway para o agy.** O gateway só faz proxy de OpenAI e Anthropic, e o agy usa a conta Google do usuário. Revista no [ADR 0015](0015-jev-gateway-antigravity-code-assist.md): o motivo acima não vale mais. O agy aceita a variável não documentada `CLOUD_CODE_URL`, e o Jev Gateway, com patch versionado, passou a receber o tráfego Code Assist.
- **Editar `~/.gemini/config/hooks.json`.** Arquivo global compartilhado com IDE e App, fora do escopo de um workspace.
- **Remover a entrada MCP global em `clients remove`.** Outros projetos podem depender dela.

## Consequências

- O registro vale para o workspace, mas a entrada MCP vale para todos os projetos do usuário. O isolamento depende de `workspace` e `project` explícitos nas chamadas.
- Sem evento de fim de sessão, uma queda forçada do launcher pode deixar a sessão aberta. A recuperação automática finaliza esses lançamentos antes do próximo lançamento, quando o dono morreu. O comando manual `jev-memory agy-finalize --recover` faz o mesmo sob demanda e inclui escopo divergente, com o escopo gravado; `--legacy` também cobre registros sem dono, depois de confirmar que nenhum agy está rodando.
- Em modo headless (`-p`), ferramentas MCP são negadas sem `permissions.allow` ou `--dangerously-skip-permissions`. A suíte não altera permissões.
- IDE e App leem o mesmo arquivo de workspace, mas não foram verificados. O hook ignora payloads fora do diretório de artefatos da CLI.
- Caminhos com espaços impedem o registro no Windows, até que o repositório seja movido ou os nomes 8.3 estejam habilitados.
- **Dono com `childPid` (2026-10-24).** Fechar o wrapper com `taskkill /F` não encerra o `agy.exe` filho, que pode continuar gravando ids. Por isso o dono é considerado vivo enquanto o filho estiver vivo. Owner antigo sem `childPid` continua válido. Isso fecha a janela estreita de SIGHUP registrada no Marco 3: um id que chegue depois da última passada fica registrado com o owner para a próxima recuperação.
- **Breadcrumb do feed (2026-10-24).** O agy não tem session-end, então a limpeza de `active-session.<agente>` depois de cada finalização bem-sucedida é o único ponto que remove o breadcrumb dele. O detalhe está no [ADR 0011](0011-native-dashboard-and-token-observability.md).

## Segurança

Riscos residuais, registrados em [T33 a T37](../../security/threat-model.md):

- O agy carrega `.agents/hooks.json` de qualquer repositório, sem prompt de confiança, e executa os comandos ali definidos. É comportamento do upstream, e a suíte não o controla (T33).
- Os payloads passam por validação estrita: zod, limites de tamanho e profundidade, fronteira do workspace e padrão de `conversationId`. `transcriptPath` é removido e nunca lido. `artifactDirectoryPath` é mantido apenas dentro do diretório de artefatos da conversa (T34).
- O handoff injetado é dado histórico não confiável, como qualquer conteúdo da memória (T35 e T6).
- A entrada MCP global é compartilhada entre projetos. O isolamento depende de escopo explícito (T36).
- O `PreToolUse` observa e não concede permissões. A escolha de auto-aprovação ou `--dangerously-skip-permissions` é do operador (T37).

## Validação

Dados de 2026-10-23, com agy 1.4.5, Windows 10 e AI Memory 3.1.2:

- **Sessão real:** `jev-memory-agy -p` capturou uma sessão com `agent_kind` `antigravity-cli`, com observações de session-start, pre-tool-use, post-tool-use, stop e session-end (finalizada). Nenhum erro de hook.
- **Handoff:** um handoff criado com `memory_handoff_begin` numa sessão foi entregue na sessão seguinte. O modelo viu o marcador.
- **MCP:** `memory_status` pelo MCP do agy retornou o projeto correto.
- **Não validado:** IDE e App.
- **Nota (2026-10-24):** a validação acima foi feita no agy 1.4.5. O agy se atualizou sozinho para 1.4.7 em 2026-10-24. Nessa versão, a validação registrada é só da rota Code Assist, no [ADR 0015](0015-jev-gateway-antigravity-code-assist.md). Não consta revalidação de hooks e MCP na 1.4.7.
- **Travas de arquivo no Windows (2026-10-24):** `finalizeAgyLaunch` e `AgyRecoveryDeps` recebem `fsOps` (`rename`, `sleep`) por injeção, sem mudança de produção. Os testes cobrem EBUSY duas vezes e depois sucesso; EBUSY sempre, mantendo arquivos e owner, com recuperação posterior; EPERM e EACCES como EBUSY; EINVAL sem retry e sem lançar; EBUSY na recuperação com `claimed-by-other`; e exatamente 6 tentativas (1 + 5) com 5 esperas. Isso fecha o risco "caminho EBUSY sem teste" (check `M-agy-8` em [tests.json](../../../tests.json)).

Registro: [progress.md](../../../progress.md), seção "Antigravity CLI (agy) 1.4.5: integração (2026-10-23)", e check `M-agy-1` em [tests.json](../../../tests.json). Procedimentos: [clientes](../../guides/clients.md#antigravity-cli-agy) e [operação](../../runbooks/operations.md#sessões-do-antigravity-cli-agy).

## Acréscimo (2026-10-25): `user-prompt` nativo por turno

Este acréscimo não reescreve as decisões acima. Ele corrige a finalização de sessões agy sem ferramentas, que ficava fora do modelo descrito no contexto.

- **Causa.** O agy não emite evento de prompt. O upstream ai-memory 3.1.2 trata como lifecycle-only uma sessão sem observação substantiva (`kind IN ('user-prompt','pre-tool-use','post-tool-use')`). No session-end, essa sessão devolve ao pool o handoff que reivindicou no session-start. Assim, handoffs entregues a uma sessão agy sem ferramentas ficavam `open` e eram reentregues. Evidência no audit log do perfil `default`: a sessão `ac25592a-…` aceitou o handoff às 15:52:59.697Z, e o motor o liberou às 15:53:06.193Z (`release_lifecycle_only_handoff`).
- **Decisão.** Para `antigravity-cli`, em `session-start` com `invocationNum === 0`, o hook faz um segundo spawn nativo `user-prompt` depois do session-start. O texto é fixo: `AGY_USER_TURN_PROMPT`, "Antigravity user turn (the agy hook contract does not expose the prompt text)" (substituído por `<agy-user-turn/>`, ver a sub-nota de 2026-10-25 abaixo). O contrato de hook do agy não expõe o texto do prompt, então ele nunca é lido. Uma falha desse spawn vai para `hook-errors.log` e não afeta a saída do session-start. Esse `user-prompt` não busca handoff nem injeta contexto para o agy. Emite um por turno do usuário; `invocationNum > 0` não emite.
- **Consequências.** Sessões agy sem ferramentas passam a gerar página de resumo e handoff automático, como Claude e Codex. O texto fixo aparece como prompt nessas sessões. O custo de execução é um spawn extra por turno.
- **Validação.** Quatro testes unitários em `test/hook.test.ts`; E2E com motor real em `test/e2e.ts` ("memory only: a tool-less Antigravity session consumes its handoff exactly once"). Com a emissão desligada, o teste falha em "the claimed handoff was re-opened by a tool-less session end". Não validado ao vivo com agy real (exige sessão aprovada e cota Google). Registro: [progress.md](../../../progress.md), seção de 2026-10-25, e check `M-agy-handoff-1` em [tests.json](../../../tests.json). Rollback: [operação](../../runbooks/operations.md#rollback-da-correção-de-handoff-do-agy-e-do-painel).

### Sub-nota (2026-10-25, 17:04Z): marcador `<agy-user-turn/>`

Esta sub-nota não reescreve o acréscimo acima. Ela troca o texto fixo do turno.

- **Mudança.** `AGY_USER_TURN_PROMPT` passa de "Antigravity user turn (...)" para `<agy-user-turn/>`. Build em 2026-10-25 17:04:11Z. Backup anterior: `.local/backups/agy-marker-20261025T170408Z`.
- **Motivo.** O texto em inglês seria gravado como prompt real e aparecia em resumos de handoff automático, em perguntas em aberto e em títulos. O marcador segue o predicado nativo `looks_like_markup_block` (ai-memory-core, `scaffolding.rs`), o mesmo tratamento dado ao `<task-notification>` do Claude. A observação continua `user-prompt`, então a sessão segue substantiva e o handoff reivindicado não é reaberto.
- **Prova.** No E2E com o texto antigo, o handoff automático saiu com `open_questions: ["Continue from: Antigravity user turn (...)"]`. Com o marcador, `open_questions: []` e `summary: "Session ended; 5 observations recorded."`.
- **Resíduo.** A lista `## Prompts` da página de sessão imprime o título bruto da observação, como acontece com as notificações do Claude, então o marcador pode aparecer ali. Os tokens `agy`, `user` e `turn` entram no índice FTS de observações.
- **Dados.** Nenhuma contaminação real: as bases SQLite dos perfis (leitura somente) não têm observação, handoff nem página agy com o texto antigo.
- **Validação.** Teste unitário do formato do marcador; E2E com motor real (contaminação, injeção no segundo turno, concorrência e ausência de replay). Não validado ao vivo com agy real. Registro: [progress.md](../../../progress.md), seção de 2026-10-25 "marcador do turno". Check `M-agy-handoff-2` em [tests.json](../../../tests.json).
