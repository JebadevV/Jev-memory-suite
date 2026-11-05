# Hooks e bridge MCP

Propósito: documentar o comando dos hooks nativos, os eventos por cliente, os payloads aceitos e seus limites, e a bridge MCP do perfil. Público: integradores e mantenedores. Data: 2026-10-25.

## Hooks nativos

Os clientes são registrados para executar:

```text
node <repo>/dist/src/hook.js <perfil> <claude-code|codex> <evento-nativo>
```

| Evento do cliente | Argumento `<evento-nativo>` | Claude Code | Codex | Saída do hook |
|---|---|---|---|---|
| `SessionStart` | `session-start` | sim | sim | Saída nativa do motor |
| `UserPromptSubmit` | `user-prompt` | sim | sim | Saída nativa do motor |
| `PreToolUse` | `pre-tool-use` | sim | sim | Saída nativa do motor |
| `PostToolUse` | `post-tool-use` | sim | sim | Saída nativa do motor |
| `SessionEnd` | `session-end` | sim | sim | Saída nativa do motor |
| `PreCompact` | `pre-compact` | sim | sim | `{}` fixo |
| `Stop` | `stop` | sim | sim | `{}` fixo |
| `SubagentStart` | `subagent-start` | sim | não | `{}` fixo |
| `SubagentStop` | `subagent-stop` | sim | não | `{}` fixo |

Claude Code recebe os 9 eventos. Codex recebe 7: não há eventos de subagente no Codex, e a instalação original também não os registrava. A lista vem de `hostEvents` em `src/hook.ts`. O Antigravity CLI usa outro conjunto de eventos e de contrato de saída, descrito em [Antigravity CLI (agy)](#antigravity-cli-agy).

No Windows, o comando registrado para o Codex começa com `& ` (operador de chamada do PowerShell), porque o Codex executa hooks com `powershell.exe -Command`. Sem o operador, o caminho entre aspas do node é erro de análise e o hook nunca roda. Reinstalar com `clients install codex <dir>` muda o hash dos hooks, então os 7 precisam ser revisados em `/hooks`. O comando do Claude Code não muda.

O registro usa matcher vazio (todos os casos) e timeout declarado de 25 s. O payload chega em stdin como JSON.

Os quatro eventos com saída `{}` fixa (`pre-compact`, `stop`, `subagent-start` e `subagent-stop`) não devolvem `decision`. Assim, o hook nunca bloqueia nem prolonga um turno, e o evento `Stop` não entra em loop. A saída nativa do motor é descartada para esses eventos, mas erros de execução continuam sendo reportados.

Codex com `subagent-start` ou `subagent-stop` é rejeitado com `Hook event not supported by agent`, antes de qualquer leitura de configuração.

### Validação, em ordem

Qualquer falha nestas etapas gera uma exceção interna com mensagem específica, mas o processo imprime apenas a mensagem genérica de [erros](#chamada-ao-ai-memory). Use os nomes abaixo para entender a causa em testes, não para depurar pelo stderr.

1. Agente em `{claude-code, codex, antigravity-cli}` e evento em allowlist. Caso contrário: `Untrusted hook agent/event`.
2. Profundidade do JSON até 32 níveis, verificada de forma iterativa.
3. Stdin até 1 MB. Acima disso: `Hook payload too large`.
4. Schema do evento. Campos comuns: `session_id` obrigatório (`[A-Za-z0-9._:-]`, até 200), `cwd` obrigatório (até 2048), `hook_event_name` opcional, `model` e `permission_mode` até 200 e 64, `tool_use_id` até 200.
5. `hook_event_name`, se presente, deve corresponder ao evento.
6. `cwd` é canonizado com `realpath` e deve ser a raiz do workspace ou um descendente. Links e junctions são recusados.
7. `transcript_path`, `agent_transcript_path` e `last_assistant_message` são removidos do payload. O motor não lê transcrições nem recebe o texto final do assistente.
8. Só então a configuração do perfil é lida. Se a memória estiver desabilitada, o hook retorna vazio e registra o motivo, como descrito abaixo.

### Registro de ignorados

Quando o hook não captura por um destes motivos, a saída para o cliente continua `''` (nada muda para o host), e uma linha é gravada em `<perfil>/logs/hook-skips.log`:

| Motivo (`skip=`) | Quando ocorre |
|---|---|
| `memory-disabled` | A memória está desabilitada no perfil |
| `no-scope-marker` | Não há marcador `.ai-memory.toml` nos ancestrais do `cwd` |

Cada linha tem o formato `<timestamp> agent=<agente> event=<evento> skip=<motivo>`. A linha não contém `cwd`, caminhos, ids de sessão nem payload. Erros de validação continuam em `hook-errors.log`, não aqui.

### Campos específicos por evento

| Evento | Campos adicionais |
|---|---|
| `session-start` | `source` (até 64) |
| `user-prompt` | `prompt` obrigatório (até 200000) |
| `pre-tool-use`, `post-tool-use` | `tool_name` obrigatório (até 200), `tool_input` e `tool_response` opcionais |
| `session-end` | `reason` (até 200) |
| `pre-compact` | `trigger` (até 32) e `custom_instructions` (até 20000), ambos opcionais |
| `stop` | `stop_hook_active` (booleano) e `last_assistant_message` (até 200000, removido antes do motor) |
| `subagent-start` | `agent_id` obrigatório (mesmo formato de `session_id`, até 200) e `agent_type` obrigatório como string de até 200 caracteres. O valor vazio é aceito, porque o Claude Code real envia `agent_type` vazio no `SubagentStop`; ausência, `null` e tipos que não sejam string são rejeitados |
| `subagent-stop` | Os campos de `subagent-start`, mais `stop_hook_active`, `last_assistant_message` e `agent_transcript_path` (até 4096, removido antes do motor) |

Os schemas são `looseObject`: campos extras são aceitos e repassados ao AI Memory.

### Chamada ao AI Memory

```text
ai-memory --data-dir <perfil>/memory hook --event <evento> --agent <codex|claude-code> \
  --server-url http://127.0.0.1:<memory.port> --capture-mode allowlist
```

O payload vai pelo stdin do processo. Limites:

- Timeout de 20 s, após o qual o processo é encerrado e o hook falha.
- Stdout até 256 KiB. Acima disso, o processo é encerrado e o hook falha (falha fechada).
- Erros não expõem detalhes: stderr recebe `Suite hook rejected or unavailable; run doctor` e o código de saída é 1.

Nota de compatibilidade: as leituras de sessão do AI Memory esperam IDs em UUID. Claude Code e Codex enviam UUID, mas a validação aceita outros formatos.

### Eventos de subagente no motor

Os eventos `subagent-start` e `subagent-stop` são gravados pelo motor como observações do tipo `other`, com corpo vazio. O `agent_id` é usado só para roteamento interno e não é persistido. Esse é o mesmo formato da instalação original, que tinha 171 observações `other` vazias de subagente. Essa limitação é do motor e não foi alterada pela suíte.

Hooks de subagente rodam em paralelo. Por isso, o registro da sessão ativa (`active-session`) usa um arquivo temporário com nome único, e não um nome fixo.

## Antigravity CLI (agy)

Os hooks ficam em `.agents/hooks.json` do workspace, no grupo `jev-memory-suite`. Eventos usados:

| Evento do agy | Argumento `<evento-nativo>` | Saída do hook |
|---|---|---|
| `PreInvocation` | `session-start` | Saída nativa do motor. O handoff pendente é entregue por `injectSteps[].ephemeralMessage` |
| `PreInvocation` com `invocationNum = 0`, depois do session-start | `user-prompt` | Sem contexto injetado. Texto fixo, sem conteúdo do prompt |
| `PreToolUse` | `pre-tool-use` | `{"decision":"allow"}` |
| `PostToolUse` | `post-tool-use` | Saída nativa do motor |
| `Stop` | `stop` | `{"decision":""}` |

`SessionStart` e `PostInvocation` não são usados. O motor nativo do AI Memory inicia a sessão só em `PreInvocation` com `invocationNum = 0`, e deduplica por `conversationId`. O `invocationNum` volta a 0 a cada turno do usuário. `Stop` é fim de turno, não fim de sessão.

O `user-prompt` não vem do agy, porque o contrato de hook do agy não expõe o texto do prompt. Com `invocationNum = 0`, o hook faz, depois do session-start, um segundo spawn nativo `user-prompt` com o texto fixo `<agy-user-turn/>`. Emite um por turno do usuário, e `invocationNum > 0` não emite. O marcador segue o predicado nativo de scaffolding do upstream (`looks_like_markup_block`): começa com bloco de markup, então não entra em resumo, em perguntas em aberto nem em título, e a sessão continua substantiva pela observação `user-prompt`. Antes, o texto em inglês aparecia nesses resumos. Motivo: sem observação substantiva, o session-end de uma sessão sem ferramentas devolvia ao pool o handoff reivindicado, e ele era reentregue. Resíduo: a lista `## Prompts` da página de sessão imprime o título bruto da observação, então o marcador pode aparecer ali, e o FTS indexa os tokens `agy`, `user` e `turn`. Uma falha desse spawn vai para `hook-errors.log` e não afeta a saída do session-start. Para o agy, esse spawn não busca handoff nem injeta contexto. Detalhes em [ADR 0012](../architecture/adr/0012-antigravity-cli-integration.md) (acréscimo de 2026-10-25).

Contrato de saída, testado no agy:

- `PreToolUse` exige `{"decision":"allow"}`. `{}` nega a ferramenta. JSON inválido ou código de saída diferente de 0 bloqueia a ferramenta. Saída vazia permite.
- A suíte sempre responde `allow`. Ela observa e não contorna os prompts de permissão do agy. Uma opção de auto-aprovação do agy faria isso, e a suíte não a configura.
- A suíte sempre sai com código 0, inclusive em erro interno (falha aberta). Os diagnósticos sem conteúdo vão para `<perfil>/logs/hook-errors.log` e `hook-skips.log`.

Tratamento do payload:

- `transcriptPath` é removido e nunca lido.
- `artifactDirectoryPath` é mantido só se estiver em `~/.gemini/antigravity-cli/brain/<conversationId>`. Payloads fora desse diretório são ignorados com `skip=non-cli-surface`.
- A validação usa zod, com limites de tamanho e profundidade, fronteira do workspace e padrão de `conversationId`.

No Windows, o agy executa o comando sem shell e separa por espaços. Por isso o comando é gravado com tokens simples e caminhos 8.3. Veja [clientes](../guides/clients.md#antigravity-cli-agy).

## Bridge MCP

```text
node <repo>/dist/src/bridge.js <perfil> [claude-code]
```

O registro do Claude usa `claude-code` como segundo argumento. O registro do Codex omite o argumento. Um agente diferente de `claude-code` é recusado antes de qualquer processo filho ser iniciado (`Unknown bridge agent`).

A bridge verifica que a memória está habilitada. Com `claude-code`, ela lê `CLAUDE_CODE_SESSION_ID` do ambiente, valida o formato (`^[A-Za-z0-9._:-]{1,200}$`) e o repassa:

```text
ai-memory --data-dir <perfil>/memory mcp-bridge --agent claude-code --server-url http://127.0.0.1:<memory.port>
```

Sem agente, ou com id ausente ou inválido, a bridge mantém a forma sem sessão e não repassa nada:

```text
ai-memory --data-dir <perfil>/memory mcp-bridge --no-session-id --server-url http://127.0.0.1:<memory.port>
```

O processo filho herda stdin, stdout e stderr. `SIGINT` e `SIGTERM` são repassados ao filho. Se a memória estiver desabilitada, a bridge sai com erro `Memory disabled`.

Por que isso importa: sem sessão, o motor resolve o projeto pelo último projeto ativo do servidor (`scope.resolved_by = shared_slot` no `memory_status`), que pode pertencer a outro projeto. Com a sessão do Claude, a resolução usa a sessão (`resolved_by = session`). Um id desconhecido resulta em `resolved_by = default_after_mismatch`, e um id inválido volta à forma sem sessão. O Codex continua sem correlação de sessão, porque o motor não oferece esse caminho para ele. Por isso, clientes sem sessão devem informar `workspace` e `project` em cada chamada com escopo de projeto. O Antigravity CLI também usa a bridge sem sessão, porque o bridge é stateless e não recebe id de sessão. O agente deve passar `workspace` e `project`, lidos do `.ai-memory.toml`, em cada chamada com escopo de projeto.

## Cliente de diagnóstico (`jev-memory mcp`)

Usado pela CLI, não pelos clientes. Restrições em `src/mcp.ts`:

- Métodos permitidos: `initialize`, `notifications/initialized`, `tools/list` e `tools/call`.
- Ferramentas permitidas: `memory_status`, `memory_query`, `memory_write_page`, `memory_read_page`, `memory_read_session_observations` e `memory_recent`.
- Timeout de 15 s por requisição.
- Resposta limitada a 4 MB, verificada pelo `content-length` e durante a leitura.
- Respostas SSE são resolvidas pelo `id` da requisição; notificações são ignoradas.
- O token é lido do arquivo de autenticação do perfil no diretório de memória e enviado apenas como bearer ao loopback. O redirecionamento HTTP é tratado como erro.

O servidor expõe 24 ferramentas no estado validado em M5. A suíte não as lista nem as altera.
