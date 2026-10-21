# Instalação

Propósito: descrever a instalação local dos dois motores e do primeiro perfil, com o que cada passo grava. Público: usuários e operadores. Data: 2026-10-21.

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
| `start` | `.local/profiles/default/memory/` (na primeira vez) e `logs/` | Sobe os serviços habilitados |
| `doctor` | Nada | Mostra a situação do perfil |
| `mcp` | Nada | Faz handshake e lê `memory_status` |
| `stop` | Nada | Para os filhos |

Os motores são compilados a partir dos commits fixados em `upstream/`. O build recusa fontes modificadas. Detalhes em [ADR 0002](../architecture/adr/0002-versioned-engine-installs.md).

## Ordem e dependências

- `install memory` e `install gateway` podem ser executados separadamente. `install all` executa os dois.
- `start` exige o motor do serviço habilitado. Se faltar, a memória retorna `Memory engine not installed; run: jev-memory install memory`.
- O Gateway vem desabilitado. Para habilitá-lo, defina as duas variáveis de ambiente (veja [configuração](configuration.md)) antes do `start`.

## Verificação

Depois do `start`:

- `doctor` mostra `installed.memory: true` e `supervisor.phase: "ready"`.
- `mcp` retorna `handshake: true`, `toolsCount` e um `status` com o `scope` do perfil.
- `status` mostra `services.memory: "ready"`.

## Problemas comuns

Consulte [solução de problemas](troubleshooting.md). Para reinstalar um motor depois de uma falha, rode `install <motor>` novamente: a árvore é a mesma, e builds incompletos são refeitos.
