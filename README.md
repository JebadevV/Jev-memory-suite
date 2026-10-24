# Jev Memory Suite

Propósito: índice central do repositório, com o escopo da suíte, o estado de validação, o início rápido e os links para a documentação. Público: usuários e mantenedores. Data: 2026-10-23.

## Estado

Implementação em andamento. Os marcos M0 a M5 e M7 estão aprovados; M6 está parcial. Os gaps G1 a G3 de paridade com a instalação original (busca semântica, hooks e histórico) foram resolvidos e validados; detalhes na seção "Gaps G1-G3" de [progress.md](progress.md). O marco de estabilização 3 (2026-10-22) cobre o ciclo de vida do Gateway, a recuperação limitada do supervisor, o harness de hooks e o isolamento dos testes; a suíte de testes está verde. A fonte de verdade do estado é [tests.json](tests.json), com o histórico em [progress.md](progress.md) e o plano em [plan.md](plan.md).

Situação dos clientes, conforme [tests.json](tests.json):

- **Claude Code CLI: aprovado.** MCP conectado. Os 9 eventos de hook foram verificados em sessões reais: `claude -p` cobre SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop e SessionEnd, e `PreCompact` foi confirmado com `/compact`. Recuperação por `memory_query`, persistência após reinício e recuperação por outra sessão já estavam validadas. A sessão interativa (TUI) ainda não foi exercitada.
- **Codex CLI: parcial.** MCP real aprovado (`memory_status` e `memory_query` no servidor `jev_memory_suite`). A captura por hooks foi comprovada no projeto Farol no marco de estabilização 2, com bypass de confiança de hooks só naquela invocação. A confiança normal dos 7 hooks (revisão em `/hooks`) segue pendente de ação do usuário.
- **Codex Desktop: não verificado.** Precisa ser validado dentro do app, com o checklist manual em [clientes](docs/guides/clients.md). CLI, launcher e configuração gerada não comprovam o Desktop.
- **Antigravity CLI (`agy` 1.4.5): aprovado na CLI.** MCP, hooks, finalização e handoff validados em execução real com `jev-memory-agy`. Antigravity IDE e App não verificados. Procedimento em [clientes](docs/guides/clients.md#antigravity-cli-agy).
- **Testes:** `npm test` 229/229, `npm run test:e2e` 4/4, `npm run test:projects` 1/1 e `npm run test:semantic` 1/1, com build, typecheck e lint ok. `npm audit --omit=dev` sem vulnerabilidades.

Disponibilidade de um cliente no repositório não equivale a integração validada. Procedimentos e ações pendentes do usuário estão em [clientes](docs/guides/clients.md).

## O que é

Gerenciador local que instala, configura e inicia dois motores oficiais, sem modificar suas fontes:

- **Jev Gateway 0.5.1** (MIT): proxy de APIs de modelos, com roteamento Jev opcional. Não é servidor MCP nem base de memória.
- **AI Memory 3.1.2** (MIT): servidor MCP e HTTP, hooks de captura, wiki versionada e SQLite.

Os serviços escutam apenas em `127.0.0.1`. Os dados ficam em `.local/`, ignorado pelo Git. MCP e hooks são registrados nos clientes somente dentro do workspace, com propriedade rastreada e backup. Detalhes em [arquitetura](docs/architecture/README.md).

## Início rápido

Requisitos: Node.js 24 ou superior, npm, Git e toolchain Rust com `cargo +stable` (usado para compilar o AI Memory). A única plataforma validada até agora é Windows 10.

```bash
npm ci
npm run build
node bin/jev-memory.mjs init
node bin/jev-memory.mjs install all
node bin/jev-memory.mjs start
node bin/jev-memory.mjs doctor
node bin/jev-memory.mjs status
node bin/jev-memory.mjs stop
```

- `init` cria `.local/profiles/default/` a partir de `config/default.json`. Não sobrescreve um perfil existente.
- O Jev Gateway vem desabilitado. Para habilitá-lo, veja [configuração](docs/guides/configuration.md).
- Para outro perfil, use `--profile <nome>` e ajuste as portas antes de iniciar. Veja [instalação](docs/guides/installation.md).

## Usar em qualquer projeto

A instalação fica nesta pasta; Codex e Claude trabalham na pasta atual do terminal. Por exemplo, dentro de outro projeto:

```powershell
cd C:\caminho\para\seu-projeto
# Uma vez por cliente/projeto, para registrar MCP e hooks:
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs clients install codex .
# Nas próximas sessões:
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs codex
```

Troque `codex` por `claude` para o Claude Code, ou use `antigravity` no registro e `jev-memory agy` para o Antigravity CLI. A memória inicia quando necessário. Projetos externos recebem perfis, bancos e portas próprios em `.local/profiles/` da instalação. A raiz Git mantém o mesmo perfil quando o comando parte de uma subpasta; pastas sem Git também funcionam.

Para usar nomes curtos, ative uma vez a pasta `bin` no PATH do seu usuário e abra um terminal novo:

```powershell
node C:\caminho\para\jev-memory-suite\scripts\enable-shell.mjs --persist
```

Depois, em qualquer projeto:

```powershell
jev-memory clients install codex .  # uma vez por cliente/projeto
jev-memory-codex
# Ou, após registrar o Claude com jev-memory clients install claude .:
jev-memory-claude
# Ou, após registrar o Antigravity com jev-memory clients install antigravity .:
jev-memory-agy
```

Os quatro comandos ficam em `bin/`:

- `jev-memory`: a mesma CLI de `bin/jev-memory.mjs`, com todos os comandos de `start`, `status`, `doctor`, `dashboard`, `clients` e os demais.
- `jev-memory-codex` e `jev-memory-claude`: abrem o Codex ou o Claude Code com o gateway e a memória da suíte. Todos os argumentos são repassados ao cliente.
- `jev-memory-agy`: abre o Antigravity CLI (`agy`) com a memória da suíte, igual a `jev-memory agy`. Argumentos, diretório e código de saída do `agy` são repassados sem alteração. Não passa pelo Jev Gateway.
- Flags de launcher (`--dashboard`, `--status`, `--start`, `--stop`, `--setup`, `--logs`, `--routing`, `--print-config`, `--gateway-help`) são tratadas pelo launcher upstream (`jev-codex` ou `jev-claude`), sem argumentos de memória adicionados.

O ativador preserva as entradas existentes do PATH, cria backup local e não instala pacote global. Use `--check` para apenas verificar. Em um PowerShell já aberto, ative só a sessão com `$env:Path += ';C:\caminho\para\jev-memory-suite\bin'`.

O registro é explícito, preserva outros MCPs e configurações e faz backup no projeto. No Codex, revise os hooks em `/hooks`; no Claude, aprove o MCP do projeto. No Antigravity, o MCP é global e `clients remove` não o remove; veja [clientes](docs/guides/clients.md#antigravity-cli-agy). O Desktop continua exigindo validação dentro do app. Veja [uso em projetos externos](docs/guides/external-projects.md).

## Memória semântica local

A busca combina léxico e vetores. Os vetores são gerados pelo modelo all-MiniLM-L6-v2 dentro do próprio motor de memória do perfil, sem enviar texto para fora da máquina. O modelo é verificado por sha256 antes do uso; a primeira execução só precisa de rede se não houver cópia verificada da instalação original. Detalhes em [ADR 0007](docs/architecture/adr/0007-local-semantic-memory.md).

- Ligada por padrão (`memory.semanticSearch: true`). Para desligar, pare o perfil, altere o `suite.json` com `config` e inicie de novo ([configuração](docs/guides/configuration.md#busca-semântica-local)).
- No log `logs/memory.log`, a linha `embedder enabled provider="local"` confirma que a busca vetorial está ativa.

## Hooks de captura

Claude Code recebe 9 eventos: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`, `PreCompact`, `Stop`, `SubagentStart` e `SubagentStop`. O Codex recebe 7, sem os eventos de subagente. Cada evento é validado por schema antes de chegar ao motor. Os quatro eventos `PreCompact`, `Stop`, `SubagentStart` e `SubagentStop` respondem `{}`, sem decisão. O Antigravity CLI recebe 4 eventos: `PreInvocation` (início da sessão na suíte), `PreToolUse`, `PostToolUse` e `Stop`. O `PreToolUse` sempre responde `allow` e não contorna as permissões do agy. Detalhes em [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md).

Depois de atualizar a suíte, rode `npm run build` e reinstale os hooks com `node bin/jev-memory.mjs clients install claude [dir]` (ou `codex`). No Codex, revise os hooks em `/hooks`. Procedimentos em [instalação](docs/guides/installation.md#hooks) e [API de hooks](docs/api/hooks-and-bridge.md).

## Migração do histórico

Para trazer o histórico da instalação original do AI Memory para o perfil da suíte, use `migrate-history`. Ele simula por padrão, e só grava com `--apply`, depois de parar a suíte. O procedimento completo, com backups, verificação, leitura do relatório e rollback, está no [guia de migração](docs/guides/migration.md). Decisão em [ADR 0008](docs/architecture/adr/0008-history-migration.md).

## Verificação

| Comando | O que verifica |
|---|---|
| `npm test` | Testes unitários e de integração local (`test/*.test.ts`) |
| `npm run test:semantic` | Busca semântica com o motor real, em perfil descartável |
| `npm run test:e2e` | Processos reais: supervisor, memória, Gateway, hook nativo e Jev simulado |
| `npm run test:projects` | Projetos externos, com processos reais e isolamento entre perfis |
| `node bin/jev-memory.mjs doctor` | Estado do perfil, motores e supervisor |
| `node bin/jev-memory.mjs mcp` | Handshake MCP e `memory_status` com o escopo do perfil |

Os resultados registrados e as falhas conhecidas estão em [tests.json](tests.json) e em [desenvolvimento](docs/guides/development.md).

## Painel local

`jev-memory dashboard` (ou `jev-memory-claude --dashboard`) garante que a memória e o painel estejam prontos e abre o painel em `http://127.0.0.1:<dashboard.port>/`. Sem essa chave no perfil, a porta padrão é 18879. Há um único endereço para o painel, e ele escuta apenas em loopback.

O painel reúne:

- o painel de memória do AI Memory, com resumo e feed de atividade por projeto. A lista inclui o projeto da suíte e os projetos externos válidos;
- o painel do Jev Gateway, com um único iframe do agregador: o Codex, se estiver em execução, ou o Claude. A página original do upstream mostra os dois roteadores, com filtros e interruptores de roteamento. As portas vêm da instalação upstream (padrão 8789 e 8790) e as demais entram em `?peers=`;
- uma seção de observabilidade de tokens, com o histórico do log do launcher por cliente e combinado, tabela por modelo, custo estimado e comparação com e sem Jev. Os custos são estimativas de preço de API, não cobrança de assinatura;
- sem gateway em execução, o lugar do iframe mostra "Gateways offline" com os comandos para iniciar cada um. Se o agregador mudar com a página aberta, aparece um aviso para recarregar.

Títulos, caminhos e nomes de projeto são exibidos como texto. Os painéis diretos dos gateways (`http://localhost:8790/dashboard` e `:8789`) continuam acessíveis e não redirecionam. Decisões em [ADR 0010](docs/architecture/adr/0010-unified-dashboard.md) e [ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md); operação em [runbook](docs/runbooks/operations.md#painel-de-gateways); configuração em [configuração](docs/guides/configuration.md#experimento-de-roteamento-e-preços); medição de tokens em [otimização de tokens](docs/guides/token-optimization.md); detalhes em [arquitetura](docs/architecture/README.md).

## Documentação

- [Arquitetura](docs/architecture/README.md) e [decisões (ADR)](docs/architecture/adr/README.md)
- [API e contratos](docs/api/README.md): CLI, configuração, endpoint de controle, hooks e bridge, arquivos gerenciados
- [Guias](docs/guides/README.md): instalação, desenvolvimento, configuração, clientes, migração do histórico, atualização de upstream e solução de problemas
- [Migração do histórico](docs/guides/migration.md): trazer o histórico da instalação original, com backups, relatório e rollback; decisão em [ADR 0008](docs/architecture/adr/0008-history-migration.md)
- [Busca semântica local](docs/architecture/adr/0007-local-semantic-memory.md): decisão de embeddings locais e provisionamento do modelo
- [Gateways e recuperação](docs/architecture/adr/0009-gateway-ownership-and-recovery.md): dono de cada Gateway, sonda das portas upstream em loopback e reinício limitado do supervisor (ADR 0009)
- [Projetos externos](docs/guides/external-projects.md): lançamento a partir de qualquer pasta, perfis isolados e comandos PowerShell; decisão em [ADR 0006](docs/architecture/adr/0006-external-projects.md)
- [Antigravity CLI (agy)](docs/guides/clients.md#antigravity-cli-agy): registro por workspace, MCP global, hooks, launcher e finalização; decisão em [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md)
- [Segurança](docs/security/README.md): modelo de ameaças, revisão OWASP/ASVS, credenciais e isolamento de hooks, LGPD e dependências
- [Operação e recuperação](docs/runbooks/README.md): rotina operacional, backup e recuperação
- [Instruções de contribuição](AGENTS.md)
- [Changelog](CHANGELOG.md): histórico de versões no formato Keep a Changelog

## Fontes e licenças

| Motor | Origem | Commit importado | Licença |
|---|---|---|---|
| Jev Gateway 0.5.1 | `upstream/jev-gateway` | `71bfdd18903b24081bf338d0516116fab197bd3d` | MIT |
| AI Memory 3.1.2 | `upstream/ai-memory` | `ad264519488c06e4468f1ad9f805d5fed2f97855` | MIT |

- O manifesto de origem está em [upstream.sources.json](upstream.sources.json) e os avisos de atribuição em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Os diretórios `upstream/` são importados com `git subtree --squash` e não são modificados. O AI Memory é compilado a partir da fonte importada; o binário de release não é usado.
- Atualização de cada motor: [guia de atualização](docs/guides/upstream-updates.md).

## Créditos

A suíte integra dois motores de terceiros, sem modificar suas fontes. Ambos são distribuídos sob a licença MIT:

- **Jev Gateway**, Copyright (c) 2026 Vinicius Lana. Licença: [upstream/jev-gateway/LICENSE](upstream/jev-gateway/LICENSE).
- **AI Memory**, Copyright (c) 2026 Fabio Akita. Licença: [upstream/ai-memory/LICENSE](upstream/ai-memory/LICENSE).

Avisos de atribuição completos estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
