# Plano de implementaÃƒÂ§ÃƒÂ£o

PropÃƒÂ³sito: plano verificÃƒÂ¡vel da integraÃƒÂ§ÃƒÂ£o. PÃƒÂºblico: mantenedores. Data: 2026-10-21.

Preservar os motores oficiais como subtrees e implementar um gerenciador local separado. InstalaÃƒÂ§ÃƒÂµes, configuraÃƒÂ§ÃƒÂµes de teste e memÃƒÂ³rias sintÃƒÂ©ticas ficam no workspace. Nenhuma validaÃƒÂ§ÃƒÂ£o ausente serÃƒÂ¡ apresentada como concluÃƒÂ­da.

- [x] M0 Ã¢â‚¬â€ Verificar executor, leitura/escrita, Git e propriedade na pasta atual.
- [x] M1 Ã¢â‚¬â€ Criar estrutura, registro de testes e instruÃƒÂ§ÃƒÂµes; validar e criar commit inicial.
- [x] M2 Ã¢â‚¬â€ Importar os dois subtrees, ler documentaÃƒÂ§ÃƒÂ£o/contratos e registrar proveniÃƒÂªncia/licenÃƒÂ§as.
- [ ] M3 Ã¢â‚¬â€ Implementar configuraÃƒÂ§ÃƒÂ£o estrita, instalaÃƒÂ§ÃƒÂ£o, ciclo de vida, atualizaÃƒÂ§ÃƒÂ£o e diagnÃƒÂ³stico locais.
- [ ] M4 Ã¢â‚¬â€ Implementar integraÃƒÂ§ÃƒÂ£o MCP, hooks, perfis de clientes e recuperaÃƒÂ§ÃƒÂ£o reversÃƒÂ­vel.
- [ ] M5 Ã¢â‚¬â€ Executar testes reais dos quatro modos, persistÃƒÂªncia/reinÃƒÂ­cio e roteamento.
- [ ] M6 Ã¢â‚¬â€ Executar verificaÃƒÂ§ÃƒÂµes upstream e validaÃƒÂ§ÃƒÂµes separadas dos trÃƒÂªs clientes.
- [ ] M7 Ã¢â‚¬â€ Concluir documentaÃƒÂ§ÃƒÂ£o, revisÃƒÂ£o de seguranÃƒÂ§a e relatÃƒÂ³rio honesto dos gates.

Escopo: monorepo, gerenciador, integraÃƒÂ§ÃƒÂ£o local, testes sintÃƒÂ©ticos, documentaÃƒÂ§ÃƒÂ£o e evidÃƒÂªncias. NÃƒÂ£o inclui publicaÃƒÂ§ÃƒÂ£o, alteraÃƒÂ§ÃƒÂµes globais nem uso de memÃƒÂ³rias/credenciais pessoais nos testes.

Gates: cada marco exige atualizaÃƒÂ§ÃƒÂ£o de progress.md e tests.json, evidÃƒÂªncia e checagens pertinentes aprovadas antes de avanÃƒÂ§ar. Bloqueios externos de validaÃƒÂ§ÃƒÂ£o devem ficar explÃƒÂ­citos.
