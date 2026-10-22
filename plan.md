# Plano de implementacao

Proposito: acompanhar marcos verificaveis. Publico: mantenedores. Data: 2026-10-21.

- [x] M0: Executor, leitura/escrita, Git e propriedade.
- [x] M1: Estrutura e instrucoes.
- [x] M2: Importacao subtree, documentacao e proveniencia.
- [x] M3: Gerenciador, instalacao, configuracao e ciclo de vida.
- [x] M4: MCP, hooks e configuracoes reversiveis dos clientes.
- [x] M5: Quatro modos, captura, consulta, persistencia e roteamento.
- [ ] M6: Checks upstream e validacao independente de cada cliente.
- [x] M7: Documentacao e revisao final de seguranca.

Um marco por vez; resultado ausente nunca equivale a aprovado. Fontes originais preservadas; tudo local ao workspace.

Complemento M6 (2026-10-21): uso em projetos externos implementado e validado (81 testes, 4 E2E de regressao e 1 E2E externo). Launchers usam cwd/--dir; perfis, bancos e portas por projeto; registro explicito e fronteira de hooks por projectRoot. M6 permanece parcial por confianca interativa do Codex, Desktop e gates upstream anteriores. Evidencia: .local/evidence/external-projects-validation.json.

Complemento M6 (2026-10-21): comandos Windows jev-memory, jev-memory-codex e jev-memory-claude implementados; build/lint, teste de preservacao de PATH e E2E dos dois nomes curtos aprovados. Ativacao persistente do PATH do usuario depende de autorizacao por ser uma escrita fora do repositorio; nao altera o estado pendente do Desktop ou da confianca interativa de hooks.

Ativacao dos comandos curtos (2026-10-21): autorizada e executada. Pasta bin adicionada ao PATH do usuario, preservacao exata de entradas/tipo verificada contra backup local e notificacao de ambiente confirmada. Novos terminais podem executar jev-memory-codex, jev-memory-claude e jev-memory. Evidencia: .local/evidence/short-commands-activation.json. M6 e gates de Desktop/hooks continuam com os limites registrados.
