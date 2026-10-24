# ADR 0016 — isolamento do home nos testes: home temporário e sentinelas

Propósito: registrar por que todos os testes da suíte e do Jev Gateway rodam com home temporário e com sentinelas no home real, qual incidente motivou a regra, quais alternativas foram rejeitadas e quais efeitos ela tem. Público: mantenedores e revisores de segurança. Data: 2026-10-24. Estado: aceito. Complementa a [ADR 0015](0015-jev-gateway-antigravity-code-assist.md), que registrou o incidente no patch do Jev (T53).

## Contexto

No Windows, o home do usuário vem de `USERPROFILE`, não de `HOME`. Um teste que define só `HOME` continua usando o home real. Isso permite que um teste grave em `~/.jev-gateway` ou em outros diretórios de estado dos clientes e serviços.

A auditoria de 2026-10-24 encontrou o seguinte:

- No Jev Gateway, só `test/setup.test.ts` vazava. Ele define só `HOME` e, no Windows, sobe um gateway e grava o `codex.pid` do home real.
- Na suíte, `npm test` era seguro. Mas `e2e.ts`, `headroom-e2e.ts` e `headroom-codex-e2e.ts` obtinham o `USERPROFILE` real por `baseEnv()`, e `projects-e2e.ts` usava `process.env` real. Todos podiam tocar o home real.

Incidente (T53, Tarefa A do Marco 1): o `setup.test.ts` do Jev subiu um gateway Codex de teste na porta 8999, com o código da cópia de trabalho, e sobrescreveu `~/.jev-gateway/codex.pid`. O processo de teste foi encerrado e o arquivo removido. O gateway Codex real (porta 8790) não estava rodando. Não dá para afirmar pelo log se o teste o teria derrubado.

## Decisão

1. **Jev Gateway (no patch 0.5.1).** `vitest.config.ts` e `test/isolate-home.setup.ts` dão a cada arquivo de teste um diretório temporário novo como home: `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` e `APPDATA`. O setup interrompe a execução se `os.homedir()` continuar no home real. A comparação usa impressão digital, para que nenhum caminho pessoal entre no repositório. `test/setup.test.ts` passa essas mesmas variáveis ao launcher que executa.
2. **Suíte.** `scripts/test-isolated.mjs` envolve todos os scripts `test:*`. Ele define `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` e `APPDATA` temporários. `LOCALAPPDATA` e `PATH` continuam reais. Antes da rodada há um preflight. Depois, o wrapper compara as sentinelas do home real com o estado inicial e aceita só o crescimento de `claude.log` e `agy.log`.
3. **`--real-uv-tools`.** Expõe só a árvore `%APPDATA%\uv\tools`, para leitura. Qualquer alteração nela é monitorada, e só `__pycache__` é aceito. `npm test` usa essa opção, porque sem ela três testes reais do shim do Headroom eram pulados.

## Alternativas rejeitadas

- **Confiar em cada teste para definir o próprio home.** Era o estado anterior. A auditoria mostrou quatro testes que não faziam isso. Um teste novo esquecido repetiria o problema, e o incidente aconteceu com a regra já conhecida.
- **Só documentar a regra.** Documentação não impede a escrita. O incidente de T53 ocorreu com o problema registrado no modelo de ameaças.

## Consequências

- **Falso positivo possível.** Se um cliente real (Claude ou Codex em uso) escrever nas sentinelas durante a rodada, o wrapper falha mesmo sem culpa de um teste. A falha exige verificar o que mudou antes de atribuir a causa a um teste.
- **Cobertura só pelos scripts `test:*`.** Uma execução direta, como `npx tsx --test` sobre um arquivo, não passa pelo wrapper e não tem a comparação de sentinelas.
- **`--real-uv-tools` expõe a árvore uv para leitura.** Sem essa opção, os testes reais do shim do Headroom são pulados. A exposição é restrita a essa árvore.
- **Sentinelas detectam, não impedem.** Um teste que escreva no home real é reprovado na rodada, mas a escrita já ocorreu.
- **No Jev, a proteção depende do patch.** Quem rodar o `upstream/` puro, sem a pasta de patch, não tem o isolamento.

## Segurança

Mitigação de [T53](../../security/threat-model.md). Residual: a suíte não impede escrita por código novo fora dos scripts `test:*`, e as sentinelas só mostram a alteração depois que ela ocorre. O processo de teste roda com a mesma conta e o mesmo nível de confiança do usuário (T1).

## Validação

Dados de 2026-10-24, Windows 10.

- **Teste negativo do wrapper:** um teste que gravava num `.jev-gateway` falso falhou com `changed .jev-gateway/codex.pid`.
- **Suíte:** `npm test` 560/560, sem skips, com 50.217 entradas sentinela inalteradas. `npm run test:e2e` 4/4 e `npm run test:projects` 1/1, pelo wrapper.
- **Jev com o patch:** 478 testes, 476 passam. As 2 falhas são pré-existentes do upstream no Windows (`opencode-coverage` ×1 e `setup` ×1, modo 0600 lido como 0666).

Registro: [progress.md](../../../progress.md), seção "Antigravity: estabilização, Marco 3 (2026-10-24)", e check `M-iso-1` em [tests.json](../../../tests.json).

## Acréscimo (2026-10-24): UV_TOOL_DIR e suítes omitidas

- **`UV_TOOL_DIR` no `baseEnv`.** `baseEnv()` (`src/local.ts`) passa a repassar `UV_TOOL_DIR`. Antes, o supervisor ignorava um `UV_TOOL_DIR` personalizado do usuário, também em produção. Sem essa variável, `test:codex-launch` falhava 2/12 com "Headroom python not found".
- **`--real-uv-tools` no `test:codex-launch`.** O wrapper não via o Python do Headroom, e o teste pulava a suíte inteira com 0 testes e exit 0. A opção foi acrescentada ao script em `package.json`. Como o exit 0 não prova que algum teste rodou, os contadores de testes de cada `test:*` devem ser conferidos, não só o código de saída.
- **Resultado:** `test:codex-launch` passa 12/12.
- **Origem da escrita em `~/.claude.json`.** O Claude Code grava backups rotativos em `~/.claude/backups/.claude.json.backup.<epoch-ms>` antes de cada escrita. Comparando só os caminhos de chave entre o último backup e o arquivo atual, nas duas mudanças (13:22:10 e 15:18:21), a única chave alterada foi `promptQueueUseCount`, o contador de prompts enfileirados pelo usuário enquanto a sessão trabalha. O arquivo não tem referência às pastas temporárias dos testes. A escrita vem da sessão interativa do Claude Code, não dos testes. Pendência do Marco 3 fechada.

Registro: [progress.md](../../../progress.md), seção "Antigravity: finalização da estabilização (2026-10-24)", e check `M-iso-2` em [tests.json](../../../tests.json).
