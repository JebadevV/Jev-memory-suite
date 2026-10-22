# Changelog

Propósito: registrar as mudanças de cada versão da suíte, em ordem cronológica inversa. Público: usuários e mantenedores. Data: 2026-10-22.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## Não lançado

- Nenhuma alteração desde a 0.1.0.

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
