# Fixtures de payloads de hooks

- Origem: payloads reais de Claude Code 2.1.309 e Codex CLI 0.163.0, capturados em 2026-10-25 pelas suítes de teste isoladas com provedores mock. Nenhuma chamada de modelo real foi feita.
- Há um evento representativo por agente e por evento, em `<agent>/<event>.json`. Para pre-tool-use e post-tool-use, o exemplo é uma chamada de shell (Bash).
- Sanitização: `session_id`, `prompt_id`, `turn_id` e `tool_use_id` viraram placeholders com a mesma classe de caracteres. Caminhos viraram `C:/fixture/project`. Textos livres (prompt, comando, stdout/stderr, última mensagem) viraram `fixture ...`. Nomes de modelo, modo de permissão, enums e booleanos foram mantidos.
- Preservados de propósito: o conjunto e a ordem das chaves, os tipos dos valores, o aninhamento e a diferença entre chave ausente e `null`.
- Exemplo: o pre-tool-use real não tem `tool_response`. Essa ausência causou a regressão com zod 4.6.7 e é coberta por `test/hook-payloads.test.ts`.
