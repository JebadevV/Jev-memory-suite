# Instalação

Propósito: descrever a instalação local dos dois motores e do primeiro perfil, com o que cada passo grava, o provisionamento do modelo de embeddings e a reinstalação dos hooks. Público: usuários e operadores. Data: 2026-10-22.

## Requisitos

- Node.js 24 ou superior (`engines` em `package.json`).
- npm, para `npm ci`. As dependências de desenvolvimento incluem pnpm, usado para compilar o Gateway.
- Git, usado pelo `install` (`git rev-parse`) e pelo `update`.
- Toolchain Rust com `cargo +stable`, para compilar o AI Memory.
- Acesso aos registries de pacotes na primeira instalação.

A validação registrada foi feita em Windows 10 Pro. Outras plataformas não têm evidência no repositório.

## Passos

Execute a partir da raiz do repositório.

```bash
npm ci
npm run build
node bin/jev-memory.mjs init
node bin/jev-memory.mjs install all
node bin/jev-memory.mjs start
node bin/jev-memory.mjs doctor
node bin/jev-memory.mjs mcp
node bin/jev-memory.mjs stop
```

| Passo | Grava ou altera | Observação |
|---|---|---|
| `npm ci` | `node_modules/` | Usa `package-lock.json` |
| `npm run build` | `dist/` | Compila `src/` e `test/` com `tsc` |
| `init` | `.local/profiles/default/suite.json` e `control-token` | Falha se `suite.json` já existir |
| `install all` | `.local/engines/`, `.local/cargo-target/`, `.local/installed.json`, `.local/evidence/*.log` | Compila o AI Memory com `cargo +stable build --locked --bin ai-memory`, de forma demorada. Na validação, levou cerca de 4 minutos. Depois compila o Gateway com pnpm. |
| `start` | `.local/profiles/default/memory/` (na primeira vez), `memory/models/` e `logs/` | Sobe os serviços habilitados. Provisiona o modelo de embeddings antes do motor de memória. |
| `doctor` | Nada | Mostra a situação do perfil |
| `mcp` | Nada | Faz handshake e lê `memory_status` |
| `stop` | Nada | Para os filhos |

Os motores são compilados a partir dos commits fixados em `upstream/`. O build recusa fontes modificadas. Detalhes em [ADR 0002](../architecture/adr/0002-versioned-engine-installs.md).

## Ordem e dependências

- `install memory` e `install gateway` podem ser executados separadamente. `install all` executa os dois.
- `start` exige o motor do serviço habilitado. Se faltar, a memória retorna `Memory engine not installed; run: jev-memory install memory`.
- O Gateway vem desabilitado. Para habilitá-lo, defina as duas variáveis de ambiente (veja [configuração](configuration.md)) antes do `start`.

## Modelo de embeddings

Com `memory.semanticSearch` em `true` (padrão), o `start` garante o modelo do perfil antes de subir o motor de memória:

1. Se o perfil já tem os três arquivos com o sha256 fixado, nada é feito.
2. Caso contrário, a suíte procura uma cópia verificada: primeiro o cache `.local/models/all-MiniLM-L6-v2/`, depois a instalação original em `%LOCALAPPDATA%\ai-memory\models\all-MiniLM-L6-v2`, somente leitura. Essa cópia é verificada antes de uso.
3. Com a cópia verificada, o perfil recebe os arquivos em hardlink (ou cópia verificada, se o hardlink não for possível), e o motor não baixa nada.
4. Sem nenhuma cópia verificada, o motor baixa o modelo do Hugging Face oficial e confere o checksum fixado. Essa é a única etapa que usa rede. Se o checksum não bater, o motor falha.

Ao subir, o log `logs/memory.log` deve conter `embedder enabled provider="local" model="all-MiniLM-L6-v2" dim=384`. Se não aparecer, veja [solução de problemas](troubleshooting.md#busca-semântica-e-modelo).

## Hooks

Os hooks são registrados por `clients install`, e o caminho gravado aponta para `dist/src/hook.js`. Depois de atualizar a suíte, faça estas etapas:

1. Compile: `npm run build`.
2. Reinstale os hooks do projeto: `node bin/jev-memory.mjs clients install claude [dir]` (Claude Code, 9 eventos) ou `node bin/jev-memory.mjs clients install codex [dir]` (Codex, 7 eventos). `dir` é opcional e parte da pasta atual.
3. O Claude lê os hooks no início de cada processo. Abra uma sessão nova depois da reinstalação.
4. No Codex, a alteração do `.codex/hooks.json` exige nova revisão. Abra `/hooks` no Codex e aprove os hooks do jev-memory-suite. Hooks alterados sem revisão são ignorados em silêncio.

A reinstalação é idempotente: sem mudanças, o resultado lista `changed: []`.

## Verificação

Depois do `start`:

- `doctor` mostra `installed.memory: true` e `supervisor.phase: "ready"`.
- `mcp` retorna `handshake: true`, `toolsCount` e um `status` com o `scope` do perfil.
- `status` mostra `services.memory: "ready"`.
- O log `logs/memory.log` mostra `embedder enabled` (quando a busca semântica está ligada).

## Problemas comuns

Consulte [solução de problemas](troubleshooting.md). Para reinstalar um motor depois de uma falha, rode `install <motor>` novamente: a árvore é a mesma, e builds incompletos são refeitos.
