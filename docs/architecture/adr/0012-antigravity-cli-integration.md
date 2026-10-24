# ADR 0012 — integração com o Antigravity CLI (agy): hooks de workspace, MCP global e finalização pelo launcher

Propósito: registrar por que a suíte integra o Antigravity CLI (`agy`) pelos hooks do workspace e pelo MCP global, por que usa um subconjunto dos eventos, como a sessão é finalizada sem evento de fim de sessão e quais riscos permanecem. Público: mantenedores e revisores de segurança. Data: 2026-10-23. Estado: aceito (validado na CLI agy 1.4.5; IDE e App não verificados).

## Contexto

O Antigravity CLI lê hooks de `.agents/hooks.json` no workspace e lê MCP de usuário somente em `~/.gemini/config/mcp_config.json`. Três fatos moldam a integração:

- O agy não tem evento de fim de sessão. Ele tem `SessionStart` e `PostInvocation`, mas o motor nativo do AI Memory inicia a sessão só em `PreInvocation` com `invocationNum = 0`, e deduplica por `conversationId`. O `invocationNum` volta a 0 a cada turno do usuário. `Stop` é fim de turno.
- O Jev Gateway só faz proxy de OpenAI e Anthropic. O agy usa a conta Google do próprio usuário.
- O arquivo global `~/.gemini/config/hooks.json` é compartilhado com a IDE e o App, e fica fora do escopo de um workspace.

## Decisão

1. **Registro por workspace, com o modelo transacional de Claude e Codex.** `clients install|remove|check antigravity [dir]` gerencia `.agents/hooks.json` (grupo `jev-memory-suite`), `.ai-memory.toml` e `.jev-memory-antigravity.json`. Há manifesto de propriedade, backup em `.local/client-backups/`, escrita atômica, rollback, idempotência, detecção de alteração e preservação de outros grupos. O BOM é tolerado na leitura e o arquivo é gravado sem BOM.
2. **Eventos usados:** `PreInvocation` para `session-start`, além de `PreToolUse`, `PostToolUse` e `Stop`. `SessionStart` e `PostInvocation` não são usados, pelo motivo descrito no contexto.
3. **Saídas fixas e falha aberta.** `PreToolUse` responde sempre `{"decision":"allow"}`. A suíte só observa e não contorna os prompts de permissão do agy. O hook sempre sai com código 0, inclusive em erro interno, e registra diagnósticos sem conteúdo. `Stop` responde `{"decision":""}`. O handoff é injetado por `injectSteps[].ephemeralMessage`.
4. **Filtro de superfície.** O hook processa apenas payloads cujo `artifactDirectoryPath` está em `~/.gemini/antigravity-cli/brain/<conversationId>`. Os demais são ignorados com `skip=non-cli-surface`.
5. **MCP global.** A instalação registra `jev_memory_suite` com `agy mcp add`, somente se a entrada não existir, e recusa se o nome já pertencer a outro servidor. Se o arquivo começar com BOM UTF-8, a suíte grava o backup `mcp_config.json.jev-bom-<timestamp>.bak` e remove exatamente o BOM. `clients remove` mantém a entrada, porque ela é compartilhada; a remoção é manual, com `agy mcp remove jev_memory_suite`. O bridge é stateless, por isso o agente informa `workspace` e `project` em cada chamada.
6. **Launcher.** `jev-memory-agy` (ou `jev-memory agy`) resolve o `agy` pelo PATH ou em `%LOCALAPPDATA%\agy\bin\agy.exe`, verifica memória, hooks, MCP e marcador (apenas avisos), repassa argumentos, diretório e stdio, e devolve o código de saída do `agy`. Não há roteamento pelo Jev Gateway.
7. **Finalização pelo launcher.** O launcher define `JEV_MEMORY_AGY_LAUNCH` com um id aleatório. Os hooks registram os ids de conversa daquele lançamento. Ao sair, o launcher executa `ai-memory finalize-session --agent antigravity-cli --session-id <id> --reopen` somente para esses ids, e apaga o registro. Falhas geram aviso. Para sessões fora do launcher ou após queda, o fallback é `jev-memory agy-finalize [--session <id>]`.
8. **Caminhos no Windows.** Os comandos de hook são tokens simples, sem shell, com `node.exe` no caminho 8.3. A instalação falha com erro claro se algum caminho ainda tiver espaços ou caracteres de shell.

## Alternativas rejeitadas

- **Iniciar e finalizar a sessão com `SessionStart` e `PostInvocation`.** O motor nativo só inicia sessão em `PreInvocation` com `invocationNum = 0`, então esses eventos não cumprem o papel.
- **Finalizar a sessão no `Stop`.** `Stop` é fim de turno. Finalizaria a sessão a cada resposta.
- **Finalizar todas as sessões agy abertas.** Poderia encerrar sessões concorrentes e não relacionadas. Por isso a finalização usa só os ids do próprio lançamento.
- **Auto-aprovar ferramentas pelo hook (`auto_approve` ou saída que permita sem prompt).** Contornaria as permissões do agy. Não foi adotado.
- **Roteamento pelo Jev Gateway para o agy.** O gateway só faz proxy de OpenAI e Anthropic, e o agy usa a conta Google do usuário.
- **Editar `~/.gemini/config/hooks.json`.** Arquivo global compartilhado com IDE e App, fora do escopo de um workspace.
- **Remover a entrada MCP global em `clients remove`.** Outros projetos podem depender dela.

## Consequências

- O registro vale para o workspace, mas a entrada MCP vale para todos os projetos do usuário. O isolamento depende de `workspace` e `project` explícitos nas chamadas.
- Sem evento de fim de sessão, uma queda forçada do launcher pode deixar a sessão aberta. A suíte não garante finalização nesse caso; o operador usa `agy-finalize`.
- Em modo headless (`-p`), ferramentas MCP são negadas sem `permissions.allow` ou `--dangerously-skip-permissions`. A suíte não altera permissões.
- IDE e App leem o mesmo arquivo de workspace, mas não foram verificados. O hook ignora payloads fora do diretório de artefatos da CLI.
- Caminhos com espaços impedem o registro no Windows, até que o repositório seja movido ou os nomes 8.3 estejam habilitados.

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

Registro: [progress.md](../../../progress.md), seção "Antigravity CLI (agy) 1.4.5: integração (2026-10-23)", e check `M-agy-1` em [tests.json](../../../tests.json). Procedimentos: [clientes](../../guides/clients.md#antigravity-cli-agy) e [operação](../../runbooks/operations.md#sessões-do-antigravity-cli-agy).
