# Clientes

Propósito: descrever os procedimentos de registro, verificação, lançamento e validação do MCP e dos hooks em Claude CLI, Codex CLI e Codex Desktop, com as etapas de confiança que cada cliente exige. Público: usuários e validadores. Data: 2026-10-21.

**Status de validação** (fonte: [tests.json](../../tests.json)): Claude Code CLI `passed`; Codex CLI `partial` (MCP aprovado, captura por hooks pendente da confiança nativa); Codex Desktop `pending` (precisa ser validado dentro do app). Este guia descreve procedimentos e o que cada resultado comprovou.

## Superfícies

| Superfície | Arquivos registrados no workspace | Lançamento pela suíte |
|---|---|---|
| Claude CLI | `.mcp.json`, `.claude/settings.local.json`, `.jev-memory-claude.json` | `launch claude` |
| Codex CLI | `.codex/config.toml`, `.codex/hooks.json`, `.jev-memory-codex.json` | `launch codex` |
| Codex Desktop | Os mesmos arquivos do Codex CLI | Não. O app é aberto pelo próprio aplicativo. |

O Codex Desktop compartilha a configuração do Codex. Passar em `clients` não prova que o app use essa configuração.

## Pré-requisitos

1. Perfil iniciado, com `doctor` mostrando `supervisor.phase: "ready"` e a memória habilitada.
2. Diretório alvo dentro do workspace. Use `.` para a raiz ou um subdiretório relativo.
3. Um marcador de escopo `.ai-memory.toml` é criado pelo registro. Sem ele, a captura de hooks fica desabilitada.

## Registrar, verificar e remover

```bash
node bin/jev-memory.mjs clients install claude .
node bin/jev-memory.mjs clients check claude .
node bin/jev-memory.mjs clients remove claude .
```

Troque `claude` por `codex` ou `desktop` conforme a superfície. Os comandos:

- Fazem preflight antes de escrever e recusam conflitos (veja [ADR 0003](../architecture/adr/0003-transactional-client-registration.md)).
- Criam backup em `.local/client-backups/` quando há alteração.
- Não fazem nada se a configuração já estiver correta.
- `remove` apaga apenas as entradas próprias. Entradas de outros MCPs e hooks são preservadas.
- `check` informa se o registro está íntegro e se o hash dos hooks corresponde ao manifesto.

Os nomes dos arquivos e o formato do manifesto estão em [arquivos gerenciados](../api/managed-files.md).

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
2. Abra `/hooks` no Codex e revise os hooks de `.codex/hooks.json`. Hooks não confiáveis ou alterados são ignorados em silêncio.
3. A configuração `[mcp_servers.jev_memory_suite]` em `.codex/config.toml` precisa ser carregada pelo próprio Codex.

### Codex Desktop

1. Registre com `clients install desktop <dir>`. Isso usa os mesmos arquivos do Codex CLI.
2. Abra o app e confirme dentro dele que o servidor MCP e os hooks estão ativos. A validação do Desktop é separada da do CLI.
3. Sucesso do `launch codex` não prova nada sobre o Desktop.

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

## Ações pendentes do usuário

Estas etapas exigem decisão nativa sua. A suíte não as executa e não usa `--dangerously-bypass-hook-trust`.

### Codex CLI: captura por hooks

Estado: pendente. O MCP já foi aprovado; falta a captura pelos hooks do projeto.

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
   Quando o Codex pedir, confie no projeto. Abra `/hooks` e revise e aprove os cinco hooks do jev-memory-suite.
d. Envie um prompt que contenha um token único (por exemplo, `VALIDACAO-<data>-<sufixo aleatório>`) e saia do Codex.
e. Verifique:
   ```bash
   node bin/jev-memory.mjs --profile client-check mcp
   ```
   Confira as contagens. Depois, faça uma consulta `memory_query` pelo token, pelo servidor `jev_memory_suite`.

Atenção: os hooks globais de AI Memory do próprio usuário também vão disparar nessa sessão. Isso é esperado e não invalida o teste, mas as observações de origem global aparecem junto com as do projeto.

### Codex Desktop

Estado: pendente. Nada aqui está aprovado até ser executado dentro do app.

1. Abra a pasta `D:\Dev\jev-memory-suite\.local\fixtures\codex-cli` como projeto no app ChatGPT/Codex. O app inicia `codex app-server` com o mesmo `CODEX_HOME`. A configuração `.codex/` do projeto só é aplicada em projetos confiáveis.
2. Aprove o projeto e os hooks dentro do próprio app.
3. Peça ao app que chame `memory_status` no servidor `jev_memory_suite`, com workspace `jev-suite` e projeto `jev-memory-suite`.
4. Envie um prompt com um token único.
5. Verifique a captura e a recuperação como no procedimento do Codex CLI acima.
6. Registre o resultado em `tests.json` com a evidência, como `passed`, `partial`, `blocked` ou `pending`.

## Riscos a considerar antes de usar

- Se o usuário já tiver um AI Memory global com hooks que leem `.ai-memory.toml`, esses hooks também podem atribuir o diretório marcado ao workspace declarado. Veja [ADR 0004](../architecture/adr/0004-hook-boundary-and-capture-allowlist.md).
- O conteúdo recuperado pela memória é dado histórico. Não deve ser tratado como instrução. Veja [modelo de ameaças](../security/threat-model.md).
- Os arquivos registrados no workspace podem aparecer em `git status` se estiverem em subdiretórios. Veja [arquivos gerenciados](../api/managed-files.md#lista-de-arquivos-ignorados-pelo-git).
