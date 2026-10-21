# ADR 0003 — registro transacional nos clientes

Propósito: registrar como MCP e hooks são adicionados aos arquivos de clientes sem perder entradas alheias. Público: mantenedores. Data: 2026-10-21. Estado: aceito.

## Contexto

Para registrar a suíte, é preciso alterar arquivos que o usuário já possui: `.mcp.json`, `.claude/settings.local.json`, `.codex/config.toml` e `.codex/hooks.json`. Eles podem conter outros servidores MCP e outros hooks. Um erro de escrita pode quebrar o cliente inteiro.

## Decisão

- **Preflight** antes de qualquer escrita: parse dos arquivos, leitura do manifesto de propriedade `.jev-memory-<host>.json`, verificação de adulteração (digest SHA-256 das entradas próprias) e recusa se o nome `jev_memory_suite` já existir sem manifesto.
- O marcador `.ai-memory.toml` existente precisa ser idêntico ao esperado; caso contrário a operação para.
- **Idempotência.** Se nada mudaria, nenhuma escrita ocorre e o resultado traz `changed: []`.
- **Backup** antes de aplicar, em `<workspace>/.local/client-backups/<timestamp>-<host>/`, com `backup.json`.
- **Escrita atômica** por arquivo (temporário com `wx` e rename). O manifesto é gravado por último.
- **Rollback** em falha: os arquivos já escritos são revertidos em ordem inversa, restaurando o conteúdo anterior ou removendo o que foi criado.
- **Remoção** apaga apenas entradas próprias. O marcador `.ai-memory.toml` só sai com o último registro e somente se não tiver sido alterado.
- Entradas de outros perfis são recusadas, não sobrescritas.

## Consequências

- Há uma janela TOCTOU entre o preflight e a escrita, porque não existe bloqueio de arquivo entre processos. A detecção por digest em `check` e os backups reduzem o risco, mas não o eliminam.
- Se o rollback também falhar, o erro informa que é preciso restaurar a partir do diretório de backup.
- Os diretórios de backup não são removidos automaticamente.
- O gerenciador não cria confiança nativa. Claude pede aprovação do MCP do projeto; Codex exige revisão de `/hooks`; hooks não confiáveis ou alterados são ignorados em silêncio. Por isso a integração só é considerada válida após validação dentro de cada cliente (veja [ADR 0005](0005-validation-evidence-policy.md)).
- O formato de `.mcp.json`, `.codex/config.toml`, do manifesto e do `backup.json` está em [arquivos gerenciados](../../api/managed-files.md).
