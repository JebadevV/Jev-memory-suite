# ADR 0008 — migração do histórico da instalação original

Propósito: registrar por que o histórico é importado por inserção aditiva, e como a migração protege a fonte e o destino. Público: mantenedores e revisores de segurança. Data: 2026-10-22. Estado: aceito.

## Contexto

A instalação original do AI Memory, fora da suíte, guarda o histórico de vários projetos: no inventário de 2026-10-22 havia 2 workspaces, 12 projetos, 33 sessões, 3213 observações, 21 páginas e 18 handoffs. O perfil da suíte começava vazio. Além disso, a instalação original tinha 1202 eventos de hook ainda não drenados no spool. Os IDs das duas bases não colidiam, mas os nomes de alguns workspaces e projetos colidiam.

## Decisão

Um comando próprio, `jev-memory [--profile p] migrate-history --from <dataDir> [--apply]`, implementado em `src/migrate.ts` e nos módulos `src/migrate-*.ts`. As regras são:

- **Somente inserção.** O migrador executa apenas `INSERT`. Não há `UPDATE` nem `DELETE` nas tabelas do destino.
- **IDs e timestamps preservados.** Cada linha copiada mantém o ID e os timestamps da origem. Workspaces e projetos são mapeados para o destino por nome natural (`workspaces.name`, e `projects` por `workspace_id` + `name`). Quando há identidade de projeto, ela também é checada.
- **Conflitos são reportados, não importados.** Um conflito ocorre quando o mesmo ID já existe com conteúdo diferente, quando um pai não foi migrado, ou quando a regra de inserção falha (por exemplo, caminho `latest` de página já presente no projeto, ou identidade de projeto já usada por outro projeto). A linha conflitante fica na fonte e no relatório.
- **Uma transação.** Todas as inserções ocorrem numa única transação `BEGIN IMMEDIATE`, com `defer_foreign_keys` e `PRAGMA foreign_key_check` antes do `COMMIT`. Violação de chave estrangeira aborta e não grava nada.
- **Backup antes de gravar.** Com `--apply`, o destino é copiado por `VACUUM INTO` para `.local/backups/migration-<ts>/memory.sqlite`, com `SHA256SUMS`.
- **Dry-run no mesmo caminho.** Sem `--apply`, o migrador percorre o mesmo código sobre uma cópia do destino e descarta o resultado. O destino real não é aberto para escrita.
- **Apply exige suíte parada.** O `--apply` recusa a execução se o perfil estiver em execução ou se a porta da memória aceitar conexão.
- **Fonte somente leitura.** A fonte é copiada para uma área temporária antes da leitura. O manifesto de sha256 do banco, do WAL e da wiki é calculado antes e depois. Se mudar, o status é `failed`.
- **Wiki sem sobrescrita.** Arquivos da wiki são criados com criação exclusiva. Um arquivo existente com conteúdo diferente vira conflito. `.git` e links simbólicos não são copiados, e os caminhos são confinados à wiki do destino.
- **SQL sem valores concatenados.** Os valores vão como parâmetros. Os nomes de tabela e coluna vêm de uma lista fixa (`MIGRATED_TABLES`) e são citados como identificadores.
- **Spool fora do comando.** O comando não lê o spool. O spool da instalação original é drenado antes, numa cópia isolada, com o motor da suíte em loopback e sem embeddings, backfill nem manutenção. A instalação original não é alterada nessa etapa.

Tabelas que não são copiadas, como `users`, credenciais, sessões web, auditoria, estado operacional e embeddings, aparecem no relatório com o motivo. Os embeddings são regenerados pelo backfill local do destino ([ADR 0007](0007-local-semantic-memory.md)).

## Alternativas rejeitadas

- **`restore` do upstream.** Sobrescreve o diretório de dados inteiro, o que apagaria o estado já existente no perfil. Ver [backup e recuperação](../../runbooks/backup-and-recovery.md).
- **`reindex` do upstream.** Reconstrói os índices a partir da wiki. Segundo a própria ajuda do comando, ele perde o estado que existe somente no banco, e não traz o histórico de sessões e observações de outra base.
- **Copiar o banco da origem sobre o destino.** Substituiria o estado da suíte e exigiria que ela fosse o único store. Não resolve conflitos de nome nem de ID.

## Consequências

- Usuários, credenciais e sessões web da origem não chegam à suíte. Páginas e feedback que referenciam um usuário ausente no destino viram conflito.
- Uma sessão capturada nas duas bases, com conteúdo diferente, mantém a versão da suíte. A decisão é do operador, com base no relatório.
- Handoffs abertos importados podem ser oferecidos ao próximo `SessionStart` do projeto. Eles são de uso único e podem ser cancelados.
- Dados da origem passam a existir no store do perfil `default`. Perfis de projetos externos não os enxergam sem escopo explícito. Ver [guia de migração](../../guides/migration.md).

## Validação

- `test/migrate.test.ts` (12 casos, com fixtures criadas pelo motor real) cobre: dry-run sem escrita, apply com IDs e timestamps preservados, backup com `SHA256SUMS`, conflito por sessão e página `latest`, wiki sem sobrescrita, idempotência, fonte inalterada, esquemas incompatíveis, recusa com suíte ativa, rollback em violação de chave estrangeira e fonte nunca escrita.
- Aplicação real registrada em `.local/evidence/migration-2026-10-22T15-19-42-350Z-apply.json`, com integridade ok, zero violações de chave estrangeira, contagens conferidas e reexecução com zero inserções. Detalhes em [progress.md](../../../progress.md), Fase 4.
