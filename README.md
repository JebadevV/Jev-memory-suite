# Jev Memory Suite

Propósito: índice central do repositório, com o escopo da suíte, o estado de validação, o início rápido e os links para a documentação. Público: usuários e mantenedores. Data: 2026-10-22.

## Estado

Implementação em andamento. Os marcos M0 a M5 estão aprovados; M6 está parcial e M7 (revisão final) está em fechamento. A fonte de verdade do estado é [tests.json](tests.json), com o histórico em [progress.md](progress.md) e o plano em [plan.md](plan.md).

Situação dos clientes, conforme [tests.json](tests.json):

- **Claude Code CLI: aprovado.** MCP conectado; captura real pelos hooks SessionStart, UserPromptSubmit, PreToolUse e PostToolUse, todos com saída 0; 7 observações capturadas; recuperação por `memory_query`; persistência após reinício; recuperação por uma segunda sessão do cliente.
- **Codex CLI: parcial.** MCP real aprovado (`memory_status` e `memory_query` no servidor `jev_memory_suite`). Recuperou a sessão capturada pelo Claude, o que comprova continuidade entre clientes. A captura por hooks está pendente da confiança nativa do Codex.
- **Codex Desktop: pendente.** Precisa ser validado dentro do app. CLI, launcher e configuração gerada não comprovam o Desktop.

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

Troque `codex` por `claude` para o Claude Code. A memória inicia quando necessário. Projetos externos recebem perfis, bancos e portas próprios em `.local/profiles/` da instalação. A raiz Git mantém o mesmo perfil quando o comando parte de uma subpasta; pastas sem Git também funcionam.

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
```

Os três comandos ficam em `bin/`:

- `jev-memory`: a mesma CLI de `bin/jev-memory.mjs`, com todos os comandos de `start`, `status`, `doctor`, `dashboard`, `clients` e os demais.
- `jev-memory-codex` e `jev-memory-claude`: abrem o Codex ou o Claude Code com o gateway e a memória da suíte. Todos os argumentos são repassados ao cliente.
- Flags de launcher (`--dashboard`, `--status`, `--start`, `--stop`, `--setup`, `--logs`, `--routing`, `--print-config`, `--gateway-help`) são tratadas pelo launcher upstream (`jev-codex` ou `jev-claude`), sem argumentos de memória adicionados.

O ativador preserva as entradas existentes do PATH, cria backup local e não instala pacote global. Use `--check` para apenas verificar. Em um PowerShell já aberto, ative só a sessão com `$env:Path += ';C:\caminho\para\jev-memory-suite\bin'`.

O registro é explícito, preserva outros MCPs e configurações e faz backup no projeto. No Codex, revise os hooks em `/hooks`; no Claude, aprove o MCP do projeto. O Desktop continua exigindo validação dentro do app. Veja [uso em projetos externos](docs/guides/external-projects.md).

## Painel local

`jev-memory dashboard` (ou `jev-memory-claude --dashboard`) garante que a memória e o painel estejam prontos e abre `http://127.0.0.1:<porta>/` no navegador. A porta vem de `dashboard.port` no perfil; sem essa chave, o padrão é 18879. O servidor escuta apenas em loopback.

O painel reúne:

- o painel de memória do AI Memory, com resumo e feed de atividade por projeto. A lista inclui o projeto da suíte e os projetos externos válidos;
- o painel do Jev Gateway, incorporado de `http://localhost:8790/dashboard`.

Títulos, caminhos e nomes de projeto são exibidos como texto. Detalhes em [arquitetura](docs/architecture/README.md).

## Documentação

- [Arquitetura](docs/architecture/README.md) e [decisões (ADR)](docs/architecture/adr/README.md)
- [API e contratos](docs/api/README.md): CLI, configuração, endpoint de controle, hooks e bridge, arquivos gerenciados
- [Guias](docs/guides/README.md): instalação, desenvolvimento, configuração, clientes, atualização de upstream e solução de problemas
- [Projetos externos](docs/guides/external-projects.md): lançamento a partir de qualquer pasta, perfis isolados e comandos PowerShell; decisão em [ADR 0006](docs/architecture/adr/0006-external-projects.md)
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
