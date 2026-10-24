# Migração do histórico

Propósito: descrever o procedimento completo para trazer o histórico da instalação original do AI Memory para o perfil da suíte, com backups, simulação, aplicação, verificação, leitura do relatório e rollback. Público: operadores. Data: 2026-10-22.

A migração copia sessões, observações, páginas, handoffs, projetos e arquivos de wiki da instalação original para o perfil `default` da suíte. Não altera a instalação original, não sobrescreve nada no destino e pode ser repetida sem duplicar dados. As regras de projeto estão em [ADR 0008](../architecture/adr/0008-history-migration.md).

Os caminhos abaixo usam:

- `%LOCALAPPDATA%\ai-memory`: diretório de dados da instalação original (somente leitura para a suíte).
- `.local/`: área local da suíte, ignorada pelo Git.
- `<binário>`: o `ai-memory.exe` apontado por `memory.binary` em `.local/engines/current.json`.

Execute os comandos da raiz do repositório.

> **Atenção.** Os backups, o staging e o relatório contêm memória pessoal e cópias de tokens locais. Trate todos como segredo e apague o staging ao final (etapa 9).

## Antes de começar

- A instalação original precisa estar **parada**: nenhum processo `ai-memory` dela pode gravar durante a cópia.
- A suíte precisa estar **parada** antes do `--apply` (etapa 5). O dry-run não exige isso.
- Confirme que o diretório `.local/profiles/default/memory/db/memory.sqlite` existe. Se o perfil ainda não foi inicializado, rode `node bin/jev-memory.mjs init` e `start` antes.

## 1. Backups

**a. Cópia bruta da instalação original.** Com a instalação original parada, copie `%LOCALAPPDATA%\ai-memory` inteiro para `.local/backups/2026-10-22-gaps/raw-original/`, por exemplo com `Copy-Item -Recurse`. Confira o hash do banco:

```powershell
Get-FileHash -Algorithm SHA256 .local\backups\2026-10-22-gaps\raw-original\db\memory.sqlite
```

Guarde o valor junto com a cópia. Ele serve para provar que a fonte não foi alterada depois.

**b. Backup da suíte.** Com o perfil em execução, use o servidor do perfil para gerar um tarball. A porta é `memory.port` do perfil, `49375` no padrão:

```bash
AI_MEMORY_SERVER_URL=http://127.0.0.1:49375 <binário> --data-dir .local/profiles/default/memory backup --to .local/backups/2026-10-22-gaps/suite-default.tar.gz
```

O arquivo de destino fica dentro de `.local/`. Veja também [backup e recuperação](../runbooks/backup-and-recovery.md).

## 2. Drenar o spool da instalação original em cópia isolada

A instalação original pode ter eventos de hook ainda não enviados. Eles ficam em `hook-spool` dentro do diretório de dados original. A drenagem é feita numa **cópia**, para não tocar na instalação original.

1. Copie o spool para um snapshot antes de qualquer processamento:

   ```powershell
   Copy-Item -Recurse "$env:LOCALAPPDATA\ai-memory\hook-spool" .local\backups\2026-10-22-gaps\spool-snapshot
   ```

2. Crie o staging como cópia do diretório de dados original:

   ```powershell
   Copy-Item -Recurse "$env:LOCALAPPDATA\ai-memory" .local\tmp\migration-staging
   ```

3. Suba um motor de teste sobre o staging, em loopback, com embeddings, backfill e manutenção desligados. Use o mesmo `<binário>` da etapa 1, em outro terminal:

   ```bash
   AI_MEMORY_EMBEDDING_PROVIDER=none AI_MEMORY_BACKFILL_ON_START=false AI_MEMORY_MAINTENANCE__ENABLED=false \
     <binário> --data-dir .local/tmp/migration-staging serve --transport http --bind 127.0.0.1:49374
   ```

   Sem `--workspace`/`--project`: o staging mantém os escopos gravados em cada evento do spool. Foi assim que a validação de 2026-10-22 executou.

4. Drene o spool. O `recover` usa o `bind` do `config.toml` copiado (127.0.0.1:49374), que é o endereço gravado nas entradas do spool:

   ```bash
   <binário> --data-dir .local/tmp/migration-staging recover --json
   ```

   O relatório mostra quantos eventos foram enviados (`sent`) e quantos foram descartados pelo próprio motor (`dropped`). Na validação de 2026-10-22, 1200 foram enviados e 2 descartados, de 1202.

5. Encerre o servidor de teste que você iniciou no passo 3.

Ao final, o staging contém o histórico da instalação original mais os eventos drenados. Essa é a fonte da migração.

## 3. Simulação (dry-run)

```bash
node bin/jev-memory.mjs migrate-history --from .local/tmp/migration-staging
```

O dry-run segue o mesmo caminho do `--apply`, mas sobre uma cópia do destino, e descarta o resultado. Nada é gravado no perfil, na wiki ou no banco da suíte. O relatório JSON sai no terminal e é salvo em `.local/evidence/migration-<ts>-dryrun.json`.

Antes de seguir, confira no relatório:

- `status: "ok"`, `validation.ok: true` e `source.unchanged: true`;
- `tables` com os números esperados e `conflict` explicado (veja [como ler o relatório](#como-ler-o-relatório));
- `wiki.wouldCreate` com a lista de arquivos a criar.

Se `status` for `failed`, o comando sai com código 1. Leia `error` antes de continuar.

## 4. Parar a suíte

```bash
node bin/jev-memory.mjs stop
node bin/jev-memory.mjs status
```

`status` deve responder `{"phase":"stopped"}`. O `--apply` recusa a execução com `pare a suíte: jev-memory stop` se o perfil ainda estiver em execução ou se a porta da memória responder.

## 5. Aplicar

```bash
node bin/jev-memory.mjs migrate-history --from .local/tmp/migration-staging --apply
```

Antes de gravar, o comando:

1. Copia o banco do destino com `VACUUM INTO` para `.local/backups/migration-<ts>/memory.sqlite` e grava `SHA256SUMS` ao lado.
2. Abre uma transação única e insere as linhas. Se alguma chave estrangeira falhar, faz rollback e nada é gravado.
3. Valida o destino (integridade, chaves estrangeiras, contagens, páginas e índice FTS).
4. Só então copia a wiki, sem sobrescrever nada.

O relatório vai para `.local/evidence/migration-<ts>-apply.json`. Guarde o caminho: ele é a referência para o rollback.

## 6. Reexecução

Rodar o `--apply` de novo é seguro. Na segunda execução, `inserted` deve ser zero em todas as tabelas e `wiki.created` deve estar vazio. Tudo o que já existia aparece como `alreadyPresent`. Isso confirma que a migração é idempotente.

## 7. Iniciar e indexar

```bash
node bin/jev-memory.mjs start
node bin/jev-memory.mjs doctor
```

Ao iniciar, o motor gera vetores para as páginas importadas que ainda não os têm. No log `.local/profiles/default/logs/memory.log`, procure a linha:

```text
startup embedding backfill completed ... embedded=N failed=0
```

`failed=0` é o resultado esperado. Na validação, 33 de 33 páginas `latest` ficaram com vetor. Veja [configuração](configuration.md) para o modelo de embeddings.

## 8. Verificação

1. **Estado do perfil.** `node bin/jev-memory.mjs mcp` deve mostrar `handshake: true` e um `memory_status` com o escopo do perfil.
2. **Escopo explícito.** Pelo cliente, chame `memory_status` com `workspace` e `project` informados, por exemplo `jev-suite` e `jev-memory-suite`. Os contadores devem incluir as sessões importadas.
3. **Busca.** Faça uma `memory_query` com um termo de uma página importada. Um resultado que só aparece pelo vetor, com um termo ausente das páginas, confirma a busca semântica.
4. **Busca global.** Use `memory_query` com `global=true` e sem argumentos de projeto. Sessões importadas devem aparecer com o timestamp original, não com a data da migração.
5. **Integridade.** No relatório de apply, `validation.integrity` deve ser `ok`, `validation.foreignKeyViolations` deve ser `0` e `validation.pages.mismatches` deve ser `0`.

## Migração por projeto

Use a forma com escopo quando o histórico a trazer pertence a um único projeto. Assim o restante da instalação original não entra no perfil.

```bash
node bin/jev-memory.mjs migrate-history --from <snapshot-da-origem> --project <workspace-origem>/<projeto-origem> --as <workspace-destino>/<projeto-destino>
```

Regras do modo com escopo:

- `--project <workspace>/<projeto>` copia só esse escopo de origem: sessões, observações, páginas, handoffs e o diretório de wiki desse projeto. Os arquivos da raiz da wiki do workspace de origem nunca são copiados.
- `--as <workspace>/<projeto>` escolhe o projeto de destino. Sem `--as`, o destino tem o mesmo nome da origem. `--as` exige `--project`.
- O escopo de destino precisa existir no perfil. Abra uma sessão no projeto antes de migrar. O modo com escopo não cria linhas de workspaces nem de projetos.
- Sem `--project` e `--as`, o comportamento é o mesmo descrito nas etapas acima.
- Guarda de handoffs (vale nos dois modos): handoffs cujo `cwd` esteja fora da raiz do projeto do perfil de destino (`projectRoot` ou, no perfil `default`, a raiz da suíte) não são inseridos. A quantidade aparece em `excluded.handoffsOutsideProject` do relatório, que também traz o campo `scope`.
- As garantias são as mesmas: dry-run por padrão, `--apply` só com a suíte parada, backup com `VACUUM INTO`, transação única, verificação de chaves estrangeiras, validação, somente inserção e reexecução idempotente.
- Fonte de um store em uso: use um snapshot consistente do banco (backup online do SQLite) mais uma cópia de `wiki/`. Não aponte `--from` para o diretório vivo.

Caso típico, como o do Farol: o histórico de um projeto está num escopo do store `default` e precisa estar no perfil do próprio projeto. Primeiro simule; depois pare o perfil do projeto, aplique e reinicie:

```bash
node bin/jev-memory.mjs --profile <perfil-do-projeto> migrate-history --from <snapshot> --project default/<projeto-origem> --as jev-suite/<projeto-destino>
node bin/jev-memory.mjs --profile <perfil-do-projeto> migrate-history --from <snapshot> --project default/<projeto-origem> --as jev-suite/<projeto-destino> --apply
```

A reexecução do mesmo comando deve inserir zero linhas.

## Como ler o relatório

Campos principais do JSON:

| Campo | Significado |
|---|---|
| `mode`, `status`, `error` | `apply` ou `dry-run`; `ok` ou `failed`; mensagem da falha, se houver |
| `source.unchanged` | `true` quando o manifesto de sha256 da fonte é igual antes e depois |
| `destination.backup` | Arquivo e `SHA256SUMS` do backup feito antes do apply |
| `tables.<tabela>` | `source` (linhas na fonte), `inserted`, `alreadyPresent`, `conflict` e a lista `conflicts` |
| `notMigrated` | Tabelas que não são copiadas, com o motivo |
| `validation` | Integridade, chaves estrangeiras, contagens esperadas, páginas e FTS |
| `wiki` | `created`, `wouldCreate` (dry-run), `alreadyPresent`, `conflicts` e `skipped` |
| `scope` | Seleção de projeto da migração com escopo (`--project` e `--as`); `null` quando a migração é completa |
| `excluded.handoffsOutsideProject` | Handoffs não inseridos porque o `cwd` está fora da raiz do projeto de destino |
| `rollback` | Passos para desfazer, já preenchidos com os caminhos desta execução |

Significado de `inserted`, `alreadyPresent` e `conflict`:

- **inserted**: a linha foi gravada no destino com o ID original.
- **alreadyPresent**: a mesma linha já existe no destino, com o mesmo conteúdo. Nada é feito.
- **conflict**: a linha não foi importada. O motivo aparece em `conflicts[].reason`.

Motivos de conflito que aparecem no relatório:

| Motivo | Quando ocorre |
|---|---|
| `same id, different content` | O mesmo ID existe no destino com conteúdo diferente |
| `parent not migrated (<tabela> via <coluna>)` | O pai da linha não foi migrado, por exemplo uma sessão cujo workspace ou projeto ficou em conflito |
| `latest path already present in destination for this project` | Já existe página `latest` com o mesmo caminho no projeto |
| `identity already used by another project in destination` | Outro projeto do destino já usa a mesma identidade |
| `missing required reference <coluna>` | A linha não tem uma referência obrigatória |

Na wiki, `conflicts` traz arquivos que já existem no destino com conteúdo diferente (`arquivo existente diferente; não sobrescrito`). Esses arquivos ficam como estão.

## Conflitos esperados

Na aplicação de 2026-10-22, o relatório apontou:

- **8 sessões capturadas nas duas bases** (com 491 observações, 5 páginas e 5 handoffs ligados a elas). Essas sessões já existiam na suíte com conteúdo diferente, então a versão da suíte foi mantida e a da origem ficou fora. Os dados originais continuam na fonte e no backup.
- **6 arquivos de wiki já existentes com conteúdo diferente**, como o ledger `log-2026-10.md` e páginas dessas mesmas sessões.

Conflitos semelhantes são esperados sempre que a mesma sessão foi capturada nas duas instalações. Não force a importação: a decisão de manter a versão da suíte já está registrada no procedimento.

## Handoffs abertos

Os handoffs abertos da instalação original são importados como abertos. Eles podem ser oferecidos ao próximo `SessionStart` do projeto correspondente e são de uso único. Na validação, 3 foram importados para `jev-suite/jev-memory-suite` e 1 para o escopo do Farol no store do perfil `default`. A reconciliação de 2026-10-22 levou o histórico do Farol também para o perfil do Farol (veja [reconciliação](#reconciliação-aplicada-em-2026-10-22)).

Para listar os handoffs abertos do escopo:

```bash
<binário> --data-dir .local/profiles/default/memory handoffs --workspace jev-suite --project jev-memory-suite --json
```

Para cancelar um handoff específico, use a ferramenta MCP `memory_handoff_cancel` com o identificador da listagem. O comando `handoffs --expire-all --confirm` expira **todos** os handoffs abertos do escopo; `--older-than-days` limita a operação aos mais antigos. Use com cuidado.

## Reconciliação aplicada em 2026-10-22

Registro da correção aplicada ao histórico já migrado. Os backups foram feitos antes de qualquer alteração.

**Backups.** `.local/backups/m2-2026-10-22T16-41-52Z/` contém backups online do SQLite dos stores `default` e do Farol (ambos com `integrity_check = ok`), backups nativos do `ai-memory backup`, o tarball da wiki do `default` e `SHA256SUMS`.

**Projeto jev-memory-suite.** O store `default` tinha o projeto em dois escopos:

- `default/jev-memory-suite`: 18 sessões, 1734 observações, 12 páginas e 10 handoffs. Veio da instalação original, que derivou o workspace `default`.
- `jev-suite/jev-memory-suite`: 20 sessões, 1599 observações, 16 páginas e 15 handoffs.

Os dois escopos foram reunidos pelo comando do próprio motor, depois de uma simulação (18/18 sessões):

```bash
AI_MEMORY_SERVER_URL=http://127.0.0.1:49375 <binário> move-session --from-project jev-memory-suite --from-workspace default --to jev-memory-suite --to-workspace jev-suite --force --confirm
```

`--force` só foi necessário porque as sessões históricas da instalação original nunca registraram `SessionEnd`. Nenhum writer ativo usa esse escopo.

Resultado: `jev-suite/jev-memory-suite` com 38 sessões, 28 páginas, 25 handoffs e 3344 observações (1599 + 1734, mais 11 capturadas ao vivo durante a execução). Os totais do store foram preservados: 56 sessões, 39 páginas e 35 handoffs. Integridade ok; checkpoint do motor `c97da6dd`.

Limitação: o motor deixou as 1794 `ingest_keys` (chaves de deduplicação) no id antigo do projeto. Elas não guardam conteúdo.

**Projeto Farol.** O histórico estava dividido no store `default` em dois escopos:

- `default/jebadevv-thenoblehub`: 5 sessões, 847 observações, 3 páginas e 3 handoffs. A instalação original derivou o nome do remote Git.
- `jev-suite/p-farol-platform-b9b5f26bfe6b2ceb49cb`: 4 sessões, 1008 observações, 1 página e 1 handoff.

O store do perfil do Farol (`project-b9b5f26bfe6b2ceb49cb`) tinha só 5 sessões e 12 observações. Foram aplicadas duas migrações com escopo, a partir de um snapshot consistente (`.local/tmp/m2-farol-source`), com o perfil do Farol parado durante o apply e reiniciado depois:

1. `--project jev-suite/p-farol-platform-b9b5f26bfe6b2ceb49cb`: inseriu 2 sessões, 1005 observações, 1 página, 1 handoff e 1008 `ingest_keys`. Duas sessões já existiam com conteúdo diferente e a versão da suíte foi mantida; 3 observações dessas sessões não foram importadas. Dois arquivos de wiki com conteúdo diferente não foram sobrescritos.
2. `--project default/jebadevv-thenoblehub --as jev-suite/p-farol-platform-b9b5f26bfe6b2ceb49cb`: inseriu 5 sessões, 847 observações, 3 páginas e 3 handoffs.

As duas validaram ok, a fonte não mudou e nenhum handoff foi excluído pela guarda. Reexecutar as duas inseriu zero linhas. Depois, o store do Farol tem 12 sessões, 1864 observações, 4 páginas e 4 handoffs, com integridade ok. Backups de rollback: `.local/backups/migration-2026-10-22T16-47-37-641Z/` e `.local/backups/migration-2026-10-22T16-47-38-323Z/`. Pelo MCP do Farol, `memory_status` retorna 12 sessões, 1864 observações e 4 páginas, e `memory_recent` lista as páginas migradas.

O store `default` continua com suas cópias dos escopos do Farol. Nada foi apagado; a remoção exige aprovação explícita.

**Auditoria e handoffs.** `ai-memory audit-contamination` retornou 0 achados nos stores `default` e do Farol depois da reconciliação. Continuam abertos 2 handoffs no store do Farol e 12 no store `default`; vários foram criados pela validação sintética G2 às 15:06 UTC. O motor só entrega um handoff automático a uma sessão cujo `cwd` seja o `cwd` gravado ou um descendente dele. Nenhum foi expirado, porque alterar estado de dado do usuário exige aprovação. Para expirar os de um escopo, depois de revisar a lista:

```bash
<binário> --data-dir <perfil>/memory handoffs --workspace <workspace> --project <projeto> --expire-all [--older-than-days N] --confirm
```

## Pontos de atenção

- **Dados do Farol.** Na primeira aplicação, os dados do projeto `farol` ficaram no store do perfil `default`, e o perfil do próprio projeto não os enxergava. A [reconciliação de 2026-10-22](#reconciliação-aplicada-em-2026-10-22) trouxe esse histórico para o perfil do Farol por migração com escopo. As cópias no store `default` continuam lá. Para outros projetos, use a [migração por projeto](#migração-por-projeto) ou acesse o escopo pelo perfil `default`, com escopo explícito ou global.
- **Processos do Claude antigos.** Um processo do Claude iniciado antes da remoção dos hooks da instalação original pode continuar enviando eventos para `127.0.0.1:49374`. Feche e reabra essa sessão. Ver [solução de problemas](troubleshooting.md).
- **Escopo do estado.** A migração não copia usuários, credenciais, sessões web nem o estado operacional. A lista completa está no bloco `notMigrated` do relatório.

## Rollback

Só é necessário se o apply já foi feito. Um dry-run não gravou nada no destino.

1. Pare a suíte: `node bin/jev-memory.mjs stop`.
2. Confira o hash do backup em `.local/backups/migration-<ts>/SHA256SUMS`:

   ```powershell
   Get-FileHash -Algorithm SHA256 .local\backups\migration-<ts>\memory.sqlite
   ```

3. Restaure o banco: copie `.local/backups/migration-<ts>/memory.sqlite` para `.local/profiles/default/memory/db/memory.sqlite`.
4. Remova `memory.sqlite-wal` e `memory.sqlite-shm` do mesmo diretório `db/`, se existirem.
5. Apague os arquivos de wiki criados pela migração. A lista está em `wiki.created` do relatório de apply, com caminhos relativos a `.local/profiles/default/memory/wiki`. Apague só esses arquivos.
6. Inicie a suíte: `node bin/jev-memory.mjs start`.

O procedimento geral de restauração está em [backup e recuperação](../runbooks/backup-and-recovery.md#rollback-da-migração).

## 9. Limpeza

Depois de validar e confirmar o rollback não é necessário, apague o staging. Ele contém uma cópia dos tokens locais da instalação original:

```powershell
Remove-Item -Recurse -Force .local\tmp\migration-staging
```

As cópias brutas e os backups em `.local/backups/` também contêm credenciais locais. Mantenha-os apenas pelo tempo necessário e apague-os quando não forem mais úteis. Eliminação de dados pessoais também é tratada em [LGPD](../security/lgpd.md).
