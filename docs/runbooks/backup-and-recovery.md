# Backup e recuperação

Propósito: descrever como copiar e restaurar a memória do perfil, como reverter a migração do histórico, e como reverter registros de clientes e versões de motores. Público: operadores. Data: 2026-10-22.

Regra geral: pare o perfil antes de restaurar ou de substituir arquivos. Faça um backup antes de qualquer operação destrutiva.

## Backup online

Cria um tarball gzip com um snapshot consistente do SQLite e a árvore do wiki. Pode ser executado com o perfil em uso.

```text
<binário>  --data-dir .local/profiles/<perfil>/memory  backup --to <arquivo.tar.gz dentro de .local>
```

`<binário>` é o `ai-memory.exe` apontado por `.local/engines/current.json` (`memory.binary`). O arquivo de destino deve ficar dentro de `.local/`, em um diretório fora do alcance do Git (por exemplo `.local/client-backups/` ou um subdiretório dedicado).

Conteúdo, segundo a documentação do upstream:

- Wiki (`wiki/`).
- Snapshot do SQLite (feito por `sqlite3 .backup`).
- `config.toml`.

Não inclui arquivos de credencial, `raw/`, logs nem modelos. Restaure a credencial separadamente, se necessário.

## Cópia offline

Alternativa mais simples e completa:

1. `stop` no perfil.
2. Copie o diretório `.local/profiles/<perfil>/` inteiro para um local dentro de `.local/`.

Essa cópia inclui `control-token` e `auth-tokens`. Trate-a como segredo: não a envie por canais não seguros.

## Restauração da memória

O upstream oferece `restore --from <arquivo.tar.gz>`. Essa operação **sobrescreve o diretório de dados**.

- Pare o perfil primeiro. O `restore` recusa se houver outro processo `ai-memory` ativo.
- O upstream valida e prepara o arquivo antes de trocar os dados. Uma falha deixa `wiki/` e `db/` como estavam.
- Antes de restaurar, faça um backup do estado atual.
- O procedimento completo e as opções estão em `upstream/ai-memory/docs/lifecycle-ops.md`. Leia-o antes de usar. Não execute `restore` com `--force` sem entender o efeito.

## Rollback da migração

Antes de aplicar a migração, o comando `migrate-history --apply` cria um backup do destino em `.local/backups/migration-<ts>/`, com `memory.sqlite` e `SHA256SUMS`. O relatório do apply (`.local/evidence/migration-<ts>-apply.json`) registra o caminho do backup e a lista `wiki.created`.

Para desfazer uma aplicação:

1. Pare a suíte: `node bin/jev-memory.mjs stop`. A restauração não deve acontecer com o perfil em uso.
2. Confira o hash do backup com `SHA256SUMS`, por exemplo com `Get-FileHash -Algorithm SHA256`.
3. Copie `.local/backups/migration-<ts>/memory.sqlite` para `.local/profiles/<perfil>/memory/db/memory.sqlite`, substituindo o arquivo atual.
4. Remova `memory.sqlite-wal` e `memory.sqlite-shm` do mesmo diretório `db/`, se existirem. Um WAL ou SHM remanescente não corresponde ao banco restaurado.
5. Apague os arquivos de wiki listados em `wiki.created` do relatório, com caminhos relativos a `.local/profiles/<perfil>/memory/wiki`. Apague só esses arquivos.
6. Inicie a suíte: `node bin/jev-memory.mjs start`, e confira com `doctor`.

O backup do destino cobre só o banco (`memory.sqlite`), não a wiki. Por isso a remoção dos arquivos de wiki depende exclusivamente da lista `wiki.created` do relatório. Arquivos de wiki que já existiam antes da migração não foram tocados e não devem ser apagados.

Se o relatório não existir ou não tiver `wiki.created`, restaure só o banco e não apague arquivos da wiki por suposição. Arquivos de wiki novos vindos da migração podem permanecer no disco até serem removidos manualmente, com conferência caso a caso.

Procedimento completo, com a leitura do relatório: [migração do histórico](../guides/migration.md#rollback).

## Reversão de registro de cliente

Cada registro cria um diretório `<workspace>/.local/client-backups/<timestamp>-<host>/` com `backup.json` e `file-<n>.bak`. Para reverter manualmente:

1. Feche o cliente que usa a configuração.
2. Leia `backup.json`. Para cada item de `files`:
   - Se `existed` for `true`, copie `backup` (`file-<n>.bak`) de volta para `path`, substituindo o arquivo atual.
   - Se `existed` for `false`, remova o arquivo em `path`.
3. Confira `clients check <host> <dir>`. Depois de reverter, ele deve indicar que não há registro próprio.

Formato do `backup.json`: [arquivos gerenciados](../api/managed-files.md#backups-de-registro).

Se `remove` for usado em vez de restauração, ele mantém entradas de outros MCPs e hooks. Prefira `remove` quando a intenção é só desregistrar a suíte.

## Reversão de versão de motor

Versões antigas ficam em `.local/engines/<motor>/<árvore>/`.

1. `stop` no perfil.
2. Abra `.local/engines/current.json` e troque o `tree` e o caminho (`binary` ou `dir`) para uma versão anterior que tenha sido completa. Para o Gateway, confirme que `.jev-suite-complete` existe com o mesmo tree e que `dist/index.js` existe. Para a memória, confirme que o `ai-memory.exe` existe.
3. Confirme que os caminhos ficam dentro de `.local/engines/`. O gerenciador recusa caminhos fora dele.
4. `start` e `doctor`.

Não apague a versão revertida nem a atual sem confirmar que nenhum processo as usa.

## Verificação após recuperação

- `status` com `phase: "ready"`.
- `mcp` com `handshake: true`.
- Uma consulta conhecida na memória retorna o resultado esperado.
- Para clientes, `clients check` e a validação do cliente conforme o [guia de clientes](../guides/clients.md).

## Limites

- Não há backup automático nem agendado pela suíte.
- Não há validação automática dos backups. Teste a restauração em um perfil separado antes de depender dela.
- A restauração não recupera credenciais que não estejam no tarball.
