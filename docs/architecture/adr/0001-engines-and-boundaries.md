# ADR 0001 — motores preservados e coordenação local

Propósito: fixar as fronteiras verificadas antes da integração. Público: mantenedores. Data: 2026-10-21. Estado: aceito.

O Jev Gateway 0.5.1 intercepta APIs de modelos; não é um servidor MCP nem uma base de memória. O AI Memory 3.1.2 fornece MCP, hooks, wiki versionada e SQLite. Os launchers oficiais podem descobrir configurações globais e iniciar assistentes de instalação, o que conflita com o isolamento solicitado.

A suíte usará os contratos existentes dos motores: aplicação Jev compilada, CLI AI Memory com `--data-dir`, transporte HTTP e bridge stdio nativo. Um supervisor da suíte será dono apenas dos processos que criar. O gerenciador não chamará `setup`, instaladores globais nem comandos de purge/reset.

Cada engine pode ser habilitada independentemente. Sem memória, não serão anunciadas ferramentas fictícias memory_status/memory_query. Sem Jev, o cliente usa seu provedor habitual. A memória fica em diretório privado local da suíte, comum aos clientes; o escopo estático sempre informa workspace e project.

Configurações e evidências serão locais ao workspace. Testes usam dados sintéticos e portas distintas das instalações existentes. Roteamento com transporte Jev simulado e roteamento contra o provedor real serão relatados separadamente. O suporte experimental do AI Memory ao Windows nativo e a confiança de hooks do Codex são limites explícitos.

Referências lidas: README/CONTRIBUTING e contratos src/config.ts/src/index.ts do Jev; README, INSTALL_FOR_AGENTS, docs/programmatic-memory.md, docs/mcp-install.md, docs/windows.md, docs/desktop/codex-desktop.md, docs/security.md, DATA_HANDLING.md e contratos cli/config/serve do AI Memory. O adaptador de reranking documentado pelo AI Memory é uma integração distinta e não é necessário para o roteamento de ferramentas do Gateway.
