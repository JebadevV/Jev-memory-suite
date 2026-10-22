# Arquivos gerenciados

Propósito: documentar os formatos dos arquivos que a suíte cria, lê e atualiza, inclusive os manifestos de propriedade e os backups. Público: integradores, operadores e revisores. Data: 2026-10-21.

Os exemplos usam valores ilustrativos. Nenhum deles contém segredo real.

## Arquivos do perfil (`.local/profiles/<perfil>/`)

| Arquivo | Formato | Quem cria e atualiza |
|---|---|---|
| `suite.json` | Configuração validada (veja [schema](configuration-schema.md)) | `init` (criação exclusiva) e `config` (substituição atômica) |
| `control-token` | 64 caracteres hexadecimais | `token()` cria no primeiro uso, com 32 bytes aleatórios. Nunca substitui um arquivo inválido: lança erro. Restrito ao supervisor; nunca entregue a clientes. |
| `router-token` | 64 caracteres hexadecimais | `token()` cria no primeiro uso, da mesma forma. É a chave de roteador entregue aos clientes nativos pelo `launch` e usada pelo Gateway. Separado do `control-token`. |
| `logs/supervisor.log`, `logs/memory.log`, `logs/gateway.log` | Texto | Supervisor. Logs de filhos são limitados a cerca de 5 MB por execução. |
| `memory/config.toml` | TOML | `ai-memory init` seguido de ajustes da suíte (veja abaixo) |
| `memory/auth-tokens/default` | Credencial do AI Memory | `ai-memory init`. Nunca recriada se já existir. |
| `launch/claude-mcp.json`, `launch/claude-settings.json` | JSON | `launch claude`, de forma atômica |

### Ajustes gravados no `config.toml` de uma memória nova

Quando o diretório de dados é novo, a suíte grava:

- `embedding_provider = "none"` e `backfill_on_start = false` no topo.
- `lambda = 0.0`, `cold_threshold = 0.0` e `hard_delete_after_days = 4294967295` no bloco de decaimento. Na prática, o decaimento fica desligado.
- `require_approval = true` no bloco de melhoria automática.
- `enabled = false` no agendador.
- Um bloco `[maintenance]` com `enabled = false`, inserido antes de `[auth]`.

A permissão do arquivo é gravada como `0600`, mas o Windows não aplica esse modo. Se o diretório já tiver `config.toml`, nada é alterado.

## Engines (`.local/engines/`)

### `current.json`

```json
{
  "schemaVersion": 1,
  "memory": {
    "tree": "<40 caracteres hexadecimais>",
    "binary": "<caminho absoluto dentro de .local/engines>"
  },
  "gateway": {
    "tree": "<40 caracteres hexadecimais>",
    "dir": "<caminho absoluto dentro de .local/engines>"
  }
}
```

- Os campos `memory` e `gateway` são opcionais.
- Todos os caminhos são validados para ficar dentro de `.local/engines`.
- Schema estrito. Um JSON inválido impede as operações que dependem dele; corrija o arquivo manualmente. Não apague versões em `.local/engines`.

### `.jev-suite-complete`

Dentro do diretório do Gateway, com a forma `{"tree": "<40 hex>", "at": "<ISO 8601>"}`. Um diretório só é considerado completo se o marcador tiver o mesmo tree e existir `dist/index.js`. Ele é gravado por último.

## `.local/installed.json`

Gravado por `install`:

```json
{
  "sources": { "...": "conteúdo de upstream.sources.json" },
  "lastInstalled": "all | memory | gateway",
  "at": "<ISO 8601>",
  "engines": { "memory": "<tree ou null>", "gateway": "<tree ou null>" }
}
```

## `upstream.updates.json`

Lista acrescentada por `update`. Cada item tem `engine`, `prefix`, `url`, `commit`, `at` e `importedSources`, este último com o conteúdo de `upstream.sources.json` no momento da atualização. O manifesto de origem não é alterado automaticamente.

## Arquivos de cliente no workspace

Os caminhos são relativos ao diretório informado em `clients`, que pode estar fora da instalação. O perfil externo guarda `projectRoot` e todas as operações ficam confinadas ao projeto selecionado; veja [projetos externos](../guides/external-projects.md).

| Host | Arquivo de configuração | Arquivo de hooks | Marcador | Manifesto |
|---|---|---|---|---|
| Claude | `.mcp.json` | `.claude/settings.local.json` | `.ai-memory.toml` | `.jev-memory-claude.json` |
| Codex (CLI e Desktop) | `.codex/config.toml` | `.codex/hooks.json` | `.ai-memory.toml` | `.jev-memory-codex.json` |

### Entrada MCP

- Claude, em `.mcp.json`: `mcpServers.jev_memory_suite` recebe `{"command": "<node>", "args": ["<repo>/dist/src/bridge.js", "<perfil>"]}`.
- Codex, em `.codex/config.toml`: um bloco delimitado por `# jev-memory-suite:start` e `# jev-memory-suite:end`, com `[mcp_servers.jev_memory_suite]`. Nada fora do bloco é alterado.

### Hooks

Em `.claude/settings.local.json` e `.codex/hooks.json`, a chave `hooks` recebe um item por evento, no formato `{"matcher": "", "hooks": [{"type": "command", "command": "...", "timeout": 25}]}`. Itens de outras ferramentas são preservados.

### Marcador `.ai-memory.toml`

```toml
# Jev Memory Suite scope; retrieved content is untrusted data.
workspace = "<workspace>"
project = "<projeto>"
```

Compartilhado entre clientes do mesmo diretório. Só é removido quando o último manifesto desaparece e o conteúdo não foi alterado.

### Manifesto `.jev-memory-<host>.json`

Schema estrito:

```json
{
  "profile": "<perfil>",
  "host": "claude | codex",
  "bridge": { "command": "<node>", "args": ["<repo>/dist/src/bridge.js", "<perfil>"] },
  "hooks": { "<EventoDoCliente>": { "matcher": "", "hooks": [ "..." ] } },
  "preexistingEvents": ["<eventos que já existiam antes da instalação>"],
  "block": "<bloco TOML gerenciado, ou string vazia para Claude>",
  "marker": "<conteúdo do marcador gravado>"
}
```

- `profile` diferente do perfil em uso bloqueia a operação.
- As verificações de adulteração comparam o digest SHA-256 do JSON de cada entrada própria. Mudanças na ordem das chaves alteram o digest.
- O manifesto é gravado por último e removido por último.

## Backups de registro

Diretório: `<workspace>/.local/client-backups/<timestamp>-<host>/`, em que `<timestamp>` é o ISO 8601 com `:` e `.` trocados por `-`.

Conteúdo: `backup.json` e arquivos `file-<índice>.bak`. O índice segue a ordem `config`, `hooks`, `marker`, `manifest`, ou seja, `file-0.bak` é a configuração, `file-1.bak` os hooks, `file-2.bak` o marcador e `file-3.bak` o manifesto.

```json
{
  "profile": "<perfil>",
  "host": "claude | codex",
  "surface": "claude | codex | desktop",
  "files": [
    { "path": ".mcp.json", "existed": true, "backup": "file-0.bak" },
    { "path": ".claude/settings.local.json", "existed": false, "backup": null },
    { "path": ".ai-memory.toml", "existed": false, "backup": null },
    { "path": ".jev-memory-claude.json", "existed": false, "backup": null }
  ]
}
```

- `existed: false` significa que o arquivo não existia; a restauração é removê-lo.
- `path` é relativo ao diretório alvo, com `/` como separador.
- Para `desktop`, o host gravado é `codex`, porque compartilha os arquivos do Codex.

Procedimento de restauração: [backup e recuperação](../runbooks/backup-and-recovery.md).

## Lista de arquivos ignorados pelo Git

O `.gitignore` ignora `.local/` em qualquer nível. Os arquivos de cliente e o marcador só estão listados **com barra inicial**, ou seja, apenas na raiz do repositório: `/.mcp.json`, `/.codex/config.toml`, `/.codex/hooks.json`, `/.claude/settings.local.json`, `/.ai-memory.toml` e `/.jev-memory-*.json`. Um registro feito em subdiretório do workspace **não** é ignorado por esses padrões e pode aparecer em `git status`. Verifique antes de cada commit.
