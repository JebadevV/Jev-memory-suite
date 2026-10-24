# Desenvolvimento

Propósito: documentar os comandos de build, lint, typecheck e testes, e as convenções de contribuição. Público: contribuidores e agentes de código. Data: 2026-10-23.

## Comandos

| Comando | Ação |
|---|---|
| `npm run build` | `tsc`: compila `src/` e `test/` para `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint src test` com `typescript-eslint` recomendado e `no-explicit-any` como erro |
| `npm test` | `tsx --test test/*.test.ts`: testes unitários e de integração local |
| `npm run test:e2e` | `tsx --test --test-concurrency=1 test/e2e.ts`: processos reais |
| `npm run test:projects` | `tsx --test --test-concurrency=1 test/projects-e2e.ts`: projetos externos com processos reais |
| `npm run test:semantic` | `tsx --test --test-concurrency=1 test/semantic-e2e.ts`: busca semântica com o motor real, em perfil descartável |
| `npm run test:headroom` | `tsx --test --test-concurrency=1 test/headroom-e2e.ts`: Headroom 0.41.0 real, Jev real e provedor simulado; pulado com o motivo se o Headroom 0.41.0 não estiver instalado |
| `npm run test:headroom-codex` | `tsx --test --test-concurrency=1 test/headroom-codex-e2e.ts`: Codex com login ChatGPT simulado pelo shim do Headroom 0.41.0 real, Jev codex real, backend ChatGPT simulado e JWT falso; 11 verificações; pulado com o motivo se a rota Codex do Headroom 0.41.0 não estiver disponível |
| `npm run test:codex-launch` | `tsx --test --test-concurrency=1 test/codex-launch-e2e.ts`: caminho completo `jev-memory codex` com Codex real, login ChatGPT simulado, `CODEX_HOME` isolado e cerca de egress; este guia não registra resultado dele |
| `npm run test:claude-launch` | `tsx --test --test-concurrency=1 test/claude-launch-e2e.ts`: caminho completo `jev-memory claude` com perfis isolados, Claude Code real com chave falsa, home isolado, Jev em porta temporária e provedor simulado; cobre Headroom ligado, opt-out, fallback, desligado, recuperação, hooks e handoff |
| `npm run suite -- <comando>` | Equivale a `node bin/jev-memory.mjs` |

Para rodar um arquivo de teste isolado, use `npx tsx --test test/migrate.test.ts` (ou outro arquivo de `test/`).

Ordem recomendada antes de um commit: `npm run build`, `npm run lint`, `npm test`. Rode `npm run test:e2e` quando alterar supervisor, instalação, hooks, MCP ou lançamento. Rode `npm run test:semantic` quando alterar `src/models.ts`, a linha `embedding_provider` ou o supervisor. Rode `npm run test:projects` quando alterar launchers ou registro em projetos externos. Rode `npm run test:headroom` quando alterar `src/headroom.ts`, `startHeadroom` no supervisor, `prepareHeadroom` ou `jevLaunch` no launcher. Rode `npm run test:headroom-codex` quando alterar `src/headroom.ts`, `patches/headroom/`, `codexHeadroom` no supervisor ou `buildCodexHeadroomSpawn` no launcher. Rode `npm run test:codex-launch` quando alterar o caminho `jev-memory codex`.

Verificações rápidas do perfil em execução: `node bin/jev-memory.mjs doctor` e `node bin/jev-memory.mjs mcp`.

## Shim do Headroom para o Codex

Com o interpretador do `headroom-ai`, o shim pode ser conferido à mão (PowerShell):

```powershell
$env:HEADROOM_CHATGPT_CODEX_BASE_URL = 'http://127.0.0.1:8790/v1'
& '<caminho absoluto de python.exe do headroom-ai>' -I patches\headroom\0.41.0\jms_headroom_shim.py --check
```

A saída é uma linha JSON. Códigos de saída: 0 (ok), 2 (base inválida), 3 (versão diferente), 4 (forma do código diferente) e 5 (autoteste ou guard falhou). Detalhes em [solução de problemas](troubleshooting.md#codex) e em [patches do Headroom](../../patches/headroom/README.md).

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

## Isolamento de testes

As falhas de fixture que existiam até o marco 2 foram corrigidas no marco de estabilização 3 ([progress.md](../../progress.md)). A causa era a fixture usar o repositório como raiz: o perfil de teste lia o `.ai-memory.toml` e o registro de cliente da raiz, e o plano de lançamento caía no repositório real. Regras para novos testes:

- Perfis de teste recebem `projectRoot` em um diretório temporário **fora do repositório**. O plano de lançamento usa esse diretório como cwd.
- Fixtures não ficam em `.local/` dentro do repositório, e nenhum teste depende de marcador, registro de cliente ou escopo da raiz.
- Todo perfil criado pelo teste é parado e removido ao final (`test/e2e.ts`, `test/projects-e2e.ts` e `test/lifecycle.test.ts` seguem esse padrão).
- `npm test`, `npm run test:e2e`, `npm run test:projects` e `npm run test:semantic` não podem aumentar a quantidade de perfis em `.local/profiles/`. A verificação é contar os diretórios antes e depois da execução. No marco 3, a contagem ficou em 213 antes e depois.
- Perfis de testes deixados por execuções antigas não foram removidos. A remoção exige aprovação do operador.

## Falhas conhecidas da suíte

- Estado atual (marco 3): `npm test` 197/197, `npm run test:e2e` 4/4, `npm run test:projects` 1/1 e `npm run test:semantic` 1/1.
- Histórico: até o marco 2, `npm test` tinha 3 falhas em `test/launch.test.ts` e `npm run test:e2e` tinha a falha "both disabled". Ambas vinham da fixture descrita em "Isolamento de testes" e não do produto.

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
