# ADR 0002 — instalações versionadas dos motores

Propósito: registrar por que cada versão de motor fica em diretório próprio, com ponteiro atômico e sem remoção automática. Público: mantenedores. Data: 2026-10-21. Estado: aceito.

## Contexto

Os motores são compilados a partir de árvores Git fixadas em `upstream/`. No Windows, um executável em uso não pode ser substituído com segurança. Um build interrompido não pode deixar a versão servida incompleta. Também é preciso poder voltar a uma versão anterior.

## Decisão

- Cada versão fica em `.local/engines/<motor>/<árvore>/`, em que `<árvore>` é o tree id de `upstream/<motor>` (`git rev-parse HEAD:<prefixo>`).
- O build recusa fontes modificadas (`git status --porcelain` no prefixo), para que a árvore corresponda a um commit.
- O AI Memory é compilado com `cargo +stable build --locked --bin ai-memory` e `--target-dir .local/cargo-target`. O binário é copiado para o diretório da árvore com `COPYFILE_EXCL`. Se o binário já existir, não é sobrescrito.
- O Jev Gateway é copiado sem `node_modules`, `dist` e `.env`, e compilado no próprio diretório com `pnpm install --frozen-lockfile --ignore-scripts` e `tsc -p tsconfig.build.json`. O marcador `.jev-suite-complete` é gravado por último.
- Um build incompleto é removido e refeito. Se o ponteiro atual já referencia esse diretório, a instalação falha e exige reparo manual.
- `.local/engines/current.json` aponta a versão ativa. A atualização é atômica (arquivo temporário e rename) e troca apenas a chave do motor instalado.
- Versões antigas não são apagadas, porque um processo em execução pode usá-las.

## Consequências

- O espaço em disco cresce a cada versão nova. A limpeza é manual, depois de confirmar que nenhum processo usa a versão.
- O rollback é apontar `current.json` para uma versão completa anterior, com o serviço parado.
- Só são servidas versões compiladas a partir de commits fixados. O binário de release não é usado, porque a tag v3.1.2 do AI Memory aponta para outro commit.
- Arquivos planos deixados pela primeira instalação em `.local/engines/jev-gateway/` são obsoletos. Podem ser removidos manualmente depois de confirmar que nenhum processo os usa.
- O Windows ignora modos POSIX. A proteção desses diretórios depende das ACLs do perfil do usuário.
