# Hooks e bridge MCP

Propósito: documentar o comando dos hooks nativos, os payloads aceitos e seus limites, e a bridge MCP do perfil. Público: integradores e mantenedores. Data: 2026-10-21.

## Hooks nativos

Os clientes são registrados para executar:

```text
node <repo>/dist/src/hook.js <perfil> <claude-code|codex> <evento-nativo>
```

| Evento do cliente | Argumento `<evento-nativo>` |
|---|---|
| `SessionStart` | `session-start` |
| `UserPromptSubmit` | `user-prompt` |
| `PreToolUse` | `pre-tool-use` |
| `PostToolUse` | `post-tool-use` |
| `SessionEnd` | `session-end` |

O registro usa matcher vazio (todos os casos) e timeout declarado de 25 s. O payload chega em stdin como JSON.

### Validação, em ordem

Qualquer falha nestas etapas gera uma exceção interna com mensagem específica, mas o processo imprime apenas a mensagem genérica de [erros](#chamada-ao-ai-memory). Use os nomes abaixo para entender a causa em testes, não para depurar pelo stderr.

1. Agente em `{claude-code, codex}` e evento em allowlist. Caso contrário: `Untrusted hook agent/event`.
2. Profundidade do JSON até 32 níveis, verificada de forma iterativa.
3. Stdin até 1 MB. Acima disso: `Hook payload too large`.
4. Schema do evento. Campos comuns: `session_id` obrigatório (`[A-Za-z0-9._:-]`, até 200), `cwd` obrigatório (até 2048), `hook_event_name` opcional, `model` e `permission_mode` até 200 e 64, `tool_use_id` até 200.
5. `hook_event_name`, se presente, deve corresponder ao evento.
6. `cwd` é canonizado com `realpath` e deve ser a raiz do workspace ou um descendente. Links e junctions são recusados.
7. `transcript_path` é removido do payload.
8. Só então a configuração do perfil é lida. Se a memória estiver desabilitada, o hook retorna vazio.

### Campos específicos por evento

| Evento | Campos adicionais |
|---|---|
| `session-start` | `source` (até 64) |
| `user-prompt` | `prompt` obrigatório (até 200000) |
| `pre-tool-use`, `post-tool-use` | `tool_name` obrigatório (até 200), `tool_input` e `tool_response` opcionais |
| `session-end` | `reason` (até 200) |

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

## Bridge MCP

```text
node <repo>/dist/src/bridge.js <perfil>
```

A bridge verifica que a memória está habilitada e executa:

```text
ai-memory --data-dir <perfil>/memory mcp-bridge --no-session-id --server-url http://127.0.0.1:<memory.port>
```

O processo filho herda stdin, stdout e stderr. `SIGINT` e `SIGTERM` são repassados ao filho. Se a memória estiver desabilitada, a bridge sai com erro `Memory disabled`.

Como o modo `--no-session-id` não associa a chamada a uma sessão, clientes que usam a bridge devem informar `workspace` e `project` em cada chamada com escopo de projeto.

## Cliente de diagnóstico (`jev-memory mcp`)

Usado pela CLI, não pelos clientes. Restrições em `src/mcp.ts`:

- Métodos permitidos: `initialize`, `notifications/initialized`, `tools/list` e `tools/call`.
- Ferramentas permitidas: `memory_status`, `memory_query`, `memory_write_page`, `memory_read_page`, `memory_read_session_observations` e `memory_recent`.
- Timeout de 15 s por requisição.
- Resposta limitada a 4 MB, verificada pelo `content-length` e durante a leitura.
- Respostas SSE são resolvidas pelo `id` da requisição; notificações são ignoradas.
- O token é lido do arquivo de autenticação do perfil no diretório de memória e enviado apenas como bearer ao loopback. O redirecionamento HTTP é tratado como erro.

O servidor expõe 24 ferramentas no estado validado em M5. A suíte não as lista nem as altera.
