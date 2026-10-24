# Clientes

Propósito: descrever os procedimentos de registro, verificação, lançamento e validação do MCP e dos hooks em Claude CLI, Codex CLI, Codex Desktop e Antigravity CLI (agy), com as etapas de confiança que cada cliente exige. Público: usuários e validadores. Data: 2026-10-24.

**Status de validação** (fonte: [tests.json](../../tests.json)): Claude Code CLI `passed` (os 9 eventos verificados em sessões reais; a TUI interativa não foi exercitada); Codex CLI `partial` (MCP aprovado; captura por hooks comprovada no Farol com bypass temporário; confiança normal dos hooks pendente do usuário); Codex Desktop `pending`, **não verificado** (precisa ser validado dentro do app, com o checklist abaixo); Antigravity CLI (`agy` 1.4.5) `passed` na CLI, com IDE e App não verificados, e gateway Code Assist validado com `agy` 1.4.7 ([seção própria](#antigravity-cli-agy)). Este guia descreve procedimentos e o que cada resultado comprovou.

## Superfícies

| Superfície | Arquivos registrados no workspace | Lançamento pela suíte |
|---|---|---|
| Claude CLI | `.mcp.json`, `.claude/settings.local.json`, `.jev-memory-claude.json` | `launch claude` |
| Codex CLI | `.codex/config.toml`, `.codex/hooks.json`, `.jev-memory-codex.json` | `launch codex` |
| Codex Desktop | Os mesmos arquivos do Codex CLI | Não. O app é aberto pelo próprio aplicativo. |
| Antigravity CLI (agy) | `.agents/hooks.json`, `.ai-memory.toml`, `.jev-memory-antigravity.json`; MCP global em `~/.gemini/config/mcp_config.json` | `jev-memory-agy` ou `jev-memory agy`. |

O Codex Desktop compartilha a configuração do Codex. Passar em `clients` não prova que o app use essa configuração.

## Pré-requisitos

1. Perfil iniciado, com `doctor` mostrando `supervisor.phase: "ready"` e a memória habilitada.
2. Diretório alvo existente, inclusive fora da instalação. `.` é a pasta atual do terminal; `--dir` seleciona outra pasta. Veja [projetos externos](external-projects.md).
3. Um marcador de escopo `.ai-memory.toml` é criado pelo registro. Sem ele, a captura de hooks fica desabilitada.

## Registrar, verificar e remover

```bash
node bin/jev-memory.mjs clients install claude .
node bin/jev-memory.mjs clients check claude .
node bin/jev-memory.mjs clients remove claude .
```

Esses caminhos relativos do script pressupõem terminal na instalação. Em outro projeto, use `node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs ...`; a pasta de trabalho do cliente continua sendo o projeto atual.

Troque `claude` por `codex`, `desktop` ou `antigravity` conforme a superfície. Os comandos:

- Fazem preflight antes de escrever e recusam conflitos (veja [ADR 0003](../architecture/adr/0003-transactional-client-registration.md)).
- Criam backup em `.local/client-backups/` quando há alteração.
- Não fazem nada se a configuração já estiver correta.
- `remove` apaga apenas as entradas próprias. Entradas de outros MCPs e hooks são preservadas.
- `check` informa se o registro está íntegro e se o hash dos hooks corresponde ao manifesto.

Os nomes dos arquivos e o formato do manifesto estão em [arquivos gerenciados](../api/managed-files.md).

### Atualização de registros existentes

- **Claude.** Registros feitos antes de 2026-10-22 usam a bridge sem sessão e fazem o `memory_status` resolver o projeto pelo último projeto ativo do servidor (`resolved_by = shared_slot`). Rode `clients install claude <dir>` para gravar `bridge.js <perfil> claude-code`. Depois abra uma nova sessão do Claude, que lê a configuração de MCP no início. O resultado esperado é `resolved_by = session`.
- **Codex.** Reinstale com `clients install codex <dir>` depois de atualizar a suíte e revise `/hooks`. O Codex continua com a bridge sem sessão.
- Cada reinstalação cria backup em `.local/client-backups/` quando há alteração.

## Lançamento pela suíte

```bash
node bin/jev-memory.mjs launch claude --dir . -- <argumentos do Claude>
node bin/jev-memory.mjs launch codex --dir . -- <argumentos do Codex>
```

- **Claude:** o lançamento gera `launch/claude-mcp.json` e `launch/claude-settings.json` no perfil e os passa por `--mcp-config` e `--settings`. Outros servidores MCP continuam carregados, porque `--strict-mcp-config` não é usado.
- **Codex:** o lançamento passa as configurações de MCP por `-c mcp_servers.jev_memory_suite.*`.
- Se houver um registro de outro perfil no diretório, o lançamento recusa.
- Se não houver marcador, o lançamento emite aviso e a captura de hooks não ocorre.
- Com o Gateway habilitado, o lançamento direciona o cliente para o Gateway (`ANTHROPIC_BASE_URL` e `ANTHROPIC_AUTH_TOKEN` no Claude; `model_provider` e `JMS_ROUTER_KEY` no Codex).

**Limitação conhecida.** O Gateway substitui o cabeçalho `Authorization` por `Bearer <chave do upstream>`. APIs da Anthropic normalmente exigem `x-api-key`. Por isso o caminho Claude → Gateway → Anthropic **não está validado**.

## Etapas de confiança nativa

A suíte não concede confiança aos clientes. Cada um pede a sua.

### Claude CLI

1. Depois de `clients install claude`, abra o Claude Code no diretório registrado ou use `launch claude`.
2. Quando o Claude pedir aprovação para os servidores MCP do projeto (`.mcp.json`), aprove `jev_memory_suite` se for a intenção.
3. Verifique se o servidor aparece como conectado na interface do cliente.

### Codex CLI

1. Marque o diretório como confiável no Codex, se ele pedir.
2. Abra `/hooks` no Codex e revise os 7 hooks do jev-memory-suite de `.codex/hooks.json`: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop e SessionEnd. Hooks não confiáveis ou alterados são ignorados em silêncio. Depois de uma reinstalação ou da correção do PowerShell (item 5), o hash muda e os hooks voltam como `modified`/`untrusted`. Aprove-os somente se o comando for o gerado por `clients install codex`.
3. A configuração `[mcp_servers.jev_memory_suite]` em `.codex/config.toml` precisa ser carregada pelo próprio Codex.
4. O Codex reduz para 3 s o timeout declarado do hook `SessionEnd` (a suíte declara 25 s) e emite um aviso. O limite efetivo é o do Codex. Não há ação necessária além de registrar o aviso.
5. No Windows, o comando de cada hook do Codex começa com `& ` (operador de chamada do PowerShell), porque o Codex executa hooks pelo PowerShell e um caminho entre aspas no início do comando é erro de análise. Registros feitos antes dessa correção não capturam nada e não geram linhas em `hook-errors.log` nem em `hook-skips.log`. Para corrigir, rode `npm run build` e `clients install codex <dir>`. A reinstalação muda o hash dos hooks: revise os 7 em `/hooks`.

### Codex CLI: MCP em code mode

No Codex, o servidor `jev_memory_suite` não aparece como declaração de nível superior da requisição. O MCP roda em code mode: o modelo descobre as ferramentas pelo `ALL_TOOLS` e as chama de dentro do `exec` como `tools.mcp__jev_memory_suite__<ferramenta>(...)`. Para validar, peça ao modelo uma chamada de ferramenta de memória e confira o resultado. A validação H5 fez isso com `memory_handoff_list`, com e sem Headroom ([tests.json](../../tests.json), `H5-headroom-codex-live`). A ausência de ferramentas de memória no tráfego de nível superior não prova que o MCP está desligado.

### Codex CLI: onde fica a confiança dos hooks

- A confiança fica em `CODEX_HOME/config.toml`. O projeto precisa de `[projects.'<dir em minúsculas>'] trust_level = "trusted"`; sem isso, os hooks do projeto não são carregados nem listados.
- Cada hook aprovado tem `[hooks.state.'<chave>'] trusted_hash = "sha256:..."`, com a chave `<caminho do hooks.json>:<evento em snake_case>:<i>:<j>`. Aprovar em `/hooks` grava essas entradas.
- Um hook com comando alterado muda de hash e volta como `modified`. O app-server expõe o estado em `hooks/list` (campo `trustStatus`: `untrusted`, `trusted`, `modified` ou `managed`, com `currentHash`), e `config/batchWrite` grava a configuração.
- A suíte não grava confiança no `~/.codex/config.toml` do usuário.
- O teste `npm run test:codex-launch` roda com `CODEX_HOME` isolado e temporário, sem `--dangerously-bypass-hook-trust` e sem `features.hooks=false`. Ele registra os hooks com `clients install codex`, confia o projeto e os 7 hooks pela API nativa do app-server (`config/batchWrite` com o `currentHash` de `hooks/list`), confirma `trusted` em `hooks/list` e verifica a captura: `session-start`, `user-prompt`, `pre-tool-use`, `post-tool-use`, `stop` e `session-end`, com e sem Headroom ([tests.json](../../tests.json), `H6-codex-hooks-native-trust`). O `~/.codex/config.toml` real não muda (hash conferido).
- Nesse teste, o handoff pendente não apareceu na primeira requisição do Codex, com e sem Headroom. A entrega do handoff pelo SessionStart no Codex não está comprovada e segue em aberto.
- A confiança normal no projeto real do usuário continua sendo a etapa manual do checklist abaixo (S3).

### Codex Desktop

1. Registre com `clients install desktop <dir>`. Isso usa os mesmos arquivos do Codex CLI.
2. Abra o app e confirme dentro dele que o servidor MCP e os hooks estão ativos. A validação do Desktop é separada da do CLI.
3. Sucesso do `launch codex` não prova nada sobre o Desktop.

**Estado: não verificado.** Nada do Desktop foi validado. O procedimento está no checklist manual abaixo.

### Registro do Codex no Farol (2026-10-22)

- `clients install codex D:\Dev\the-noble-dev\farol-platform` atualizou o registro do projeto Farol para os 7 eventos do Codex. O backup está em `.local/client-backups/2026-10-22T16-48-15-539Z-codex` do projeto.
- O `hooks/list` nativo do app-server (somente leitura) mostrou que os 5 hooks já registrados continuam confiáveis e habilitados, com o mesmo hash.
- Os hooks `PreCompact` e `Stop` aparecem como `untrusted` até serem revisados em `/hooks` no Codex. Essa aprovação é ação do usuário.
- Este repositório não tem registro do Codex.

## Procedimento de validação

Use este roteiro para cada superfície, uma de cada vez. O resultado precisa ser registrado com [scripts/record.mjs](../../scripts/record.mjs) ou editado em `tests.json`, com evidência em `.local/evidence/`.

1. Confirme `doctor` com `ready` e `clients check <host> <dir>`.
2. Abra o cliente, confirme que o servidor MCP conecta e liste as ferramentas.
3. Chame `memory_status` pelo cliente e verifique o escopo (workspace e project do perfil).
4. Gere uma interação sintética de teste. Confirme que a captura aparece na memória do perfil, por exemplo com `memory_recent` ou `memory_read_session_observations`.
5. Pare o perfil e inicie de novo. Confirme que a informação persiste.
6. Remova com `clients remove` e confirme que as entradas de outros MCPs e hooks foram preservadas.
7. Registre o resultado como `passed`, `partial`, `blocked` ou `pending`, com o motivo.

Para o Desktop, o passo 2 e o passo 4 precisam ser feitos dentro do app.

### Procedimento exato usado na validação do Claude CLI

Evidência: `.local/evidence/M6-claude-cli.json` (Claude Code CLI 2.1.263).

```bash
node bin/jev-memory.mjs --profile client-check launch claude --dir .local/fixtures/claude-cli -- -p "<prompt>" --output-format stream-json --verbose --include-hook-events --setting-sources project,local --allowedTools mcp__jev_memory_suite__memory_status
```

- `--setting-sources project,local` exclui as configurações de usuário. Assim, os hooks globais do usuário não disparam nessa execução. A mesma restrição também oculta servidores MCP de escopo de usuário nessa execução.
- Nenhum arquivo global é escrito.

### Procedimento exato usado na validação do Codex CLI

Evidência: `.local/evidence/M6-codex-cli.json` (Codex CLI 0.163.0).

```bash
node bin/jev-memory.mjs --profile client-check launch codex --dir .local/fixtures/codex-cli -- exec --skip-git-repo-check -c features.hooks=false --json "<prompt>" < /dev/null
```

- `-c features.hooks=false` vale somente para essa invocação. Assim, hooks globais já confiáveis do usuário não capturam os prompts de validação.
- `codex exec` espera stdin. O `< /dev/null` (Bash/Git Bash) fecha a entrada; no PowerShell use `$null | node bin/jev-memory.mjs ...`. Sem isso, a execução fica aguardando.
- Com `features.hooks=false`, os hooks não são executados nessa invocação. O resultado comprova o MCP e a recuperação, não a captura por hooks.

### Validação de 2026-10-22: Claude Code em sessão nova

Feita com `claude -p --model haiku` num projeto descartável registrado (perfil `project-6ba92a7197ddf0f80818`, pasta de rascunho).

- Resposta: `resolved_by=session`, `echo=probe-ok`, `subagent=pong`.
- Eventos capturados na sessão: session-start 1, user-prompt 2, pre-tool-use 5, post-tool-use 4, stop 2, outros 2 (SubagentStart e SubagentStop) e session-end 1.
- Sem entradas em `hook-errors.log` nem em `hook-skips.log`. Nada dessa sessão apareceu nos stores `default` nem do Farol.
- Não exercitados naquela rodada: `PreCompact` e a sessão interativa (TUI).
- O perfil descartável e o projeto de rascunho foram mantidos no lugar.

**`PreCompact` (marco 3).** Verificado em sessão real com `claude -p --resume <sessão> "/compact"`, que capturou uma observação de pré-compactação sem entradas em `hook-errors.log` nem em `hook-skips.log`. No Git Bash, defina `MSYS_NO_PATHCONV=1`; sem isso, `/compact` vira um caminho e o comando não chega ao Claude. Com isso, todos os 9 eventos do Claude têm captura verificada em sessão real. A sessão interativa (TUI) continua pendente.

## Ações pendentes do usuário

Estas etapas exigem decisão nativa sua. A suíte não as executa e não usa `--dangerously-bypass-hook-trust`.

### Codex CLI: captura por hooks

Estado: parcial. A captura por hooks foi comprovada no Farol, depois da correção do comando no PowerShell, com `--dangerously-bypass-hook-trust` apenas naquela invocação. Falta a confiança normal, descrita no checklist abaixo.

Tentativa de 2026-10-22 (histórico): bloqueada. `codex exec` retornou o limite de uso da conta ("try again at 2:58 PM"). Além disso, os hooks de projeto de um diretório não confiável não são carregados, mesmo com o override `-c projects...trust_level`. Um projeto descartável exigiria confiança persistente na configuração global, o que depende de aprovação sua.

a. O fixture já está registrado. Se precisar refazer o registro:
   ```bash
   node bin/jev-memory.mjs --profile client-check clients install codex .local/fixtures/codex-cli
   ```
b. Inicie o perfil:
   ```bash
   node bin/jev-memory.mjs --profile client-check start
   ```
c. Abra um Codex interativo nesse diretório:
   ```bash
   node bin/jev-memory.mjs --profile client-check launch codex --dir .local/fixtures/codex-cli
   ```
   Quando o Codex pedir, confie no projeto. Abra `/hooks` e revise e aprove os sete hooks do jev-memory-suite (o Codex não recebe eventos de subagente).
d. Envie um prompt que contenha um token único (por exemplo, `VALIDACAO-<data>-<sufixo aleatório>`) e saia do Codex.
e. Verifique:
   ```bash
   node bin/jev-memory.mjs --profile client-check mcp
   ```
   Confira as contagens. Depois, faça uma consulta `memory_query` pelo token, pelo servidor `jev_memory_suite`.

Atenção: os hooks globais de AI Memory do próprio usuário também vão disparar nessa sessão. Isso é esperado e não invalida o teste, mas as observações de origem global aparecem junto com as do projeto.

### Checklist de confiança normal no Codex CLI

Estado: pendente. Objetivo: captura por hooks com a confiança concedida por você, sem `--dangerously-bypass-hook-trust` e sem `features.hooks=false`. O resultado vai para `S3-codex-cli-normal-trust` em `tests.json`.

1. Antes de qualquer execução, rotacione a credencial que ficou exposta na configuração global do Codex (`~/.codex/config.toml`), conforme o [progress.md](../../progress.md), Marco de estabilização 1. A suíte não faz essa rotação e não grava valores de credencial.
2. Na pasta do projeto Farol (`D:\Dev\the-noble-dev\farol-platform`), abra o Codex CLI pelo launcher da suíte: `node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs codex`. Não passe `--dangerously-bypass-hook-trust` nem `-c features.hooks=false`.
3. Se o Codex pedir, confie no projeto.
4. Abra `/hooks` e aprove os 7 hooks do jev-memory-suite. Confirme que nenhum aparece como `modified` ou `untrusted`.
5. Envie um prompt com um token único (`VALIDACAO-<data>-<sufixo aleatório>`), peça que chame `memory_status` no servidor `jev_memory_suite` e saia do Codex.
6. Verifique no perfil do Farol (`project-b9b5f26bfe6b2ceb49cb`): uma sessão nova com `agent_kind` codex, com session-start, user-prompt, pre-tool-use, post-tool-use, stop e session-end, e nenhuma linha nova em `logs/hook-errors.log` nem em `logs/hook-skips.log`. Consulte pelo servidor `jev_memory_suite` (`memory_recent` ou `memory_read_session_observations`) ou pelo diretório de dados do perfil. Confirme que a sessão não aparece no store `default`.
7. Registre o resultado como `passed`, `partial`, `blocked` ou `pending`, com a evidência.

### Checklist de aceitação manual do Codex Desktop (UNVERIFIED)

Estado: **não verificado**. Nada aqui está aprovado até ser executado dentro do app. A suíte não controla o app: cada passo é do operador. O resultado vai para `S3-codex-desktop` em `tests.json`.

1. Rotacione antes de tudo a credencial que ficou exposta na configuração global do Codex (`~/.codex/config.toml`). Não cole o valor em chats, logs ou arquivos.
2. No app ChatGPT/Codex, abra a pasta do projeto Farol (`D:\Dev\the-noble-dev\farol-platform`). O app inicia `codex app-server` com o mesmo `CODEX_HOME`, e a configuração `.codex/` do projeto só é aplicada em projetos confiáveis.
3. Confirme que o servidor `jev_memory_suite` aparece na lista de servidores MCP e está conectado.
4. Aprove o projeto e revise os 7 hooks do jev-memory-suite, quando o app pedir ou nas configurações de hooks. Confirme que nenhum aparece como `modified` ou `untrusted`.
5. Envie um prompt que peça para chamar `memory_status` no servidor `jev_memory_suite` e para executar `echo probe-ok`. Esperado: projeto `p-farol-platform-b9b5f26bfe6b2ceb49cb` e saída `probe-ok`.
6. Encerre a conversa.
7. Mantenedor: no perfil do Farol (`project-b9b5f26bfe6b2ceb49cb`), confirme uma sessão nova com `agent_kind` codex, com session-start, user-prompt, pre-tool-use, post-tool-use, stop e session-end. Confirme que `logs/hook-errors.log` e `logs/hook-skips.log` não ganharam linhas dessa sessão.
8. Se o Desktop oferecer compactação, dispare-a e confirme uma observação de pré-compactação. Se não oferecer, registre que `PreCompact` não foi exercitado.
9. Confirme que nada dessa sessão aparece no store `default`.
10. Registre o resultado em `S3-codex-desktop` de `tests.json`, com a evidência, como `passed`, `partial`, `blocked` ou `pending`.

## Riscos a considerar antes de usar

- Se o usuário já tiver um AI Memory global com hooks que leem `.ai-memory.toml`, esses hooks também podem atribuir o diretório marcado ao workspace declarado. Veja [ADR 0004](../architecture/adr/0004-hook-boundary-and-capture-allowlist.md).
- O conteúdo recuperado pela memória é dado histórico. Não deve ser tratado como instrução. Veja [modelo de ameaças](../security/threat-model.md).
- Os arquivos registrados no workspace podem aparecer em `git status` se estiverem em subdiretórios. Veja [arquivos gerenciados](../api/managed-files.md#lista-de-arquivos-ignorados-pelo-git).
- O Antigravity CLI carrega `.agents/hooks.json` de qualquer repositório sem prompt de confiança. Veja [Antigravity CLI](#antigravity-cli-agy) e o [modelo de ameaças](../security/threat-model.md) (T33).

## Uso no estilo jev-codex / jev-claude (recomendado)

Reutiliza os launchers oficiais do Jev Gateway (`bin/jev-codex.mjs` e `bin/jev-claude.mjs` da versão instalada) e acrescenta a memória (MCP e hooks). O gateway é o mesmo do `jev-codex`/`jev-claude` (portas 8790 e 8789), repassa o login do cliente (ChatGPT ou claude.ai) e lê a chave do Jev de `~/.jev-gateway/.env`, sem alterá-la.

```bash
node bin/jev-memory.mjs codex                  # sobe a memória se preciso e abre o Codex
node bin/jev-memory.mjs claude                 # idem com o Claude Code
node bin/jev-memory.mjs --dir <pasta> codex exec "tarefa"
node bin/jev-memory.mjs codex --dashboard      # --status, --stop, --setup, --logs vão direto ao launcher upstream
```

- Use com perfis cujo gateway da suíte está desligado (`gateway.enabled: false`, padrão): quem gerencia o gateway é o launcher upstream.
- Claude com `headroom.enabled: true` (opcional, desligado por padrão): o `claude` passa pelo Headroom quando as verificações passam, e cai no launcher upstream, com o motivo em stderr, quando alguma falha. `JMS_HEADROOM=off` desliga por execução. Não se aplica ao Codex. Procedimento e limites em [otimização de tokens](token-optimization.md#headroom-opcional-claude).
- `codex exec` (e `e`, `resume`, `review`, `fork`): o Codex 0.163 ignora `-c` antes do subcomando; a suíte repete depois dele os mesmos parâmetros de provedor que o `clients.mjs` upstream gera.
- Validação real em 2026-10-21: Codex `exec` com `model_provider` `jev-gateway`, 3 entradas no log do gateway (2 `forced`), `memory_status` no `jev_memory_suite`; Claude `-p` com 3 entradas (2 `hint`), hooks com exit 0 e MCP conectado. Com o provedor Jev real (TypeSafe) e o login do próprio cliente.

## Antigravity CLI (agy)

Estado: **aprovado na CLI** (agy 1.4.5, Windows 10, AI Memory 3.1.2, validado em 2026-10-23). IDE e App **não verificados**. O gateway Code Assist do Jev foi validado com agy 1.4.7 em 2026-10-24 (ver [lançamento](#lançamento) e [operação](../runbooks/operations.md#gateway-do-agy-jev-gateway)). A decisão está na [ADR 0012](../architecture/adr/0012-antigravity-cli-integration.md).

### Registrar, verificar e remover

```powershell
jev-memory clients install antigravity .
jev-memory clients check antigravity .
jev-memory clients remove antigravity .
```

- Arquivos no workspace: `.agents/hooks.json` (grupo `jev-memory-suite`), `.ai-memory.toml` e `.jev-memory-antigravity.json` (manifesto). Veja [arquivos gerenciados](../api/managed-files.md#antigravity-cli-agy).
- O registro segue o mesmo modelo de Claude e Codex: manifesto de propriedade, backup em `.local/client-backups/`, escrita atômica, rollback, idempotência e detecção de alteração. Outros grupos de hooks são preservados.
- BOM UTF-8 é tolerado na leitura, e o arquivo é gravado sem BOM.
- `remove` apaga apenas o grupo da suíte. O arquivo só é removido se a suíte o tiver criado. A entrada MCP global não é removida (veja abaixo).

### Lançamento

- `jev-memory-agy [args]` ou `jev-memory agy [args]`.
- Resolve o `agy` pelo PATH ou em `%LOCALAPPDATA%\agy\bin\agy.exe`.
- Antes de abrir, verifica o serviço de memória, o registro dos hooks, o estado do MCP e o marcador de escopo. Problemas viram avisos.
- Repassa argumentos, diretório e stdio sem alteração, e devolve o código de saída do `agy`.
- O agy passa pelo Jev Gateway em modo passthrough (Code Assist), com `CLOUD_CODE_URL=http://127.0.0.1:<porta>` definido só no processo do agy. Não há roteamento: o conteúdo não é enviado ao provedor do Jev. O token OAuth continua o da conta Google do próprio usuário.
- Sem o gateway, o agy segue direto ao Google. O launcher só usa o gateway depois de verificar a versão do agy, a instalação do gateway, a porta e o health.
- Mensagens no stderr:
  - Sucesso: `Jev gateway: http://127.0.0.1:8794 (passthrough)`.
  - Falha: `Jev not used: <motivo>`. Exemplos validados: `disabled by JMS_AGY_GATEWAY=off`, `CLOUD_CODE_URL already set` e `gateway health invalid: client, codeAssist, upstream`.
- `JMS_AGY_GATEWAY=off` desliga o uso do gateway; o agy segue direto ao Google.
- `JEV_AGY_PORT` escolhe a porta do gateway agy. Sem valor válido, usa 8794.
- Só versões em `VALIDATED_AGY_VERSIONS` (hoje 1.4.7) usam o gateway. Outra versão segue direto ao Google até ser revalidada.
- O gateway agy é persistente: continua de pé depois que o agy sai. Procedimentos de parada, versões e rollback estão em [operação](../runbooks/operations.md#gateway-do-agy-jev-gateway).

### Hooks

| Evento do agy | Evento da suíte | Saída |
|---|---|---|
| `PreInvocation` | `session-start` | Saída nativa do motor; handoff pendente via `injectSteps[].ephemeralMessage` |
| `PreToolUse` | `pre-tool-use` | `{"decision":"allow"}` |
| `PostToolUse` | `post-tool-use` | Saída nativa do motor |
| `Stop` | `stop` | `{"decision":""}` |

- `SessionStart` e `PostInvocation` existem no agy, mas não são usados. O motor nativo inicia a sessão só em `PreInvocation` com `invocationNum = 0` e deduplica por `conversationId`. O `invocationNum` volta a 0 a cada turno do usuário.
- `Stop` é fim de turno, não fim de sessão.
- A suíte sempre responde `allow` no `PreToolUse`. Ela observa e não contorna os prompts de permissão do agy. Uma opção de auto-aprovação do agy faria isso; a suíte não a configura.
- Falha aberta: em erro interno, o hook sai com código 0. Os diagnósticos sem conteúdo ficam em `.local/profiles/<perfil>/logs/hook-errors.log` e `hook-skips.log`.
- Payloads fora do diretório de artefatos da CLI são ignorados com `skip=non-cli-surface`. Detalhes em [hooks e bridge](../api/hooks-and-bridge.md#antigravity-cli-agy).

### MCP global

- O agy só lê MCP de usuário, em `~/.gemini/config/mcp_config.json`. O registro não cria entrada por projeto.
- A instalação registra `jev_memory_suite` com `agy mcp add`, somente se a entrada não existir. Se o nome já pertencer a outro servidor, a instalação recusa.
- Se o arquivo começar com BOM UTF-8, o agy não consegue lê-lo. Antes de remover o BOM, a suíte grava o backup `mcp_config.json.jev-bom-<timestamp>.bak` ao lado do arquivo. Só o BOM é removido.
- A entrada é compartilhada por todos os projetos. O bridge é stateless, sem id de sessão. Por isso o agente deve passar `workspace` e `project` (lidos do `.ai-memory.toml`) em cada chamada com escopo de projeto.
- `clients remove` mantém a entrada global. Para removê-la, use `agy mcp remove jev_memory_suite`.

### Permissões

- Em modo headless (`-p`), o agy nega ferramentas MCP que não estejam em `permissions.allow`, por exemplo `mcp(...)`. Alternativa: `--dangerously-skip-permissions`.
- A suíte não altera as permissões do agy.

### Finalização

- O agy não tem evento de fim de sessão. Ao abrir com o launcher, este define um id aleatório em `JEV_MEMORY_AGY_LAUNCH`, e os hooks registram os ids de conversa desse lançamento.
- Ao sair, o launcher executa `ai-memory finalize-session --agent antigravity-cli --session-id <id> --reopen` somente para esses ids, e depois apaga o registro. Sessões concorrentes não relacionadas não são tocadas. Falhas geram apenas aviso.
- Para sessões não iniciadas pelo launcher, ou após uma queda do launcher, use `jev-memory agy-finalize [--session <id>]`. Sem id, finaliza a sessão agy aberta mais recente do projeto.
- Fechar a janela do console envia `SIGHUP` ao launcher, que finaliza o próprio lançamento. O que não terminar em cerca de 7 s fica para a recuperação.
- Antes de cada lançamento, a recuperação automática finaliza os lançamentos cujo dono (`<launchId>.owner.json`) tem pid morto, com o escopo gravado. Dono vivo, owner inválido ou escopo divergente não são tocados.
- Após uma queda forçada, `jev-memory agy-finalize --recover` antecipa a recuperação. `--recover --legacy` também finaliza registros sem owner, de versões anteriores, com o config atual do perfil; confirme antes que nenhum agy está rodando. Veja [operação](../runbooks/operations.md#recuperação-e-fechamento-da-janela).

### Handoffs

- Um handoff criado com `memory_handoff_begin` em uma sessão do agy foi entregue na sessão seguinte, e o modelo viu o marcador.
- O handoff entra como dado histórico não confiável. A suíte não o executa.

### CLI, IDE e App

- A CLI carrega `.agents/hooks.json` do workspace sem prompt de confiança.
- IDE e App leem o mesmo arquivo, mas **não foram verificados**.
- O hook processa apenas payloads do diretório de artefatos da CLI. Os demais são ignorados.
- A suíte não altera `~/.gemini/config/hooks.json`, o arquivo global compartilhado com IDE e App.

### Windows

- O agy executa os comandos de hook sem shell e separa por espaços. Aspas são mantidas literalmente. Por isso os comandos são tokens simples, e o `node.exe` em `C:\Program Files` é gravado no caminho 8.3 (`C:/PROGRA~1/nodejs/node.exe`).
- Se algum caminho ainda tiver espaços ou caracteres de shell, `clients install antigravity` falha com erro claro. Causas comuns: repositório clonado em caminho com espaços, ou nomes 8.3 desabilitados no volume.
- Problemas comuns estão em [solução de problemas](../guides/troubleshooting.md#tabela-de-sintomas).

### Validação de 2026-10-23

Ambiente: agy 1.4.5, Windows 10, AI Memory 3.1.2.

- `jev-memory-agy -p` capturou uma sessão com `agent_kind` `antigravity-cli`, com observações de session-start, pre-tool-use, post-tool-use, stop e session-end (finalizada), sem erros de hook.
- Handoff criado numa sessão do agy foi entregue na seguinte.
- `memory_status` pelo MCP do agy retornou o projeto correto.
- Não verificado: IDE e App.
- Registro em `M-agy-1` de [tests.json](../../tests.json).
- Gateway Code Assist (2026-10-24, agy 1.4.7): passthrough validado com o agy real, com 2 chamadas registradas no log. Registro em `M-agy-4` de [tests.json](../../tests.json). Detalhes em [progress.md](../../progress.md).
- Recuperação de sessões (2026-10-24, agy 1.4.7): e2e real 2/2 com janela de console, e recuperação do registro legado da janela fechada. Registro em `M-agy-5`.
