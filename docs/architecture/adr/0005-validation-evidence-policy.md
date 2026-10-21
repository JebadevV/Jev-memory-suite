# ADR 0005 — política de evidência de validação

Propósito: definir quando um marco ou cliente pode ser declarado validado. Público: mantenedores. Data: 2026-10-21. Estado: aceito.

## Contexto

O risco principal do projeto é declarar uma integração funcionando sem validação real. Parte dos testes usa provedores e Jev simulados em loopback, e parte depende de ambiente que nem sempre está disponível, como clientes instalados e contas autenticadas.

## Decisão

- Cada marco e cada cliente tem um estado em `tests.json`: `passed`, `pending`, `blocked` ou `partial`.
- Evidências ficam em `.local/evidence/`, que é ignorado pelo Git. O registro aponta para elas.
- Ausência de resultado nunca é aprovação. Teste pulado ou bloqueado registra o motivo.
- Testes com provedor ou Jev simulados são registrados como simulados e não comprovam provedor real.
- Claude CLI, Codex CLI e Codex Desktop são validados separadamente. Sucesso do lançador não prova a integração do Desktop.
- Falhas de testes upstream são registradas com a saída do comando. Os subtrees não são alterados para fazê-las passar.
- Os registros são atualizados com `scripts/record.mjs`, que grava `tests.json`, `plan.md` e `progress.md`.

## Consequências

- Os documentos citam o estado a partir de `tests.json` e não afirmam validação de cliente enquanto o status for `pending`.
- Os testes unitários e de e2e usam dados sintéticos e portas próprias, diferentes das padrão.
- Evidências podem conter caminhos locais e identificadores do ambiente. Antes de compartilhar, revise o conteúdo.
- Um resultado com `partial` precisa dizer exatamente o que ficou de fora.
