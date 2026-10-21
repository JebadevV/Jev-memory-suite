# Jev Memory Suite

Propósito: índice central do repositório, com o escopo da suíte, o estado de validação, o início rápido e os links para a documentação. Público: usuários e mantenedores. Data: 2026-10-21.

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

## Documentação

- [Arquitetura](docs/architecture/README.md) e [decisões (ADR)](docs/architecture/adr/README.md)
- [API e contratos](docs/api/README.md): CLI, configuração, endpoint de controle, hooks e bridge, arquivos gerenciados
- [Guias](docs/guides/README.md): instalação, desenvolvimento, configuração, clientes, atualização de upstream e solução de problemas
- [Segurança](docs/security/README.md): modelo de ameaças, revisão OWASP/ASVS, credenciais e isolamento de hooks, LGPD e dependências
- [Operação e recuperação](docs/runbooks/README.md): rotina operacional, backup e recuperação
- [Instruções de contribuição](AGENTS.md)

## Fontes e licenças

| Motor | Origem | Commit importado | Licença |
|---|---|---|---|
| Jev Gateway 0.5.1 | `upstream/jev-gateway` | `71bfdd18903b24081bf338d0516116fab197bd3d` | MIT |
| AI Memory 3.1.2 | `upstream/ai-memory` | `ad264519488c06e4468f1ad9f805d5fed2f97855` | MIT |

- O manifesto de origem está em [upstream.sources.json](upstream.sources.json) e os avisos de atribuição em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Os diretórios `upstream/` são importados com `git subtree --squash` e não são modificados. O AI Memory é compilado a partir da fonte importada; o binário de release não é usado.
- Atualização de cada motor: [guia de atualização](docs/guides/upstream-updates.md).
