# Plano de implementaÃ§Ã£o

PropÃ³sito: plano verificÃ¡vel da integraÃ§Ã£o. PÃºblico: mantenedores. Data: 2026-10-21.

Preservar os motores oficiais como subtrees e implementar um gerenciador local separado. InstalaÃ§Ãµes, configuraÃ§Ãµes de teste e memÃ³rias sintÃ©ticas ficam no workspace. Nenhuma validaÃ§Ã£o ausente serÃ¡ apresentada como concluÃ­da.

- [x] M0 â€” Verificar executor, leitura/escrita, Git e propriedade na pasta atual.
- [x] M1 â€” Criar estrutura, registro de testes e instruÃ§Ãµes; validar e criar commit inicial.
- [ ] M2 â€” Importar os dois subtrees, ler documentaÃ§Ã£o/contratos e registrar proveniÃªncia/licenÃ§as.
- [ ] M3 â€” Implementar configuraÃ§Ã£o estrita, instalaÃ§Ã£o, ciclo de vida, atualizaÃ§Ã£o e diagnÃ³stico locais.
- [ ] M4 â€” Implementar integraÃ§Ã£o MCP, hooks, perfis de clientes e recuperaÃ§Ã£o reversÃ­vel.
- [ ] M5 â€” Executar testes reais dos quatro modos, persistÃªncia/reinÃ­cio e roteamento.
- [ ] M6 â€” Executar verificaÃ§Ãµes upstream e validaÃ§Ãµes separadas dos trÃªs clientes.
- [ ] M7 â€” Concluir documentaÃ§Ã£o, revisÃ£o de seguranÃ§a e relatÃ³rio honesto dos gates.

Escopo: monorepo, gerenciador, integraÃ§Ã£o local, testes sintÃ©ticos, documentaÃ§Ã£o e evidÃªncias. NÃ£o inclui publicaÃ§Ã£o, alteraÃ§Ãµes globais nem uso de memÃ³rias/credenciais pessoais nos testes.

Gates: cada marco exige atualizaÃ§Ã£o de progress.md e tests.json, evidÃªncia e checagens pertinentes aprovadas antes de avanÃ§ar. Bloqueios externos de validaÃ§Ã£o devem ficar explÃ­citos.
