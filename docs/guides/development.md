# Desenvolvimento

Propósito: documentar os comandos de build, lint, typecheck e testes, e as convenções de contribuição. Público: contribuidores e agentes de código. Data: 2026-10-21.

## Comandos

| Comando | Ação |
|---|---|
| `npm run build` | `tsc`: compila `src/` e `test/` para `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint src test` com `typescript-eslint` recomendado e `no-explicit-any` como erro |
| `npm test` | `tsx --test test/*.test.ts`: testes unitários e de integração local |
| `npm run test:e2e` | `tsx --test --test-concurrency=1 test/e2e.ts`: processos reais |
| `npm run suite -- <comando>` | Equivale a `node bin/jev-memory.mjs` |

Ordem recomendada antes de um commit: `npm run build`, `npm run lint`, `npm test`. Rode `npm run test:e2e` quando alterar supervisor, instalação, hooks, MCP ou lançamento.

## Testes

- Os testes unitários usam diretórios temporários e dados sintéticos. Não usam credenciais.
- `test/e2e.ts` inicia processos reais (supervisor, memória, Gateway, hook nativo, Jev simulado e upstream simulado) com portas próprias, diferentes das padrão. Exige que os motores estejam instalados e que `dist/` esteja atualizado.
- Jev e provedor OpenAI são **simulados** em loopback. Um teste verde não comprova provedor real.
- Não há script de cobertura configurado. A meta de 80% das regras do projeto não está medida no repositório.
- Registre o resultado de cada execução relevante em `tests.json` conforme [ADR 0005](../architecture/adr/0005-validation-evidence-policy.md).

## Falhas conhecidas nos upstreams

Os checks dos motores são executados nos próprios diretórios `upstream/`, não pela suíte. Registros em `.local/evidence/M6-*.txt`:

- Jev: `tsc --noEmit` passou; `vitest` teve 397 de 400 testes aprovados. As três falhas são de launcher e setup no Windows: o modo POSIX `0600` aparece como `438`, e a saída do launcher ficou vazia.
- AI Memory: `cargo fmt --check` passou; `ai-memory-core` e `ai-memory-hooks` tiveram 956 de 957 testes aprovados. Falhou `router::tests::mid_session_out_of_tree_cwd_sticks_under_repo_root`. A causa provável é o `TEMP` estar dentro do checkout Git, por isolamento, mas isso **não foi verificado**.

Não corrija esses testes alterando `upstream/`. Registre a falha e a causa observada.

## Convenções (de `AGENTS.md`)

- Trabalhe apenas neste repositório. Preserve arquivos existentes e as evidências locais.
- Não modifique `upstream/jev-gateway` nem `upstream/ai-memory`. Atualize-os pelo `git subtree` (veja [atualização de upstream](upstream-updates.md)).
- Implemente a integração fora dos motores.
- Não instale pacotes globais, não sobrescreva configurações de clientes, não apague memórias, não altere credenciais, não faça deploy, não faça force push e não reescreva histórico.
- Serviços só escutam em `127.0.0.1`.
- Valide entradas externas com schemas e allowlists. Use arrays de argumentos em vez de comandos montados com interpolação.
- Nunca registre segredos em logs nem em documentação.
- Configurações geradas são escopadas ao workspace. Alterações em configurações existentes preservam chaves e MCPs não relacionados.
- Valide Claude CLI, Codex CLI e Codex Desktop separadamente.

## Documentação

- Todo documento de primeira parte começa com `# Título` e a linha `Propósito: … Público: … Data: AAAA-MM-DD.`
- Escreva em português brasileiro, de forma factual e concisa. Não afirme resultado que não está em `tests.json`.
- Links internos são relativos. Diagramas Mermaid ficam em blocos ` ```mermaid `.
- O `README.md` na raiz é o índice central.

## Commits

Use o formato `<tipo>: <descrição>`, com tipos como `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf` e `ci`, conforme o histórico do repositório.

## Alterações de configuração ou contrato

Ao mudar um campo de `suite.json`, atualize o schema em `src/config.ts`, a documentação em [schema de configuração](../api/configuration-schema.md) e os testes correspondentes. Ao mudar um formato de arquivo gerenciado, atualize [arquivos gerenciados](../api/managed-files.md).
