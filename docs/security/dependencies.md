# Dependências

Propósito: registrar as dependências da suíte e dos motores, as auditorias executadas, as correções aplicadas e as pendências. Público: mantenedores. Data: 2026-10-21.

## Dependências da suíte

Declaradas em `package.json`. Lockfile: `package-lock.json`.

| Pacote | Versão | Tipo | Uso |
|---|---|---|---|
| `smol-toml` | 1.9.1 | runtime | Leitura de TOML (`.ai-memory.toml`, `.codex/config.toml`) |
| `zod` | 4.3.6 | runtime | Validação de schemas |
| `@types/node` | 24.10.1 | dev | Tipos do Node |
| `eslint` | 9.39.1 | dev | Lint |
| `typescript-eslint` | 8.48.1 | dev | Regras de lint para TypeScript |
| `tsx` | 4.21.0 | dev | Execução dos testes |
| `typescript` | 5.9.3 | dev | Compilação |
| `pnpm` | 10.34.6 | dev | Compilação do Gateway |

## Dependências dos motores

- **Jev Gateway 0.5.1**: gerenciado com pnpm e `pnpm-lock.yaml` do próprio upstream. A instalação usa `--frozen-lockfile --ignore-scripts`, então o lockfile não muda e scripts de instalação de pacotes não rodam.
- **AI Memory 3.1.2**: gerenciado com Cargo e `Cargo.lock` do próprio upstream. A compilação usa `--locked`.

Os lockfiles dos upstreams não foram alterados pela suíte.

## Auditorias

Registros em `.local/evidence/M7-dependency-audit.txt`.

| Alvo | Resultado | Ação |
|---|---|---|
| Suíte, `npm audit` | Alerta alto em `smol-toml` 1.6.0 (negação de serviço) | Corrigido para 1.9.1 |
| Suíte, `npm audit` | Alerta alto em `pnpm` 10.33.3 | Corrigido para 10.34.6 |
| Suíte, `npm audit` | Alerta baixo em `esbuild`, dependência transitiva de `tsx` (usada em desenvolvimento) | Pendente. Afeta o servidor de desenvolvimento do esbuild, que a suíte não usa. |
| Gateway, `pnpm audit --prod` | Alerta moderado em `hono` (GHSA-5r4p-p66f-jhc7), via `serveStatic` | Não corrigido no lockfile do upstream. O código do Gateway não usa `serveStatic`, conforme a análise registrada. |
| AI Memory, `cargo audit` e `cargo deny` | Não executados | Pendente (M7) |

A saída completa, antes e depois das correções, está no arquivo de evidência. `npm audit fix --force` não foi aplicado, porque pode alterar versões de forma incompatível.

## Política

- Correções de segurança são aplicadas por versão fixada, com o lockfile atualizado.
- `npm audit fix --force` não é usado sem revisão.
- Lockfiles de upstream não são editados. Se um alerta exigir mudança no upstream, registre-o e aguarde ou aplique a atualização por commit fixado ([atualização de upstream](../guides/upstream-updates.md)).
- Qualquer nova dependência precisa de justificativa, pois a suíte prefere bibliotecas existentes a código próprio apenas quando elas atendem ao requisito.

## Testes do upstream AI Memory (M6)

Registros em `.local/evidence/M6-memory-upstream-checks.txt`.

- Executados: `cargo fmt --check` (passou) e `cargo test -p ai-memory-core -p ai-memory-hooks` (956 de 957 testes aprovados).
- Falha registrada: `router::tests::mid_session_out_of_tree_cwd_sticks_under_repo_root`. A causa provável é o `TEMP` estar dentro do checkout Git, mas isso **não foi verificado**.
- **Não executados:** `cargo test --workspace`, `cargo deny` e `cargo audit`. As ferramentas de `cargo audit` e `cargo deny` não estão instaladas no ambiente.

## Pendências

1. Executar `cargo test --workspace`, `cargo audit` e `cargo deny` no AI Memory, após instalar as ferramentas.
2. Investigar a falha `mid_session_out_of_tree_cwd_sticks_under_repo_root` e confirmar a causa.
2. Reavaliar o alerta do `hono` antes de habilitar o Gateway em uso real.
3. Reavaliar o alerta do `esbuild` quando o `tsx` for atualizado.
4. Gerar um SBOM para os artefatos compilados, se for exigido.
