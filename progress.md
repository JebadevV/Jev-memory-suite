# Progresso

Proposito: acompanhar marcos verificaveis. Publico: mantenedores. Data: 2026-10-24.

## M0: passed

Executor, leitura/escrita, Git e propriedade.

## M1: passed

Estrutura e instrucoes.

## M2: passed

Importacao subtree, documentacao e proveniencia.

## M3: passed

Gerenciador, instalacao, configuracao e ciclo de vida.

## M4: passed

MCP, hooks e configuracoes reversiveis dos clientes.

## M5: passed

Quatro modos, captura, consulta, persistencia e roteamento.

## M6: partial

Checks upstream e validacao independente de cada cliente.

## M7: passed

Documentacao e revisao final de seguranca.

## Evidencias registradas

- M0-executor: passed. Correct workspace, read/write OK, existing Git main without commits, no ownership or sandbox error
- M1-scaffold: passed. All required files and documentation directories exist; test register parsed
- M2-subtrees: passed. Both imported trees exactly match their source commits; MIT licenses preserved; no submodules
- M3-1792601561819: passed. AI Memory fonte fixada compilada em 3m45s; Jev instalado e compilado localmente; 3 testes passaram, incluindo supervisor real, autenticacao e preservacao de listener externo. AI Memory iniciou autenticado em loopback. Teste inicial de listener travou e foi corrigido; nova execucao aprovada. Atualizacao subtree implementada, nao executada para manter commits fixados.
- M4-1792609191317: passed. Hook aceita raiz canonica e descendentes, rejeita escapes/junctions/payload invalido antes da config; schemas por evento, limites de stdin/stdout e profundidade; MCP limitado a 4 MB durante leitura; instalacao versionada imutavel (arvores c146869/0d15e05 iguais aos commits upstream) com ponteiro atomico, sem sobrescrever exe em uso; registro de clientes transacional com preflight, backup, rollback testado, propriedade por perfil e preservacao de MCPs/hooks; launch gera configuracao por perfil e recusa registro de outro perfil; testes de clientes independentes do perfil default. 42 testes passaram. Captura real e clientes reais ficam para M5/M6.
- M5-1792609613105: passed. A: supervisor 401 sem token, gateway 401 sem chave, rota 200 com x-jev-gateway-mode=forced/tool=get_synthetic_weather, upstream recebeu so a chave do upstream, Jev consultado; memoria fechada. B: MCP 401 sem bearer, handshake, 24 ferramentas, memory_status com escopo explicito, pagina sintetica escrita/consultada/lida, captura real via dist/src/hook.js + binario ai-memory recuperada, persistencia apos stop/start; gateway fechado. C: ambos prontos, rota e MCP ok. D: services {}, portas fechadas, MCP rejeitado, launch sem flags. LIMITACAO: Jev (mock-jev.mjs upstream) e provedor OpenAI simulados em loopback; nao comprova provedor real. Hooks acionados com payload sintetico; captura por cliente real fica em M6. Evidencias .local/evidence/e2e-*.json
- M6-1792610836049: partial. Claude Code CLI APROVADO: MCP conectado, 5 hooks reais exit 0, 7 observacoes capturadas, token recuperado, persistencia apos restart, recuperacao por nova sessao (2 defeitos do launch corrigidos). Codex CLI PARCIAL: MCP memory_status/memory_query reais e recuperacao cruzada da sessao do Claude; captura por hooks PENDENTE de confianca nativa (/hooks). Codex Desktop PENDENTE: exige uso no app. Upstream: gateway typecheck ok, vitest 397/400 (3 falhas Windows launcher/setup); AI Memory fmt ok, 956/957 (falha router mid_session_out_of_tree, causa provavel TEMP dentro do checkout, nao verificada). Evidencias .local/evidence/M6-*.
- M7-1792611197102: passed. Documentacao completa (arquitetura+Mermaid, ADRs 0002-0005, API, guias, seguranca, runbooks, README indice). Revisao OWASP Top 10/ASVS e LGPD documentada. Correcoes: smol-toml 1.9.1, pnpm 10.34.6, router-token separado do control-token (e2e prova 401 cruzados). Residuais: esbuild low (dev), hono moderate em serveStatic nao usado, paste sem manutencao, cargo deny e cargo test --workspace nao executados, modos 0600 sem efeito no Windows.

## Clientes

- claudeCli: passed
- codexCli: partial (MCP passed; hook capture pending native trust)
- codexDesktop: pending (requires validation inside the app)

## M6: complemento de projetos externos aprovado

Data: 2026-10-21. Launchers desacoplados da instalacao: cwd atual ou --dir, raiz Git/pasta e perfil base determinam memoria isolada, configuracao e quatro portas. Registro transacional aceita projetos externos; hooks validam fronteira e escopo em cada captura. CLI Codex local descoberto sem mudar PATH global. Preservados trabalho existente, motores upstream e arquivos do projeto externo.

Build/lint aprovados; 81 testes, 4 E2E de regressao e 1 E2E externo aprovados, sem skips. E2E externo executou --version dos CLIs reais por launch e por launchers upstream; testou MCP e captura sintetica com motor real, isolamento e persistencia apos restart. Gateway teve saude simulada; provedor real e captura interativa nao foram testados nesta rodada. M6 e estados dos clientes continuam com os limites anteriores.

Falha inicial da regressao (2/4) expôs fixture anterior ao dashboard ja existente no checkout; fixture recebeu porta independente e passou a exigir dashboard ready. Descoberta do executavel Codex e expectativa de rejeicao de sessao inexistente tambem foram corrigidas durante o teste externo. Evidencias e limites: .local/evidence/external-projects-validation.json e .local/evidence/external-projects-e2e.json. Procedimento: docs/guides/external-projects.md; decisao: ADR 0006.

## M6: comandos curtos no Windows

Data: 2026-10-21. Criados launchers .cmd para jev-memory, jev-memory-codex e jev-memory-claude, reutilizando os entrypoints existentes e preservando cwd. Ativador Node verifica conflitos e acrescenta somente bin ao PATH do usuario quando chamado com --persist, preservando entradas e tipo de registro, com backup local. A tentativa inicial de ativador .ps1 foi bloqueada pela politica local; o arquivo experimental foi removido e a implementacao Node nao altera essa politica.

Build/lint aprovados, teste focado de PATH aprovado e E2E externo aprovado incluindo resolucao dos dois nomes em PowerShell e --version dos CLIs reais. PATH restrito aos processos de teste; persistencia do PATH do usuario ainda depende de autorizacao. Evidencia: .local/evidence/short-commands-integration.log. Os gates de captura interativa e Desktop permanecem pendentes.

Ativacao dos comandos curtos (2026-10-21): autorizada e executada. Pasta bin adicionada ao PATH do usuario, preservacao exata de entradas/tipo verificada contra backup local e notificacao de ambiente confirmada. Novos terminais podem executar jev-memory-codex, jev-memory-claude e jev-memory. Evidencia: .local/evidence/short-commands-activation.json. M6 e gates de Desktop/hooks continuam com os limites registrados.

## Gaps G1-G3: restauracao de paridade com a instalacao original

Proposito: registrar a correcao dos tres gaps (busca semantica, hooks, historico). Publico: mantenedores. Data: 2026-10-22.

### Fase 1: investigacao (concluida)

- Motor: AI Memory 3.1.2 em `upstream/ai-memory` (commit ad26451), binario da suite em `.local/engines/ai-memory/c146869...`; original em `%LOCALAPPDATA%\Programs\ai-memory` com dados em `%LOCALAPPDATA%\ai-memory`.
- G1, causa raiz: `src/install.ts` (`initMemory`) grava `embedding_provider = "none"` no topo do `config.toml` de cada perfil novo. O motor ja tem embeddings locais nativos (candle, all-MiniLM-L6-v2, 384 dim, sha256 fixados em `crates/ai-memory-llm/src/local.rs`); `models_dir` e fixo em `<data_dir>/models`. Com `embedding_provider = "local"` explicito o motor baixa do Hugging Face oficial com checksum ou falha, sem fallback externo. `backfill_on_start` controla importacao de sessoes antigas (decisao 4) e e independente do backfill de embeddings de paginas.
- G2, causa raiz: `src/hook.ts:9` mapeia so 5 eventos e `src/clients.ts` (`hookEntries`) instala exatamente esses. O motor ja trata `pre-compact`, `stop`, `subagent-start`, `subagent-stop` (`crates/ai-memory-hooks/src/payload.rs`). Instalacao original (backup `.local/backup-ai-memory-2026-10-22/claude-settings.json`): Claude 9 eventos; Codex 7 (sem subagentes).
- G3, inventario original (copia bruta, servidor original parado, `integrity_check=ok`, schema v83): 2 workspaces, 12 projetos, 33 sessoes, 3213 observacoes, 21 paginas, 18 handoffs, 3213 ingest_keys; wiki 660 KB. Suite default (backup nativo, schema v84): 1 workspace, 1 projeto, 14 sessoes, 598 observacoes, 10 paginas. Nenhuma colisao de ID; colisao de nomes em `jev-suite` e `jev-suite/jev-memory-suite`. Spool original com 1202 eventos nao drenados.
- Achado: eventos continuam chegando ao spool original (ate 11:42) embora `~/.claude/settings.json` nao tenha mais hooks ai-memory; provavel processo Claude iniciado antes da remocao. Nao alterado (configuracao global fora do escopo).
- Backups: `.local/backups/2026-10-22-gaps/` (`raw-original/` copia bruta db+wiki+config, `suite-default.tar.gz` via `ai-memory backup`, `SHA256SUMS`).
- Baseline: typecheck ok, lint ok, `npm test` 114 testes: 111 pass, 3 fail preexistentes em `test/launch.test.ts` (fixture dentro do repo encontra o `.ai-memory.toml` da raiz).

### Fase 2: busca semantica local (G1 resolvido; validado)

- Correcao: `src/install.ts` grava `embedding_provider = "local"` em perfis novos e `syncEmbeddingProvider` ajusta so a primeira linha gerida pela suite em perfis existentes (provedor configurado pelo usuario nunca e tocado); `backfill_on_start = false` mantido (decisao 4). `src/config.ts`: `memory.semanticSearch` (padrao `true`; `false` volta a `none`). Novo `src/models.ts`: verifica os 3 arquivos do all-MiniLM-L6-v2 contra os sha256 fixados no motor, mantem cache verificado em `.local/models/` (semeado a partir da instalacao original, somente leitura) e cria hardlinks no perfil; sem fonte valida, o motor baixa do Hugging Face oficial com checksum ou falha. `src/supervisor.ts` provisiona antes do `serve`.
- Arquivos: `src/config.ts`, `config/default.json`, `src/install.ts`, `src/supervisor.ts`, `src/models.ts`, `test/models.test.ts`, `test/install.test.ts`, `test/config.test.ts`, `test/semantic-e2e.ts`, `package.json` (script `test:semantic`).
- Validacao real (perfil default reiniciado): log `embedder enabled provider="local" model="all-MiniLM-L6-v2" dim=384`; `startup embedding backfill completed embedded=9 failed=0`; modelo por hardlink (link count 2), sem download; conexoes TCP do `serve` somente loopback.
- E2E `npm run test:semantic` (motor real, perfil descartavel): consulta "login" (termo ausente de todas as paginas) -> pagina de autenticacao top-1 com embeddings; nenhum hit sem embeddings; top-1 apos restart (indice persistido, backfill sem novos embeddings). Lexical "Kubernetes Helm" encontra a pagina de deploy. Evidencia `.local/evidence/semantic-e2e.json`.
- Limitacoes: fallback de copia em `linkOrCopy` sem teste; teste de localidade so no Windows; perfis de projetos externos so recebem o modelo no proximo start.

### Fase 3: hooks (G2 resolvido no wrapper; captura em cliente interativo pendente)

- Correcao: `src/hook.ts` mapeia 9 eventos (`pre-compact`, `stop`, `subagent-start`, `subagent-stop` adicionados), com schema por evento (limites, `agent_id` com allowlist de caracteres) e `hostEvents` por cliente: Claude 9, Codex 7 (igual a instalacao original; Codex nao tem eventos de subagente e `codex`+`subagent-*` e rejeitado). `parseHookPayload` remove `transcript_path`, `agent_transcript_path` e `last_assistant_message`. `hookOutput` fixa `{}` nos 4 eventos novos (sem `decision`, sem loop de Stop). `recordActiveSession` usa tmp unico (subagentes concorrentes). `src/clients.ts` instala o conjunto do host.
- Arquivos: `src/hook.ts`, `src/clients.ts`, `test/hook.test.ts`, `test/clients.test.ts`; `.claude/settings.local.json` e `.jev-memory-claude.json` regenerados por `jev-memory clients install claude` (backup `.local/client-backups/2026-10-22T15-04-01-609Z-claude`).
- Validacao real (motor do perfil default, `dist/src/hook.js`): 9 eventos + 6 de subagente concorrentes, todos exit 0 em 174-526 ms, stdout `{}`; sessao sintetica com exatamente 15 observacoes (sem duplicacao); `last_assistant_message` e caminhos de transcricao ausentes do banco; `codex subagent-start` exit 1. Reinstalacao idempotente (`changed: []`).
- Paridade: o motor grava eventos de subagente como `kind=other` com corpo vazio e nao persiste `agent_id` (usa so para roteamento interno); a instalacao original tem o mesmo formato (171 `other` vazios). Limitacao do motor, nao alterado.
- Pendente: captura em sessao interativa nova do Claude Code (os hooks sao lidos no inicio do processo); Codex do projeto externo farol continua com 5 eventos ate `jev-memory clients install codex <dir>` + revisao `/hooks`.

### Fase 4: migracao do historico (G3 resolvido; aplicado e validado)

- Implementacao: comando `jev-memory [--profile p] migrate-history --from <dataDir> [--apply]` (`src/migrate.ts`, `src/migrate-db.ts`, `src/migrate-spec.ts`, `src/migrate-validate.ts`, `src/migrate-wiki.ts`, `src/cli.ts`; testes `test/migrate.test.ts`, 12 casos com fixtures do motor real). Dry-run por padrao; fonte so lida via copia com sha256 antes/depois; apply exige suite parada; `VACUUM INTO` antes; transacao unica com `defer_foreign_keys` + `foreign_key_check`; mapeamento por nome de workspace/projeto, IDs e timestamps preservados; nunca UPDATE/DELETE; wiki copiada sem sobrescrever (tmp + link exclusivo); validacao pos-apply e relatorio sem conteudo.
- Spool: 1202 eventos nao drenados da instalacao original foram processados numa COPIA isolada (`.local/tmp/migration-staging`, motor da suite em 127.0.0.1:49374 com embeddings/manutencao/backfill desligados, `ai-memory recover`): sent=1200, dropped=2 (descartados pelo proprio motor). Staging resultante: 47 sessoes, 4408 observacoes, 31 paginas, 28 handoffs, integrity ok. Snapshot do spool em `.local/backups/2026-10-22-gaps/spool-snapshot/`.
- Dry-run e apply (perfil default): inseridos 1 workspace, 11 projetos, 26 paginas, 39 sessoes, 3917 observacoes, 4408 ingest_keys, 23 handoffs; 44 arquivos de wiki. Conflitos reportados (nao importados, preservados na fonte/backup): 8 sessoes capturadas em dobro (todas ja existiam na suite; mantida a versao da suite) com 491 observacoes, 5 paginas e 5 handoffs delas; 6 arquivos de wiki existentes diferentes (ledger `log-2026-10.md` e paginas dessas sessoes).
- Validacao: integrity ok, 0 violacoes de FK, contagens antes+inseridos=depois em todas as tabelas, 26/26 paginas com sha256 e corpo iguais a fonte, FTS ok. Reexecucao: 0 inseridos, 0 arquivos criados (idempotente). Banco original inalterado (sha256 0a50d6b7... antes e depois).
- Indexacao: restart com embeddings locais -> `startup embedding backfill completed scopes=12 embedded=23 skipped=10 failed=0`; 33/33 paginas latest com vetor.
- Recuperacao MCP: `memory_status default/jev-memory-suite` 18 sessoes/1734 observacoes; `memory_query` com stream `vector` ativo retorna paginas migradas; busca global retorna sessoes migradas com timestamps originais (2026-10-21).
- Atencao: 3 handoffs abertos da instalacao original foram importados para `jev-suite/jev-memory-suite` e serao oferecidos nas proximas SessionStart (uso unico); cancelaveis com `memory_handoff_cancel`. 1 aberto foi para `jev-suite/p-farol-platform-...` no store default (o perfil do farol nao o ve).
- Rollback: `.local/backups/migration-2026-10-22T15-19-42-350Z/` (memory.sqlite + SHA256SUMS) e lista `wiki.created` em `.local/evidence/migration-2026-10-22T15-19-42-350Z-apply.json`; backups gerais em `.local/backups/2026-10-22-gaps/`.
- Limitacoes: dados do projeto farol vindos da instalacao original ficaram no store do perfil default (acessiveis por escopo explicito/global a partir dele, nao pelo perfil do farol). `.local/tmp/migration-staging` contem copia dos tokens locais da instalacao original; remover quando nao for mais necessario.

### Fase 5: integracao geral (validada com ressalvas)

- `npm test`: 157 testes, 154 pass, 3 fail preexistentes (`launch.test.ts`). `npm run test:projects` 1/1. `npm run test:semantic` 1/1. `npm run test:e2e` 3/4: falha "both disabled" = `ownRootRegistration` recusa perfil temporario porque a raiz do repo tem registro de cliente do perfil `default` (`.jev-memory-claude.json`, presente desde antes desta etapa); mesma causa das 3 falhas de `launch.test.ts`. Nao corrigido (fixture de teste, fora do escopo).
- Gateway + memoria (`test:e2e` "gateway and memory") aprovados; `jev-memory mcp`: handshake ok, 24 ferramentas (o enunciado cita 26; o motor 3.1.2 expoe 24, igual ao registrado em M5); `jev-memory doctor`: memory/dashboard ready.
- Motor inalterado (`c146869`): 68 comandos de topo, 67 respondem a `--help` (`help` nao aceita a flag), 41 subcomandos aninhados. O enunciado cita 71; contagem nao confere, mas o binario e o mesmo da baseline.
- Skills `ai-memory-*`: 6 presentes em `~/.claude/skills` e `~/.agents/skills`, inalteradas.
- Persistencia apos reinicializacao: verificada (restarts nas fases 2 e 4; E2E semantico com restart).

### Fase 6: documentacao (concluida)

- Novos: `docs/architecture/adr/0007-local-semantic-memory.md`, `docs/architecture/adr/0008-history-migration.md`, `docs/guides/migration.md`. Atualizados: README, CHANGELOG, `docs/architecture/README.md` e indice de ADRs, `docs/api/{hooks-and-bridge,cli,configuration-schema,managed-files}.md`, `docs/guides/{configuration,installation,development,troubleshooting,clients,README}.md`, `docs/security/{lgpd,threat-model,owasp-asvs-review,README,credentials-and-hook-isolation}.md`, `docs/runbooks/backup-and-recovery.md`. Estrutura adaptada ao padrao existente (ADR 0001 ja ocupada; guias e runbooks com nomes existentes).
- Links relativos: 159 verificados em 24 arquivos, 0 quebrados.

### Fase 7: revisao de seguranca e estado final

- SQL da migracao: tabelas de lista fixa, identificadores validados por regex antes de citar, valores sempre parametrizados. Wiki: `inside()` contra traversal, symlinks ignorados, escrita exclusiva (tmp + link). Hooks: schema por evento com limites e allowlist, remocao de transcricoes e texto do assistente, saida `{}` sem decision. Modelo: sha256 fixado, provider local explicito sem fallback externo. `npm audit --omit=dev`: 0 vulnerabilidades; nenhuma dependencia nova; nenhum segredo no diff.
- Riscos residuais: `.local/tmp/migration-staging` guarda copia dos tokens locais da instalacao original (remover apos aceite); 3 handoffs antigos abertos no projeto ativo; processo Claude antigo ainda envia hooks ao servidor original 49374 (spool cresce ate reiniciar); `node:sqlite` experimental no Node 24; dados em repouso sem cifragem (preexistente); RAM do embedder nao medida; captura em sessao interativa nova e Codex `/hooks` nao validados.
- Proximo passo: abrir nova sessao do Claude Code neste repo para validar os 9 hooks interativos; decidir sobre os 3 handoffs importados; remover staging; revisar e commitar.

## Marco de estabilizacao 1: P0 (2026-10-22)

Proposito: registrar a correcao dos dois P0 da auditoria arquitetural. Publico: mantenedores. Data: 2026-10-22.

### P0-2: SubagentStop rejeitado (corrigido)

- Causa raiz: `src/hook.ts:32` exigia `agent_type` com `min(1)`. O Claude Code real envia `agent_type` presente e vazio no `SubagentStop`; o motor (`upstream/ai-memory/crates/ai-memory-hooks/src/payload.rs:278-283`) le o campo como JSON livre e nao o exige. Os testes sinteticos usavam `agent_type: 'Explore'`. Evidencia: `logs/hook-errors.log` do perfil default com 33 rejeicoes `agent_type:too_small` ate a correcao, incluindo 2 reproduzidas ao vivo nesta sessao (16:22:28Z e 16:23:01Z).
- Correcao: `agent_type: z.string().max(MAX_NAME_CHARS)` (remove so o `min(1)`); `agent_id` continua obrigatorio com allowlist. Afeta `subagent-start` e `subagent-stop`.
- Testes (`test/hook.test.ts`): payload no formato real do `SubagentStop` (valores sinteticos; o log nao guarda payloads, entao o formato vem do contrato documentado do Claude Code mais o valor observado); `SubagentStart` com `agent_type` vazio; rejeicao de `agent_type` ausente, `null`, numerico e com 201 caracteres; `agent_id` fora da allowlist ainda rejeitado.
- Resultados: RED antes da correcao 36 testes, 34 pass, 2 fail (os dois de aceitacao). Depois: `npx tsx --test test/hook.test.ts` 36/36; `npm run typecheck` ok; `npm run lint` ok; `npm test` 161 testes, 158 pass, 3 fail (as mesmas 3 de `test/launch.test.ts`); `npm run build` ok; `npm run test:e2e` 3/4 (mesma falha "both disabled" de `ownRootRegistration`, sem relacao com hooks).
- Validacao com cliente real: `dist/src/hook.js` recompilado as 16:23:07Z, nesta sessao do Claude Code; depois disso, nenhuma nova rejeicao e observacoes de subagente gravadas. Nao e a validacao completa em sessao nova (o processo do Claude ja estava aberto).

### P0-1: credencial em texto puro no Codex (pendente de acao do usuario)

- Achado: `~/.codex/config.toml` define a credencial `ANTHROPIC_API_KEY` em `[shell_environment_policy.set]`, junto com `ANTHROPIC_BASE_URL` apontando para um proxy de terceiros. O Codex injeta essas variaveis em todo comando de shell que executa. Arquivo global, fora do repositorio; nao alterado.
- Varredura sem imprimir valores: 0 ocorrencias nos stores, logs, backups, `tmp` e `evidence` dos perfis da suite, nos dados da instalacao original do AI Memory, no `.local` do Farol e nas sessoes e sessoes arquivadas do Codex. Ocorrencias: 5 backups de `config.toml` em `~/.codex`, `~/.codex/thread_history_1.sqlite`, `.local/backup-ai-memory-2026-10-22/codex-config.toml` e o transcript desta sessao do Claude Code, porque um comando da auditoria imprimiu trechos do `config.toml`.
- Exposicao ativa confirmada: a credencial foi exibida numa sessao de modelo e esta em varias copias locais. Acao do usuario, urgente: revogar e rotacionar a credencial no provedor; remover a chave de `shell_environment_policy.set`; limpar as copias listadas. A suite nao altera credenciais nem configuracao global sem autorizacao.

### Riscos restantes

- Validacao de `SubagentStop` em sessao nova do Claude Code ainda pendente.
- `agent_type` vazio e repassado ao motor como esta; o motor nao o persiste (observacoes `other` com corpo vazio).
- P0-1 depende de acao do usuario; ate la, a chave continua valida e presente nas copias listadas.

## Marco de estabilizacao 2: integridade de memoria, harness e clientes (2026-10-22)

Proposito: registrar a migracao por projeto, a reconciliacao da memoria, o harness de hooks e da bridge, e o estado dos clientes. Publico: mantenedores. Data: 2026-10-22.

### A: migracao por projeto (implementada)

- Comando: `jev-memory [--profile p] migrate-history --from <dataDir> [--project <ws>/<projeto>] [--as <ws>/<projeto>] [--apply]`. `--project` copia so o escopo de origem. `--as` mapeia para um projeto existente no destino (padrao: mesmo nome) e exige `--project`.
- Modo com escopo: nunca insere workspaces nem projetos; exige o escopo de destino existente ("abra uma sessao no projeto antes de migrar"); copia so o diretorio de wiki daquele projeto, nunca os arquivos da raiz do workspace de origem. Modo sem escopo inalterado.
- Guarda de handoffs (nos dois modos): handoff com `cwd` fora da raiz do projeto de destino (`projectRoot`, ou a raiz da suite no perfil `default`) nao e inserido; contagem em `excluded.handoffsOutsideProject`. O relatorio ganha o campo `scope`.
- Garantias mantidas: dry-run por padrao, apply com suite parada, `VACUUM INTO`, transacao unica, checagem de FK, validacao, somente insercao e idempotencia. Fonte de store vivo deve ser snapshot consistente (backup online SQLite) mais copia de `wiki/`.
- Teste: `npx tsx --test test/migrate.test.ts` 18/18 (12 anteriores + 6 novos).

### B: reconciliacao aplicada (2026-10-22)

- Backups antes de qualquer alteracao: `.local/backups/m2-2026-10-22T16-41-52Z/` (backups online SQLite dos stores default e Farol, ambos integrity_check=ok; `ai-memory backup` nativo; tarball da wiki do default; SHA256SUMS).
- jev-memory-suite: havia `default/jev-memory-suite` (18 sessoes, 1734 observacoes, 12 paginas, 10 handoffs; criado pela instalacao original, que derivou o workspace `default`) e `jev-suite/jev-memory-suite` (20 sessoes, 1599 observacoes, 16 paginas, 15 handoffs). Reunidos com o comando do motor `ai-memory move-session --from-project jev-memory-suite --from-workspace default --to jev-memory-suite --to-workspace jev-suite --force --confirm` (AI_MEMORY_SERVER_URL na porta 49375), depois de dry-run (18/18). `--force` so foi necessario porque sessoes historicas da instalacao original nunca registraram SessionEnd; nenhum writer vivo usa esse escopo.
- Resultado: `jev-suite/jev-memory-suite` com 38 sessoes, 28 paginas, 25 handoffs e 3344 observacoes (1599 + 1734 + 11 capturadas ao vivo durante a execucao). Totais do store preservados: 56 sessoes, 39 paginas, 35 handoffs. Integridade ok; checkpoint do motor c97da6dd.
- Limitacao: as 1794 `ingest_keys` (chaves de deduplicacao) permanecem no id antigo do projeto; nao guardam conteudo.
- Farol: no store default, o historico estava dividido em `default/jebadevv-thenoblehub` (5 sessoes, 847 observacoes, 3 paginas, 3 handoffs; nome derivado do remote Git pela instalacao original) e `jev-suite/p-farol-platform-b9b5f26bfe6b2ceb49cb` (4 sessoes, 1008 observacoes, 1 pagina, 1 handoff). O store do perfil Farol (`project-b9b5f26bfe6b2ceb49cb`) tinha 5 sessoes e 12 observacoes.
- Aplicadas duas migracoes com escopo, a partir de snapshot consistente (`.local/tmp/m2-farol-source`), com o perfil Farol parado durante o apply e reiniciado depois:
  - `--project jev-suite/p-farol-platform-b9b5f26bfe6b2ceb49cb`: inseriu 2 sessoes, 1005 observacoes, 1 pagina, 1 handoff e 1008 ingest_keys. Duas sessoes ja existiam com conteudo diferente; a versao da suite foi mantida, 3 observacoes dessas sessoes nao foram importadas e 2 arquivos de wiki diferentes nao foram sobrescritos.
  - `--project default/jebadevv-thenoblehub --as jev-suite/p-farol-platform-b9b5f26bfe6b2ceb49cb`: inseriu 5 sessoes, 847 observacoes, 3 paginas e 3 handoffs.
  - Validacao ok nas duas, fonte inalterada, 0 handoffs excluidos. Reexecucao das duas: 0 inseridos.
  - Store do Farol depois: 12 sessoes, 1864 observacoes, 4 paginas e 4 handoffs; integridade ok. Backups de cada apply: `.local/backups/migration-2026-10-22T16-47-37-641Z/` e `.local/backups/migration-2026-10-22T16-47-38-323Z/`.
  - Recuperacao pelo MCP do Farol: `memory_status` 12 sessoes, 1864 observacoes, 4 paginas; `memory_recent` retorna as paginas migradas.
- O store default mantem as copias dos escopos do Farol. Nada foi apagado; a remocao exige aprovacao.
- `ai-memory audit-contamination`: 0 achados nos stores default e Farol.
- Handoffs abertos: 2 no store do Farol e 12 no default; varios foram criados pela validacao sintetica G2 as 15:06 UTC. O motor entrega handoff automatico so a uma sessao cujo cwd e o gravado ou um descendente. Nenhum foi expirado (exige aprovacao). Comando por escopo: `ai-memory handoffs --workspace <ws> --project <p> --expire-all [--older-than-days N] --confirm`.

### C: harness (hooks e bridge)

- Hook skips (`src/hook.ts`): `memory-disabled` e `no-scope-marker` gravam `<perfil>/logs/hook-skips.log` com somente `agent=`, `event=` e `skip=`. A saida para o host continua `''`.
- Bridge com sessao (`src/bridge.ts`, `src/clients.ts`, `src/launch.ts`): registros e arquivos de lancamento do Claude usam `bridge.js <perfil> claude-code`. A bridge repassa `CLAUDE_CODE_SESSION_ID` validado (`^[A-Za-z0-9._:-]{1,200}$`) como `ai-memory mcp-bridge --agent claude-code`. Codex, id ausente ou invalido: mantem `--no-session-id` e nada e repassado. Agente desconhecido e recusado antes do spawn.
- Evidencia do motor em `memory_status` (`scope.resolved_by`): `shared_slot` antes; `session` com a bridge; `default_after_mismatch` para id desconhecido; id invalido cai no fallback.
- Testes: `test/bridge.test.ts` 5/5 (novo); `test/hook.test.ts` 39/39; `test/clients.test.ts` 15/15.
- Registro deste repositorio do Claude refeito; backup `.local/client-backups/2026-10-22T16-49-48-313Z-claude`.

### D: Claude Code em sessao nova

- `claude -p --model haiku` em projeto descartavel registrado (perfil `project-6ba92a7197ddf0f80818`, pasta de rascunho): `resolved_by=session echo=probe-ok subagent=pong`.
- Eventos capturados: session-start 1, user-prompt 2, pre-tool-use 5, post-tool-use 4, stop 2, outros 2 (SubagentStart e SubagentStop), session-end 1. Sem hook-errors nem hook-skips. Nada dessa sessao nos stores default e Farol.
- Nao exercitados: PreCompact (exige uma compactacao) e a sessao interativa (TUI).
- Perfil e projeto descartaveis foram mantidos.

### E: Codex

- Codex CLI 0.163.0. `hooks/list` nativo (app-server, somente leitura) do Farol: os 5 hooks anteriores continuam trusted e habilitados. O Codex limita o timeout de SessionEnd a 3 s e emite aviso.
- Registro do Farol atualizado com `clients install codex D:\Dev\the-noble-dev\farol-platform`: 7 eventos; os 5 hooks inalterados (mesmo hash, trusted); PreCompact e Stop `untrusted` ate revisao em `/hooks` (acao do usuario). Backup: `.local/client-backups/2026-10-22T16-48-15-539Z-codex` do projeto. Este repositorio nao tem registro do Codex.
- Eventos reais BLOQUEADOS: `codex exec` retornou o limite de uso da conta ("try again at 2:58 PM"). Hooks de diretorio nao confiavel nao sao carregados, mesmo com `-c projects...trust_level`; um projeto descartavel exigiria confianca persistente na configuracao global (aprovacao necessaria).
- Codex Desktop: nao validado. A bridge do Codex segue sem sessao.

### F: testes

- `npx tsx --test test/migrate.test.ts`: 18/18.
- `npx tsx --test test/hook.test.ts`: 39/39. `npx tsx --test test/clients.test.ts`: 15/15. `npx tsx --test test/bridge.test.ts`: 5/5.
- `npm run typecheck`: ok. `npm run lint`: ok. `npm run build`: ok.
- `npm test`: 177 testes, 174 pass, 3 fail (as mesmas 3 falhas preexistentes de `test/launch.test.ts`).
- `npm run test:e2e`: 3/4 (mesma falha preexistente "both disabled").
- `npm run test:projects`: 1/1. `npm run test:semantic`: 1/1.

### G: riscos restantes

- Credencial do Marco de estabilizacao 1 (P0-1) ainda depende de rotacao pelo usuario.
- `.local/tmp/m2-farol-source` guarda copia completa do store default, com tokens locais; remover apos aceite.
- Copias duplicadas dos escopos do Farol no store default.
- Handoffs abertos antigos (2 no Farol, 12 no default).
- Captura real do Codex e Codex Desktop nao validadas.
- PreCompact e sessao interativa do Claude nao validados.
- Perfil descartavel `project-6ba92a7197ddf0f80818` e projeto de rascunho mantidos no lugar.

Estado do marco: parcial. A migracao por projeto, a reconciliacao e o harness estao validados; a validacao real do Codex e do Desktop segue pendente.

### Validacao real do Codex CLI (2026-10-22, apos restauracao do limite)

- `codex exec -s read-only` no projeto Farol (`D:\Dev\the-noble-dev\farol-platform`). Em execucao nao interativa, a entrada padrao precisa ser fechada (por exemplo `< /dev/null`); sem isso o codex espera stdin.
- MCP: `memory_status` resolveu o projeto `p-farol-platform-b9b5f26bfe6b2ceb49cb` (`resolved_by=default`). O comando de shell rodou.
- Hooks: nenhuma captura, sem `hook-errors` nem `hook-skips`.
- Causa reproduzida: o comando do hook era `"<node.exe>" "<hook.js>" ...`. O PowerShell do Codex (`powershell.exe -Command`) não analisa uma string entre aspas seguida de outros argumentos, e o node não inicia. Com o operador de chamada, `& "<node.exe>" "<hook.js>" ...`, o node inicia e o hook.js roda (confirmado com um evento inválido, rejeitado no log).
- Correção: `src/clients.ts`, `hookEntries` prefixa `& ` no Codex em win32. O comando do Claude Code não muda.
- Revalidacao (2026-10-22 17:51 UTC): `clients install codex` no Farol (backup `.local/client-backups/2026-10-22T17-51-46-842Z-codex`); os 7 hooks passaram a usar `&` e o Codex os marca como `modified`/`untrusted` ate nova revisao em `/hooks` (acao do usuario). Execucao real `codex exec -s read-only --dangerously-bypass-hook-trust` (bypass so desta invocacao; `~/.codex/config.toml` inalterado, hash conferido): sessao `01a164bd...` capturada no store do Farol e encerrada, com session-start 1, user-prompt 1, pre-tool-use 2, post-tool-use 2, stop 1, session-end 1; nenhum hook-errors, nenhum hook-skips; nada no store default. MCP: projeto `p-farol-platform-b9b5f26bfe6b2ceb49cb` (`resolved_by=shared_slot`; o Codex nao tem correlacao de sessao no motor, e o isolamento vem do servidor por perfil). PreCompact nao exercitado. Codex Desktop nao validado.

## Marco de estabilizacao 3: ciclo de vida do Gateway, harness e isolamento de testes (2026-10-22)

Proposito: registrar o dono de cada Gateway, a recuperacao limitada do supervisor, o harness de hooks, o isolamento dos testes e os numeros medidos. Publico: mantenedores. Data: 2026-10-22.

### A: gateways (ADR 0009)

- Dois donos explicitos. Gateway upstream (claude na porta 8789, codex na 8790): iniciado e parado pelo launcher `jev-claude` ou `jev-codex`. Gateway da suite (porta 18878): so com `gateway.enabled`, possuido pelo supervisor. `jevLaunch` recusa os dois juntos no mesmo perfil (src/launch.ts).
- `src/gateways.ts`: `upstreamGateways()` le `portEnv` e a porta padrao de `bin/clients.mjs` da instalacao upstream (`source: installed`). Sem especificacao legivel, usa 8789 e 8790 com `source: fallback`. Variavel de porta so e aceita como decimal entre 1024 e 65535 (`portValid`).
- `probeGateway()`: so origens 127.0.0.1 e localhost, `redirect: error`, timeout de 1 s, estados `running`, `stopped` ou `unavailable`, sem texto de erro. URL do upstream sem credenciais, query e fragmento.
- Painel (src/dashboard.ts, src/dashboard-page.ts): sem porta 8790 fixa. Um iframe rotulado por cliente. CSP `frame-src` restrita as origens dos dois gateways (formas localhost e 127.0.0.1). `jev-memory start` repassa `JEV_CODEX_PORT` e `JEV_CLAUDE_PORT` ao supervisor somente quando validos (src/lifecycle.ts).
- `doctor` (src/lifecycle.ts): `gateways.claude` e `gateways.codex` com portEnv, port, portValid, source, state, pid e upstream; e `conflicts`. `availablePorts` (src/projects.ts) exclui as portas upstream.
- Medido: claude 8789 running (pid, upstream https://api.anthropic.com/v1); codex 8790 running (upstream https://chatgpt.com/backend-api/codex); conflicts []. Com `JEV_CODEX_PORT=19790`, codex reportou porta 19790 stopped.

### B: recuperacao do supervisor (src/supervisor.ts)

- `restartDelay` (funcao pura): filho que sai depois de ready e reiniciado ate 3 vezes em 60 s, com backoff de 1, 2 e 4 s, conferindo a porta antes. `/status` mostra `services[nome] = 'restarting'` e o mapa `restarts`.
- Falha antes do primeiro ready mantem o comportamento anterior (falha de startup encerra). Orcamento esgotado: phase `failed`, supervisor encerra limpo. O proximo `ensureServicesReady` ou `jev-memory start` sobe de novo.
- Teste real em perfil descartavel: kill em `ai-memory serve` gerou restarting em cerca de 0,5 s, starting em cerca de 1,3 s e ready em cerca de 2,0 s (restarts 1). Os kills 2 e 3 recuperaram (restarts 2 e 3). O quarto kill levou a failed e o supervisor encerrou. `start` depois voltou a ready.

### C: isolamento de testes (causa das 4 falhas pre-existentes)

- Causa: perfis de teste sem `projectRoot`, e fixtures dentro do repositorio (`.local/launch-test-*`). `planLaunch` lia o `.jev-memory-claude.json` real da raiz (perfil default); `projectScopeMarker` achava o `.ai-memory.toml` real; o e2e "both disabled" planejava na raiz do repositorio.
- Correcao, somente em testes: perfis com `projectRoot` em diretorio temporario fora do repositorio, e os planos usam esse cwd. Uma assercao antiga foi atualizada para a bridge com sessao, `[name, 'claude-code']`.
- Vazamentos corrigidos: `test/e2e.ts` e `test/projects-e2e.ts` param e removem os perfis que criam; `test/lifecycle.test.ts` remove os proprios perfis.
- Contagem de perfis: 213 antes e 213 depois de `npm test`, `test:e2e`, `test:projects` e `test:semantic`.
- Nao removidos (exige aprovacao): cerca de 95 `unit-*`, 41 `port-conflict-*`, 23 `project-*` temporarios e `e2e-*` antigos.

### D: harness de hooks, Claude e latencia

- Teste de regressao do PowerShell (`test/clients.test.ts`, somente win32): executa o comando real gerado para o Codex com `powershell.exe -Command`, envia um evento invalido e confirma que hook.js iniciou (stderr "Suite hook rejected or unavailable", sem ParserError). Verificado: falha sem o prefixo `& `.
- PreCompact do Claude verificado em sessao real: `claude -p --resume <sessao> "/compact"`, com `MSYS_NO_PATHCONV=1` no Git Bash, capturou observacao de pre-compact sem entradas em hook-errors ou hook-skips. Com isso, os 9 eventos do Claude tem captura verificada em sessao real: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop e SessionEnd via `claude -p`, e PreCompact via `/compact`. A TUI interativa segue sem exercicio.
- Latencia no perfil descartavel `project-6ba92a7197ddf0f80818`: `jev-memory start` ate ready em 775 ms. Memoria: `ai-memory serve` com 143,7 MB (embedder local carregado) e supervisor node com 106 MB. Hooks: post-tool-use de 160 a 198 ms (10 sequenciais); session-start de 228 ms; session-end de 1098 ms, abaixo do limite de 3 s do Codex mas o mais lento; 6 pre-tool-use em paralelo somaram 221 ms; todos com saida 0. Nenhuma otimizacao foi feita, porque nenhum gargalo foi confirmado.
- Dedup: o mesmo payload de PostToolUse enviado duas vezes (mesmo tool_use_id) foi armazenado duas vezes. Comportamento do motor, nao alterado (upstream intocado). Clientes reais nao reenviam.
- Legado: 1794 linhas de `ingest_keys` no projeto `default/jev-memory-suite`, agora vazio, com session_id NULL. So importa se os mesmos eventos forem reingeridos nesse escopo. Sem acao.

### E: Codex

- `hooks/list` nativo do Farol: os 7 hooks do jev-memory-suite aparecem como `modified` e `untrusted` depois da correcao do PowerShell, porque o hash mudou. A revisao em `/hooks` e acao do usuario.
- Sem execucao live do Codex neste marco: a credencial exposta ainda esta na configuracao global (rotacao nao confirmada) e nao se usa bypass de confianca.
- Sessao no Codex: a bridge com sessao do motor suporta apenas `claude-code` e `muse` (`ai-memory mcp-bridge --help`). O Codex segue sem sessao; o isolamento vem de um servidor por perfil de projeto.
- Codex Desktop: nao verificado.

### F: comandos e numeros

- `npm run build`, `npm run typecheck` e `npm run lint`: ok.
- `npm test`: 197/197. `npm run test:e2e`: 4/4. `npm run test:projects`: 1/1. `npm run test:semantic`: 1/1.
- `npm audit --omit=dev`: 0 vulnerabilidades.

### G: pendencias restantes

- Rotacao da credencial exposta na configuracao global do Codex (acao do usuario; ver Marco de estabilizacao 1, P0-1).
- Revisao dos 7 hooks do Codex em `/hooks` (acao do usuario).
- Codex CLI com confianca normal: checklist em [clientes](docs/guides/clients.md), registro `S3-codex-cli-normal-trust` (pending).
- Codex Desktop: checklist manual em [clientes](docs/guides/clients.md), registro `S3-codex-desktop` (pending, nao verificado).
- Handoffs abertos antigos: 2 no store do Farol e 12 no default. Expirar exige aprovacao: `ai-memory handoffs --workspace <ws> --project <p> --expire-all [--older-than-days N] --confirm`.
- Perfis de teste de execucoes antigas (listados em C): remocao exige aprovacao.
- `.local/tmp/m2-farol-source` (copia do store default, com tokens locais): remover apos aceite, com aprovacao.
- TUI interativa do Claude Code: nao exercitada.

Estado do marco: parcial. Gateways, supervisor, harness e isolamento de testes estao validados. Confianca normal do Codex e Desktop dependem de acao do usuario.

## Painel unificado Jev Gateway + AI Memory (2026-10-22)

Proposito: registrar a correcao do painel local (um iframe do agregador do Jev Gateway, seção de gateways e rota `/gateways/status`), a causa de cada problema e os numeros medidos. Publico: mantenedores. Data: 2026-10-22. Decisao: [ADR 0010](docs/architecture/adr/0010-unified-dashboard.md).

### A: causas (antes da correcao)

- O painel renderizava um iframe por gateway (claude e codex), mas o painel do gateway upstream ja agrega todos os roteadores. Ele consulta `/dashboard/events` na propria porta, nas portas padrao 8787 a 8793 e nas de `?peers=` (upstream/jev-gateway/src/dashboard.html, linhas 200 a 214). CORS para origens locais em upstream/jev-gateway/src/dashboard.ts, linhas 10 a 33. Resultado: visao duplicada e sondagem dupla.
- Os iframes nao recebiam `?peers=`, entao um gateway em porta customizada nao aparecia.
- A lista de gateways era resolvida uma vez, na partida do supervisor. Um gateway parado depois disso deixava o iframe quebrado.
- Nao havia metricas unificadas do Gateway.

### B: implementacao

- `src/gateways.ts`: `aggregatorFor` prefere o Codex quando esta em execucao, senao o Claude. URL `http://localhost:<porta>/dashboard?peers=<demais portas>`, numericas, sem duplicatas e sem a propria porta. `summarizeGatewayEvents` valida `/dashboard/events` de forma estrita (router.client com padrao de ate 64, router.routing booleano, ate 5000 eventos, malformados ignorados, numeros finitos e nao negativos) e devolve so contagens: requests, routed, failedOrPassthrough, tokens {input, output, cached}, avgLatencyMs e lastEventAt. `gatewayStatus`: `/health` e depois `GET /dashboard/events?since=0` com timeout de 1500 ms, `redirect: 'error'`, `credentials: 'omit'`, sem cabecalhos e corpo de ate 2 MB. 401 e 403 viram `auth-required`; falhas viram `unavailable`; gateway parado vira `offline`. A saida nao tem pid nem upstream.
- `src/dashboard.ts`: snapshot em cache de 5 s, com uma unica atualizacao em voo; falha vira snapshot offline, tambem em cache. `/` montada por requisicao, com `frame-src` restrita as duas origens de loopback do agregador, ou `'none'`. Demais diretivas da CSP inalteradas. Nova rota `GET /gateways/status` com Host exato (403 em outro caso) e `no-store`.
- `src/dashboard-page.ts`: exatamente um iframe (`id="gateway-slot"`, `data-aggregator="cliente:porta"`, sandbox `allow-scripts allow-same-origin`), ou o bloco "Gateways offline" com os comandos `jev-memory-codex` e `jev-memory-claude`. Secao "Gateways" com um cartao por cliente.
- `src/dashboard-script.ts`: consulta `/gateways/status` a cada 5 s, com `no-store`, e grava com `textContent`. Se o agregador mudar, mostra aviso para recarregar; nao recarrega sozinho. Falha afeta so os cartoes dos gateways.
- Sem alteracao em backends: memoria segue no supervisor do perfil; gateways seguem com o launcher upstream (ADR 0009); `upstream/` intocado; paginas diretas `:8790/dashboard` e `:8789` continuam acessiveis; `jev-memory dashboard` e `--dashboard` continuam abrindo o painel da suite.
- Alternativas rejeitadas: reimplementar a pagina do upstream (duplicaria cerca de 521 linhas e quebraria em atualizacoes); proxy reverso para a origem da suite (exigiria `'unsafe-inline'` e colocaria o script do upstream na mesma origem das APIs de memoria).
- Limite de contagem: o upstream retem no maximo 1000 eventos por processo (upstream/jev-gateway/src/events.ts, linha 38). Os numeros cobrem essa janela, nao o total historico.

### C: validacao ao vivo (perfil descartavel `project-6ba92a7197ddf0f80818`, gateways reais: claude 8789, codex 8790)

- `/`: exatamente 1 iframe, `src="http://localhost:8790/dashboard?peers=8789"`, `data-aggregator="codex:8790"`. CSP com `frame-src http://localhost:8790 http://127.0.0.1:8790`.
- `/gateways/status`: os dois gateways em `running`, com metricas `ok` (roteamento ligado, janela de 1000 requisicoes, contagens de tokens e latencia). Host invalido: 403. Corpo sem key=, Bearer, URL de upstream ou pid.
- Navegador (Chrome DevTools, contexto isolado): paineis de memoria integros; secao de gateways preenchida para os dois clientes; o unico iframe renderizou a pagina do upstream com "codex · :8790" e "claude · :8789" e o filtro por cliente. Zero erros e zero avisos no console.
- Nao reproduzidos ao vivo, para nao parar os gateways do usuario: somente Claude ou somente Codex, os dois parados, portas customizadas, timeouts, respostas malformadas ou acima do limite e protecao de segredos. Cobertos por testes unitarios.

### D: testes e comandos

- `test/dashboard.test.ts`: 39/39. `test/gateways.test.ts`: 35/35.
- `npm test`: 229/229 (antes, 197/197). `npm run test:e2e`: 4/4.
- Typecheck, lint e build: ok.

### E: riscos residuais (sem ampliacao)

- `POST /dashboard/routing` do upstream aceita qualquer origem local e requisicoes sem `Origin`. Qualquer processo local pode alternar o roteamento (upstream/jev-gateway/src/dashboard.ts, linhas 58 a 67). Codigo do upstream, nao alterado.
- Gateways iniciados pelo launcher rodam sem chave de roteador. Por isso `/dashboard/events` (metadados de requisicao, sem prompt) e legivel por processos locais.
- O painel da suite nao tem token. Processos locais da mesma conta podem ler resumos e feed de memoria. Mitigacoes: loopback, Host exato contra DNS rebinding, CSP restrita.
- O gateway do supervisor (`gateway.enabled`, com chave de roteador) nao aparece na secao unificada: as metricas seriam `auth-required` e a chave nunca e enviada.
- Ameaca registrada como T30 em [threat-model](docs/security/threat-model.md).

### F: pendencias

- Nenhuma alteracao de codigo foi feita nesta etapa de documentacao. Os numeros acima sao os da execucao de validacao.
- Os cenarios de falha de gateway seguem sem reproducao ao vivo (ver C).

## Painel nativo único e observabilidade de tokens (2026-10-22)

> Versão retirada em 2026-10-22: a interface nativa foi revertida. Ver a seção "Correção: painel original restaurado (2026-10-22)", no fim deste arquivo. O texto abaixo fica como registro histórico.

Propósito: registrar a substituição do iframe do agregador por um painel nativo, a medição de tokens do Jev, o experimento de roteamento configurável, a proteção da alternância do roteamento e o que ficou pendente. Público: mantenedores. Data: 2026-10-22. Decisão: [ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md), que substitui a [ADR 0010](docs/architecture/adr/0010-unified-dashboard.md). Estado: parcial.

### A: painel nativo e leitura por APIs normalizadas

- O iframe do agregador foi removido. A interface é única e nativa, em `http://127.0.0.1:<dashboard.port>/` (padrão 18879), com CSP `frame-src 'none'`, zero iframes, sem erros de console e sem rolagem horizontal no Chrome.
- Dados: `GET /dashboard/events` de cada gateway (janela de até 1000 eventos por processo) e o log JSON-lines `~/.jev-gateway/<cliente>.log`, lido de forma incremental (deslocamento em bytes, reinício em truncamento ou rotação, até 8 MiB por atualização, linhas acima de 64 KiB ignoradas).
- Módulos novos: `src/gateway-metrics.ts`, `src/gateway-history.ts`, `src/gateway-views.ts`, `src/gateways.ts`, e o frontend `src/dashboard-page.ts`, `src/dashboard-script.ts`, `src/dashboard-gateway-script.ts`, `src/dashboard-gateway-views-script.ts` e `src/dashboard-style.ts`. Rotas em `src/dashboard.ts`.
- `GET /gateways/status`: por cliente, estado, roteador, métricas de janela e de histórico, modelos, faixas de 15 min, 1 h, 24 h e todo o histórico, decisões recentes (até 200), comparação com e sem Jev, custo estimado e eco dos preços (só `source` e `verifiedAt`). Total combinado soma contagens; percentis não são combinados.
- Métricas ausentes são explícitas: tokens de saída do Jev não são registrados pelo upstream ("não registrado"), e chamadas evitadas só são contáveis no modo `direct`.

### B: configuração

- `dashboard.legacyRedirect` (bool, padrão `true`): define `JEV_DASHBOARD_REDIRECT` no roteador.
- `gatewayExperiment.{claude,codex}`: `default`, `shadow` (`JEV_ROUTING=true`, `JEV_SHADOW=true`) ou `metering` (`JEV_ROUTING=false`, `JEV_SHADOW=false`). Vale quando o roteador inicia; o lançador reutiliza roteador em execução.
- `observability.pricing`: preços por modelo (até 100) e preço do Jev, sem valores padrão. Cada preço tem moeda `USD`, `source` e `verifiedAt`.
- Os perfis antigos continuam válidos.

### C: auditoria de tokens (metadados dos logs)

Evidência: `.local/evidence/jev-token-audit-2026-10-22.json`, `.local/evidence/jev-token-metrics-2026-10-22.txt` e `.local/evidence/unified-dashboard-status-2026-10-22.json`. Claude de 2026-09-30 a 2026-10-22; Codex de 2026-09-22 a 2026-10-22.

- Chamadas Jev com resposta: 7.440 (Claude) + 7.065 (Codex) = 14.505 (a auditoria registrou cerca de 14.474). Erros do Jev: 598 + 408.
- Entrada enviada ao Jev: 176,2 M + 128,4 M = 304,6 M (a auditoria registrou cerca de 304 M).
- Chamadas evitadas: 0. Nenhum período sem roteamento existe nos logs, então não há evidência comparativa de economia.
- Claude: `hint` 1.167, `passthrough` 6.998. A entrada do LLM foi 2.761.186.470 tokens, dos quais 2.719.384.578 lidos do cache e 40.368.271 gravados. Entrada não descontada: 1.433.621 tokens (cerca de 1,43 M). Latência do Jev p50 426 ms, p90 551 ms.
- Codex: `forced` 3.802, `passthrough` 5.815, `none` 456. Entrada do LLM de 1.363,5 M, com 1.288,8 M do cache. Latência do Jev p50 423 ms, p90 1.121 ms.
- Bloqueio somado pela latência do Jev: cerca de 3.210 s (Claude) e 3.907 s (Codex) no período.
- Por modelo (entrada do Jev; entrada não descontada): claude-opus-5-5 137 M; 0,53 M. claude-haiku-5-5 26,4 M; 0,63 M. claude-sonnet-5-5 14,8 M; 0,35 M. claude-haiku-4-5-20251001 0,6 M; cerca de 0. gpt-6.1-sol 72,4 M; 45,15 M. gpt-6-sol 47 M; 16,13 M. gpt-6-luna 0,1 M; 2,88 M. gpt-5.6-sol 4,9 M; 2,19 M. gpt-5.6-terra 3,2 M; 1,71 M. gpt-5.6-luna 0; 6,49 M. gpt-6-astra 0,6 M; 0,17 M. A tabela por modelo foi medida minutos depois, com o log ainda crescendo; pequenas diferenças em relação aos totais vêm disso.
- Entrada do Jev por chamada: cerca de 23,7 mil (Claude) e 18,2 mil (Codex). A causa é o estado da conversa (até 60.000 caracteres) e as descrições de ferramentas (até 48.000 caracteres), não o esquema.
- Leitura do cache: 98,4% (Claude) e 94,5% (Codex).
- Custo do Jev a 0,042 USD por milhão de tokens de entrada (valor do próprio upstream, `dashboard.html:158`): cerca de 12,8 USD para 304,6 M tokens. Estimativa, não cobrança confirmada.
- Codex: a soma por modelo da entrada do Jev é 128,2 M (total 128,4 M), e a da entrada não descontada é 74,7 M (total 74,7 M).

### D: otimizações aplicadas e recomendações

- Aplicado, sem mudança de comportamento padrão: nenhum limiar nem truncamento foi alterado; o experimento por cliente usa os botões existentes (`shadow` e `metering`); a alternância do roteamento foi preservada com CSRF; a observabilidade foi adicionada.
- Não aplicado (exige decisão do usuário e dados comparativos):
  - rodar o Claude em `metering` por um período comparável, para obter a referência (o modo `hint` nunca evita uma chamada ao LLM);
  - comparar `forced` com a referência por modelo no Codex;
  - reduzir `JEV_MAX_STATE_CHARS` só depois de comparar o `shadow` com o resultado.

### E: harness e memória

- Servidor MCP da memória: 24 ferramentas em `tools/list`, cerca de 64,9 mil caracteres (37,5 mil de esquemas e 22,7 mil de descrições); estimativa de cerca de 16 mil tokens. Maiores: `memory_query` e `memory_write_page`.
- Claude Code carrega ferramentas MCP sob demanda (ToolSearch). No Codex, as requisições roteadas tinham no máximo 13 ferramentas; as 24 da memória não aparecem como declarações de nível superior, porque o MCP roda em code mode e é chamado pelo `exec` (correção 2026-10-24, validada no H5). Exposição sem mudança.
- Regras globais `~/.claude/rules/ecc`: cerca de 16,8 KB (estimativa de 4,2 mil tokens) por sessão. Lista de skills do plugin ECC presente em cada sessão, sem medição precisa. Handoff de início de sessão: cerca de 2 KB.
- Um handoff automático gravou o prompt do resumidor em vez de um resumo. Comportamento do motor, não alterado.
- Busca semântica e isolamento de projeto não mudaram.

### F: Ponytail 5.3.2 e protocolo de benchmark

- Habilitado neste projeto (`.claude/settings.json`) e na configuração global. Hooks `SessionStart` e `SubagentStart` (cerca de 3,5 KB de SKILL) e rastreador de modo em `UserPromptSubmit`. Opção de registro grava `~/.config/ponytail/band/<projeto>.csv`. Não integrado ao Jev. Sobreposição de KISS e YAGNI com `~/.claude/rules/ecc/coding-style.md`.
- Nenhuma instalação, remoção ou reconfiguração foi feita.
- Protocolo escrito, não executado: 2×2 (Jev ligado ou desligado × Ponytail ligado ou desligado) mais um braço `shadow`; mesmo conjunto de tarefas (commit fixo, pelo menos 20 por braço, ordem aleatória); mesmos modelos; sessões novas; política fixa de aquecimento de cache; métricas de entrada não descontada, cache, saída, entrada do Jev, latência, sucesso e qualidade de ferramentas. Execuções pagas exigem aprovação de orçamento; custo não estimado.
- Detalhes em [otimização de tokens](docs/guides/token-optimization.md#protocolo-de-benchmark-do-ponytail).

### G: segurança

- Token do painel legível por processo local que consegue fazer `GET /` (T1). `POST /dashboard/routing` do upstream aceita qualquer origem local e requisições sem `Origin`; código do upstream não alterado.
- `/dashboard/events` e o log do launcher são legíveis por processos da mesma conta; contêm metadados, não prompts.
- O provedor do Jev recebe, por requisição, o prompt de sistema (inclui `CLAUDE.md`, `AGENTS.md` e memória injetada), até 60.000 caracteres de estado e até 48.000 de descrições de ferramentas. Registrado em T32 e na [LGPD](docs/security/lgpd.md#transferência-a-terceiros).
- Dados de gateway, memória e MCP tratados como não confiáveis: validação estrita e `textContent`.
- Pendente: rotação de credenciais (P0-1), ainda não confirmada. Por isso, não houve testes ao vivo dependentes de credenciais, nem alternância ao vivo nos gateways do usuário.

### H: testes

- `npm test`: 394/394 na execução final. O teste `real supervisor authenticates...` (`test/lifecycle.test.ts`) falhou 2 vezes por tempo em execuções anteriores; passou 3/3 isolado e nas reexecuções completas.
- `npm run test:e2e` 4/4; `npm run test:projects` 1/1; `npm run test:semantic` 1/1. Typecheck, lint e build ok.
- Upstream (patch `JEV_DASHBOARD_REDIRECT`): 42/42 nos testes focados; suíte completa 412/415. As 3 falhas são as mesmas da linha de base (397/400), todas específicas do Windows: análise de log do opencode-coverage, permissões do arquivo de chave no setup e setup sem TTY.

### Pendências

1. **Commit** das alterações em `upstream/jev-gateway/` (o `install` recusa fontes com alterações).
2. **Reinstalar o gateway** (`jev-memory install gateway`) para o patch `JEV_DASHBOARD_REDIRECT` entrar.
3. **Reiniciar os roteadores** em execução para que a variável seja lida.
4. **Experimento de referência do Claude** em `metering`, por um período comparável. Sem isso, não há conclusão sobre economia.
5. **Preços**: preencher `observability.pricing` a partir das fontes oficiais, com `source` e `verifiedAt`. Sem preço, o custo fica não configurado.
6. **Rotação de credenciais** (P0-1).
7. **Testes ao vivo** da alternância do roteamento e dos cenários de falha de gateway, sem interromper as sessões do usuário.

Estado: parcial. O painel nativo, a configuração e a documentação estão prontos e validados nos pontos listados. O redirecionamento da página legada e a referência de custo dependem das pendências 1 a 4.

## Correção: painel original restaurado (2026-10-22)

Propósito: registrar a reversão da interface nativa do painel, a causa do erro, o que foi mantido e removido, a validação e as pendências. Público: mantenedores. Data: 2026-10-22. Decisões: [ADR 0010](docs/architecture/adr/0010-unified-dashboard.md) (mantida) e [ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md) (reescrita). Estado: aguardando aprovação.

A seção anterior, "Painel nativo único e observabilidade de tokens", descreve a variante retirada nesta correção. Fica como registro histórico.

### Causa

O pedido de trabalho dizia "uma única interface de gestão, sem painéis incorporados". Esse texto foi seguido ao pé da letra, sem confirmar contra a integração da ADR 0010, que já funcionava. O resultado recriou a interface do upstream dentro da suíte, duplicando a página original. O usuário esclareceu que o objetivo era acesso integrado aos dois painéis originais.

### Restaurado

- Um único iframe, do agregador: Codex se estiver em execução, senão Claude. URL `http://localhost:<porta>/dashboard?peers=<demais portas configuradas>`. Atributos `sandbox="allow-scripts allow-same-origin"` e `data-aggregator`.
- CSP com `frame-src` restrita às duas origens de loopback do agregador, ou `'none'` com o bloco "Gateways offline".
- Aviso para recarregar quando o agregador muda. A página não recarrega sozinha.
- Memória inalterada.

### Mantido (complementa a página original)

A página original mostra só até 1000 eventos retidos por processo. Por isso, a suíte mantém uma seção compacta, "Observabilidade de tokens (histórico do log)":

- totais do histórico por cliente e combinados, lidos do log `~/.jev-gateway/<cliente>.log` de forma incremental;
- tabela por modelo, com a chave `sentModel ?? model`;
- estimativa de custo com `observability.pricing.models` e `observability.pricing.jev` (somente estimativa);
- comparação de histórico, Com Jev × Baseline;
- o experimento configurado em `gatewayExperiment`.

Módulos mantidos: `src/gateway-metrics.ts`, `src/gateway-history.ts`, `src/gateway-views.ts` (agora só a comparação) e `src/gateways.ts` (com `aggregatorFor`, informações do roteador, histórico, modelos, custo e comparação).

Configuração mantida: `gatewayExperiment.{claude,codex}` (`default`, `shadow`, `metering`) e `observability.pricing.{models,jev}`.

`GET /gateways/status` agora tem a forma `{ ok, generatedAt, aggregator, gateways, combined, pricing }`. Cada gateway traz `client`, `label`, `port`, `portValid`, `state`, `metrics`, `router`, `history`, `historyCompare`, `cost.history`, `models.history` e `experiment`. Todas as rotas são somente `GET`.

### Removido

- A recriação nativa das visões: tabelas de janela, filtros, linha do tempo, comparação por faixa, tabela de requisições e estado do roteador.
- A rota `POST /gateways/routing`, o token CSRF e o limite de 10 chamadas em 60 s. O interruptor de roteamento fica na página original.
- Os campos de janela, requisições recentes e faixas de `/gateways/status`.
- `src/dashboard-gateway-views-script.ts`.
- A opção `dashboard.legacyRedirect` e a injeção de `JEV_DASHBOARD_REDIRECT` no lançamento.
- O patch local no `upstream/jev-gateway/`, revertido. O patch foi guardado no diretório de rascunho da sessão, não no repositório. O diretório `upstream/` está limpo, e o verificador de árvore limpa da instalação deixou de bloquear.
- `localPatches` em `upstream.sources.json`.

As páginas diretas `http://localhost:8790/dashboard` e `http://localhost:8789/dashboard` continuam acessíveis e respondem `200`, sem redirecionamento.

### Validação

Ambiente descartável, gateways reais nas portas 8789 (claude) e 8790 (codex):

- A página do painel tem exatamente um iframe: `src="http://localhost:8790/dashboard?peers=8789"`, com `data-aggregator="codex:8790"`. CSP com `frame-src http://localhost:8790 http://127.0.0.1:8790`.
- A página original foi renderizada dentro do iframe, com os dois roteadores, filtros, interruptores de roteamento, cartões e gráficos.
- Sem erros de console e sem rolagem horizontal.
- `/gateways/status` com 24,7 KB, sem segredos. `POST` retorna `405`.
- Testes: `npm test` 357/357; `npm run test:e2e` 4/4; `npm run test:projects` 1/1; `npm run test:semantic` 1/1; typecheck, lint e build ok; `npm audit` com 0 vulnerabilidades.

Nota sobre a contagem: a versão nativa terminou com 394 testes. A contagem atual é 357 porque os testes do código retirado saíram junto com ele (rota de roteamento com CSRF e limite, estado do roteador, linha do tempo, filtros por período, janela e tabela de requisições, redirect). Os testes de agregador, CSP por agregador, histórico, modelos, custo e comparação permanecem.

### Testes e checks

Em `tests.json`: `N1-embedded-dashboard` (passed), que substitui o check nativo; `N2-legacy-redirect-upstream`, `N3-routing-toggle-csrf` e `N7-redirect-deployment` como `not-applicable`, porque essas funções foram retiradas; `N4-token-observability` e `N5-per-model-metrics` passed; `N6-legacy-parity` passed, por validação da página original incorporada.

### Pendências

1. **Preços**: preencher `observability.pricing` a partir das fontes oficiais, com `source` e `verifiedAt`. Sem preço, o custo fica não configurado.
2. **Referência do Claude**: experimento em `metering` por período comparável. Sem isso, não há conclusão sobre economia.
3. **Rotação de credenciais** (P0-1), ainda não confirmada.
4. **Aprovação do usuário** para esta versão do painel. Estado: aprovada. O pedido de consolidação de 2026-10-24 a trata como o design aprovado. Conferência ao vivo antes do commit: um iframe do agregador com `sandbox` e `data-aggregator`, `frame-src` restrita ao agregador, `POST` com `405`, seção de tokens presente, rotas `/memory/*` com `200` e página original do Jev com `200`, sem redirecionamento.

Pendências da variante nativa (commit do patch, reinstalação do gateway e reinício dos roteadores) deixaram de existir, porque o patch foi retirado.

## Antigravity CLI (agy) 1.4.5: integração (2026-10-23)

Proposito: registrar a integração com o Antigravity CLI (`agy`), a validação real na CLI e os limites que permanecem. Publico: mantenedores. Data: 2026-10-23. Decisao: [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md).

### A: implementação

- Superfície `antigravity`: `clients install|remove|check antigravity [dir]` com hooks em `.agents/hooks.json` (grupo `jev-memory-suite`), `.ai-memory.toml` e `.jev-memory-antigravity.json`. Mesmo modelo transacional de Claude e Codex, com BOM tolerado na leitura e gravação sem BOM.
- MCP global em `~/.gemini/config/mcp_config.json`: `jev_memory_suite` registrado com `agy mcp add` só se ausente; recusa de nome usado por outro servidor; remoção do BOM com backup `mcp_config.json.jev-bom-<timestamp>.bak`. `clients remove` mantém a entrada global.
- Hooks usados: PreInvocation (session-start), PreToolUse, PostToolUse e Stop. Saída fixa: `allow` no PreToolUse, `{"decision":""}` no Stop, falha aberta com saída 0. `SessionStart` e `PostInvocation` não são usados.
- Launcher `jev-memory-agy` (também `jev-memory agy`): resolve o `agy`, repassa argumentos e devolve o código de saída. Finaliza ao sair as sessões do próprio lançamento (`JEV_MEMORY_AGY_LAUNCH`). Fallback manual: `jev-memory agy-finalize [--session <id>]`.
- Windows: comandos de hook sem shell, com caminho 8.3 para `node.exe`; a instalação falha com erro claro se o caminho ainda tiver espaços ou caracteres de shell.

### B: validação na CLI (agy 1.4.5, Windows 10, AI Memory 3.1.2)

- `jev-memory-agy -p`: sessão com `agent_kind` `antigravity-cli`; observações session-start, pre-tool-use, post-tool-use, stop e session-end (finalizada); zero erros de hook.
- Handoff criado com `memory_handoff_begin` numa sessão agy foi entregue na sessão seguinte; o modelo viu o marcador.
- `memory_status` pelo MCP do agy retornou o projeto correto.
- Registro em `M-agy-1` de `tests.json`.

### C: limites e pendências

- IDE e App do Antigravity **não verificados**. O arquivo de workspace é o mesmo, mas o hook só processa payloads da CLI.
- Headless (`-p`) nega ferramentas MCP sem `permissions.allow` ou `--dangerously-skip-permissions`. A suíte não altera permissões do agy.
- Finalização automática não é garantida após queda forçada do launcher; usar `agy-finalize`.
- Entrada MCP global é compartilhada entre projetos; remoção manual com `agy mcp remove jev_memory_suite`.
- Riscos de upstream: agy carrega `.agents/hooks.json` de qualquer repositório sem prompt de confiança (T33 no [modelo de ameaças](docs/security/threat-model.md)).

## Headroom fase 1 (Claude): integração (2026-10-23)

Proposito: registrar a integração opcional do Headroom (proxy externo de compressão de contexto) para o Claude, a validação real com Headroom 0.41.0 e os limites que permanecem. Publico: mantenedores. Data: 2026-10-23. Decisao: [ADR 0013](docs/architecture/adr/0013-headroom-context-compression.md).

### A: implementação

- Módulo `src/headroom.ts`: detecção pelo executável configurado (sem fallback), por `where.exe` ou `which` e por `~/.local/bin`; banner de versão exato; argumentos fixos `--mode cache --no-ccr --no-cache --no-rate-limit`; ambiente com telemetria, beacon e verificação de atualização desligados. `HEADROOM_LOSSLESS_ONLY=1` (definida pela suíte) liga o modo estrito do SmartCrusher: a compactação tabular sem perda continua, mas nenhum item de array JSON é descartado sem marcador. Sem ela, com `--no-ccr`, o SmartCrusher descartava itens sem aviso (24 → 11 no teste offline). A flag `--lossless` não serve: desliga a compactação tabular e não economizou nada.
- Supervisor: serviço opcional `headroom`, iniciado depois de `ready`. `/status` ganha `services.headroom`, `headroom` e `headroomReason`. O reinício segue a regra dos demais serviços.
- Launcher `jev-memory-claude`: usa o Headroom só depois das verificações (`ready`, porta do Jev igual à atual, `/livez`, Jev `running`). Qualquer falha antes do início do cliente leva ao caminho original, com `Headroom not used: <motivo>`. `JMS_HEADROOM=off` desvia sem efeito colateral.
- Configuração: bloco `headroom` (`enabled` false, `port` 18880, `version` 0.41.0, `executable` opcional). A validação passa a exigir cinco portas distintas. Projetos externos recebem uma quinta porta alocada.
- `doctor` mostra o bloco `headroom` e lista `headroom.port` em `conflicts` quando há coincidência.
- Teste: `test/headroom-e2e.ts`, executado por `npm run test:headroom`. Ele é pulado com o motivo quando o Headroom 0.41.0 não está instalado.

### B: validação (Windows 10, Headroom 0.41.0 via uv, Claude Code 2.1.309)

- `npm run test:headroom`: 7/7. Evidência em `.local/evidence/headroom-e2e.json`. Cobre streaming com rota `hint` do Jev; resultado reduzido de 27.817 para 11.247 bytes, com 120/120 ids e 3/3 linhas ERROR mantidas; sem `headroom_retrieve` e sem marcadores; turnos anteriores idênticos byte a byte; `cache_control` de 3 para 3; sem canário nos logs; rollback.
- Supervisor, perfil descartável (memória desligada): start `ready` em 0,32 s; Headroom pronto em 11,1 s; morte do Headroom gerou 1 reinício e voltou a `ready`, sem sair de `ready` na fase. `stop` libera a porta.
- Falhas isoladas: versão divergente (`unavailable`), executável ausente (`unavailable`) e porta ocupada (`failed`). A fase permaneceu `ready` nos três casos.
- Medições com Claude Code real, passando pelo Headroom, depois por um Jev isolado e um provedor simulado local, sem chamadas pagas: esquemas de ferramentas −337 tokens por requisição (cerca de 2,5%); Bash com 25 KB de JSON, requisição −23% e resultado −65%; resultado de 167 KB, −51% sem perda; leitura de arquivo, 0%. Números completos em [otimização de tokens](docs/guides/token-optimization.md#headroom-opcional-claude).
- Suíte: build, typecheck e lint ok; `npm test` 420/420; `npm run test:headroom` 7/7; `npm run test:e2e` 4/4; `npm run test:projects` 1/1.

### C: limites e pendências

- Codex não é suportado: com login ChatGPT, o Headroom 0.41.0 contorna o Jev. A correção exige mudança no upstream do Headroom. O Antigravity não tem integração de proxy.
- Sem fallback depois que o Claude inicia. Se o Headroom cair, o supervisor o reinicia e as requisições falham no intervalo.
- Taxa de acerto de cache e custo reais não medidos (exigem chamadas pagas). A economia por sessão é estimativa.
- Kompress não é usado (`HEADROOM_OFFLINE` bloqueia o download do modelo), e o CCR fica desligado.
- Sem `headroom.executable`, o `headroom` do PATH pode ser usado; a versão é conferida, mas não há verificação de hash (T40).
- Riscos T38 a T42 registrados no [modelo de ameaças](docs/security/threat-model.md).

## Headroom fase 2 (Codex): integração (2026-10-23)

Proposito: registrar a integração opcional do Codex com login ChatGPT pelo Headroom e pelo gateway Jev codex, com shim de runtime versionado, a validação automatizada e os limites que permanecem. Publico: mantenedores. Data: 2026-10-23. Decisao: [ADR 0014](docs/architecture/adr/0014-headroom-codex-routing.md).

### A: implementação

- Shim `patches/headroom/0.41.0/jms_headroom_shim.py`: aponta as rotas do Codex com login ChatGPT ao gateway Jev codex por atributos de módulo; nenhum arquivo do pacote é editado. Confere os quatro valores originais, faz autoteste e recusa outra versão (código 3). `--check` imprime JSON.
- Guard de egress no processo do shim: só loopback; nomes fora do loopback são recusados antes do DNS; registra `jms-egress-blocked host=<host>`.
- `patches/headroom/0.41.0/chatgpt-codex-base-url.patch`: contribuição proposta ao upstream, com a mesma variável; aplica no 0.41.0 com `patch -p1`.
- `src/headroom.ts`: detecção do interpretador (`headroom.python`, `UV_TOOL_DIR`, `uv tool dir`, `%APPDATA%\uv\tools`), verificação da versão, `checkCodexShim`, `codexShimEnv` e `headroomArgs` com `--openai-api-url` para chave de API.
- Supervisor: com `headroom.codex`, inicia o shim depois de `ready`. Falha, ou modo não saudável, volta ao modo só Claude com `headroomCodexReason`. `/status` ganha `headroom.codex` e `headroom.codexUpstreamPort`.
- Launcher `jev-memory codex`: `codex` iniciado diretamente, com as sobrescritas do provedor upstream `jev-gateway` apontando para o Headroom. Qualquer falha imprime `Headroom not used` e segue por `jev-codex`.
- `doctor`: bloco `headroom.codex` com `enabled`, `python`, `active` e `reason`.
- Configuração: `headroom.codex` (padrão `false`) e `headroom.python` (opcional, caminho absoluto).
- Correção também para o Claude: `headroomEnv` define `LITELLM_LOCAL_MODEL_COST_MAP=True`. O litellm buscava a tabela de preços em `raw.githubusercontent.com` ao ser importado, apesar de `HEADROOM_OFFLINE`. O guard detectou isso no teste E2E do Codex.

### B: validação (Windows 10, Headroom 0.41.0 via uv)

- `npm run test:headroom-codex`: 11/11, com Headroom real pelo shim, Jev codex real, backend ChatGPT simulado e JWT falso. Cobre streaming com `Authorization` e `ChatGPT-Account-ID` sem alteração; resultado de ferramenta de 27.883 para 11.430 bytes, com 120/120 ids e 3/3 linhas ERROR; prefixo idêntico; `/models` pelo Jev; caminho de chave de API; override inseguro ignorado; `api.openai.com` recusado pelo guard; WebSocket só pelo Jev; zero tentativas a chatgpt.com; sem JWT, account id, chave ou canário nos logs; `~/.headroom` inalterado; rollback.
- `test/headroom-shim.test.ts`: `--check` real, bases inválidas e cópia com versão divergente (código 3).
- Testes unitários de argumentos, ambiente, detecção, montagem do spawn e fallback.
- Não validado: login ChatGPT real, cobrança real e economia medida no Codex. Os números são de backend simulado.
- `test/codex-launch-e2e.ts` (`npm run test:codex-launch`) cobre o caminho `jev-memory codex` com Codex real. Está em desenvolvimento em tarefa separada; este registro não traz resultado dele.
- `tests.json`: check desta fase ainda não registrado; o registro cabe à sessão principal.

### C: limites e pendências

- Hooks do Codex continuam exigindo confiança nativa em `/hooks`.
- Um processo Headroom por perfil atende Claude e Codex, com cerca de 600 a 700 MB de RAM.
- O guard vale só no processo Python e não é sandbox (T44).
- Upgrade do Headroom exige nova pasta de patch e revalidação. Sem patch seguro, o Codex segue pelo caminho direto (T43).
- Contribuição ao upstream pendente. Quando a variável estiver em uma release, o shim é retirado, o que exige mudança de código na suíte.
- Antigravity não tem integração de proxy. Kompress segue desligado.
- Riscos T43 a T46 registrados no [modelo de ameaças](docs/security/threat-model.md).
- Atualização de 2026-10-24: `test:codex-launch` 10/10 (H4) e validação ao vivo com login ChatGPT (H5) registradas em `tests.json`. As linhas de B que dizem "não validado" e "em desenvolvimento" ficam como histórico.

## Headroom fase 2 (Codex): qualidade (2026-10-24)

Proposito: corrigir as afirmações sobre o MCP no Codex, validar a captura por hooks com confiança nativa e corrigir a perda silenciosa de itens de array na compressão. Publico: mantenedores. Data: 2026-10-24.

### A: mudanças

- MCP no Codex 0.163: as ferramentas MCP não são declaradas no nível superior da requisição. O runtime do `exec` (code mode) as lista em `ALL_TOOLS`, e o modelo as chama como `tools.mcp__jev_memory_suite__<ferramenta>(...)`. O comentário de `test/codex-launch-e2e.ts`, o ADR 0014, `docs/guides/clients.md`, `docs/guides/token-optimization.md` e a linha 392 deste arquivo foram corrigidos.
- `test/codex-launch-e2e.ts`:
  - Mock com código do `exec` configurável.
  - Novo passo de MCP em code mode: lista `ALL_TOOLS` e chama `memory_handoff_list`, com e sem Headroom.
  - Novo passo de captura por hooks com confiança nativa: `clients install codex`, confiança pelo app-server (`hooks/list` e `config/batchWrite`) em `CODEX_HOME` isolado e consulta das observações da sessão.
  - O marcador `.ai-memory.toml` do fixture passou a usar o texto do produto. Sem o cabeçalho, `clients install` recusa com "Scope marker conflict".
- `src/headroom.ts`: `headroomEnv` define `HEADROOM_LOSSLESS_ONLY=1`.
  - Com `--no-ccr`, o SmartCrusher descartava itens de array JSON sem marcador: 11 de 24 no teste offline, e 16 de 24 nomes de ferramenta no e2e.
  - O modo estrito mantém a compactação tabular sem perda: log de 25 KB −66% e JSON de 167 KB −67%, sem perda, como antes.
  - A flag `--lossless` foi testada e rejeitada: desliga a compactação e o resultado de ferramenta ficou sem compressão.
  - Vale também para o Claude.

### B: validação (Windows 10, Headroom 0.41.0 via uv, Codex 0.163)

- `npm test` 448/448; `test:headroom` 7/7 (resultado de ferramenta 27.817 → 11.247 bytes); `test:headroom-codex` 11/11 (27.883 → 11.430 bytes); `test:claude-launch` 7/7; `test:codex-launch` 12/12.
- MCP em code mode: 24 de 24 ferramentas de memória listadas com e sem Headroom; handoff lido pelo `exec` nos dois caminhos.
- Hooks: 7 listados, 7 `untrusted` antes e 7 `trusted` depois. Observações `session-start`, `user-prompt`, `pre-tool-use`, `post-tool-use`, `stop` e `session-end`, iguais com e sem Headroom. `--dangerously-bypass-hook-trust` não foi usado, e o hash do `~/.codex/config.toml` real não mudou.
- Sem requisições pagas.

### C: limites e pendências

- O handoff pendente não apareceu na primeira requisição do Codex, com e sem Headroom. A entrega pelo SessionStart no Codex não está comprovada. Não é efeito do Headroom e precisa de investigação separada no hook nativo ou no Codex.
- A confiança normal no projeto real do usuário (S3) continua manual, pelo `/hooks`.
- `HEADROOM_LOSSLESS_ONLY` cobre o SmartCrusher. Os outros compressores do Headroom (log, texto, código) não foram auditados quanto a perda.
- A economia ao vivo foi medida antes de `HEADROOM_LOSSLESS_ONLY`: H3 (Claude) e H5 (Codex). Nos fixtures a redução não mudou, mas ainda falta medir ao vivo com aprovação, de novo para Claude e Codex.
- Consolidação em commits (2026-10-24): não feita. As mudanças desde `05e77681` misturam vários marcos nos mesmos arquivos e linhas (`src/cli.ts`, `src/config.ts`, `src/launch.ts`, `src/supervisor.ts`, `progress.md`, `tests.json`). Separar por marco exigiria estados intermediários nunca testados.

## Jev Gateway: Antigravity via Code Assist, Marco 1 (2026-10-24)

Proposito: registrar o patch Code Assist do Jev Gateway para o Antigravity CLI (agy), a validação do tráfego do agy e a validação ao vivo com o gateway, e os limites do Marco 1. Publico: mantenedores. Data: 2026-10-24. Decisao: [ADR 0015](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md).

### A: implementação

- Patch `patches/jev-gateway/0.5.1/codeassist-agy.patch` (LF, 833 linhas, 10 arquivos) e `patches/jev-gateway/README.md`. `upstream/` não é editado.
- Jev com o patch: modo `agy` (`JEV_CLIENT=agy`) com `src/codeassist.ts` (allowlist de hosts e métodos), `src/adapters/codeassist.ts` (passthrough), `src/config.ts` (recusas e `routing=false`) e `src/app.ts` (só `/health`, `/dashboard` e `/v1internal:*`).
- Cliente `agy` em `bin/clients.mjs` e `bin/jev-agy.mjs`: porta 8794 e `CLOUD_CODE_URL`. `package.json` ganha o bin; `src/dashboard.html` lista a porta 8794 no painel do próprio Jev.
- Install da suíte (`src/install.ts`): aplica `patches/jev-gateway/<versão>/*.patch` depois da cópia e antes do `pnpm install`. O id da versão inclui o hash da tree e o nome e o sha256 dos patches. A aplicação usa `GIT_CEILING_DIRECTORIES` e `core.autocrlf=false`, com `--check`, aplicação e `--reverse --check`. O patch vira CRLF quando a cópia do upstream é CRLF.

### B: validação (agy 1.4.7, Windows 10, 2026-10-24)

- Proxy transparente: um ping real com a conta Google e cota normal. 18 chamadas `POST /v1internal:<método>`, todas com status 200; agy com código 0. Bearer repassado intacto. Confirmou o envelope de requisição e de resposta, `usageMetadata` e `thoughtSignature`. Duas gerações: `gemini-3.5-flash-lite` (119 tokens de prompt) e `gemini-3.8-flash-high` com 15 ferramentas (23.197 tokens de prompt). Detalhes em `M-agy-2`.
- Testes do Jev: 438 (435 ok), antes 400 (397 ok). São 38 testes novos em `test/codeassist.test.ts`. As 3 falhas herdadas (`setup.test.ts` 2, `opencode-coverage.test.ts` 1) também existem no gateway sem o patch, e são do upstream no Windows.
- Patch: aplica limpo em cópia LF e em cópia CRLF; typecheck e build ok.
- Suíte: typecheck e lint ok; `npm test` 462/462, com 14 testes novos de install.
- Ao vivo, com o patch: gateway numa porta efêmera, sem alterar os gateways ativos e sem `jev-memory install`. `agy -p ping` com `CLOUD_CODE_URL` saiu com 0. Duas `streamGenerateContent` passaram em passthrough, com status 200 e motivo `routing_disabled`; tokens 119/3 e 23.192/9 (prompt/saída); 15 ferramentas na segunda. Negativos 404: `POST /v1/messages`, `POST /v1beta/models/x:generateContent`, `POST /v1internal:deleteEverything` e `GET /v1internal:loadCodeAssist`. Log do gateway sem Bearer e sem o texto do prompt.
- Configuração do agy (`settings.json`, `config/mcp_config.json`, `config/config.json`) com hash idêntico antes e depois.
- Registro: `M-agy-2` (proxy transparente) e `M-agy-3` (patch e validação ao vivo) em `tests.json`.

### C: limites e pendências

- Pendências do Marco 2: `jev-memory-agy` ainda não injeta `CLOUD_CODE_URL`; o launcher `jev-agy` ainda pede a chave do Jev (`ensureKey`), mesmo sem chamar o Jev; os dashboards da suíte não mostram o gateway agy; `jev-memory install` não foi rodado, e o ponteiro do gateway ativo não mudou.
- `thoughtsTokenCount` não é contado como raciocínio pelo `usage.ts` do Jev. O custo de saída fica subestimado.
- Método Code Assist novo, fora dos 9 verificados (7 auxiliares e 2 de geração), recebe 404. Risco de o agy quebrar após atualização até a lista ser revalidada.
- `CLOUD_CODE_URL` e o protocolo `v1internal` não são documentados pelo Google. O agy se atualiza sozinho (1.4.5 para 1.4.7 em 2026-10-24).
- Formato de resposta com `functionCall` não observado: o ping não chamou ferramenta. Roteamento ativo, forced, direct e shadow ficam desligados até revisão de privacidade e nova validação com `thoughtSignature` em vários turnos.
- O painel do Jev mostra os motivos `codeassist_*` crus, e o botão de roteamento não tem efeito no modo agy.
- IDE e App do Antigravity não validados.
- Riscos T47 a T51 registrados no [modelo de ameaças](docs/security/threat-model.md).

## Jev Gateway: Antigravity via Code Assist, Marco 2 (2026-10-24)

Proposito: registrar a integração do gateway agy ao launcher e ao dashboard, o rollback do gateway, a validação real e os limites que permanecem. Publico: mantenedores. Data: 2026-10-24. Decisao: [ADR 0015](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md), itens 9 a 14 e seção "Marco 2 (2026-10-24)".

### A: implementação

- Patch v2 cumulativo `patches/jev-gateway/0.5.1/codeassist-agy.patch` (LF, 15 arquivos), que acrescenta ao v1 os itens abaixo. `upstream/` não é editado.
- Tokens (`usage.ts`): no Gemini, `output = candidatesTokenCount + thoughtsTokenCount` e `reasoning = thoughtsTokenCount`. A suíte calcula custo só por `output`, e `reasoning` é subconjunto, como no OpenAI. A regra "último relatório vence" foi mantida, sem soma entre eventos SSE cumulativos. Vale também para `jev-gemini`.
- Chave: spec `agy` com `passthroughOnly: true`; o launcher `jev-agy` não chama `ensureKey()` para esse cliente. O modo agy força `routing=false` e recusa shadow, então nunca chama o Jev. Os outros clientes continuam exigindo a chave.
- Health: no modo agy, `/health` responde `client: "agy"` e `codeAssist: 1` (`CODE_ASSIST_PATCH_VERSION`).
- Launcher `jev-memory-agy` (`agyGatewayRoute` em `src/launch.ts`, nunca lança). Ordem das checagens: `JMS_AGY_GATEWAY=off`; `CLOUD_CODE_URL` já definido (não é sobrescrito); `agy --version` em `VALIDATED_AGY_VERSIONS = ['1.4.7']`; gateway instalado com spec `agy`; porta `JEV_AGY_PORT` válida ou 8794; health (1,5 s) e, se não responder, `node <gatewayDir>/bin/jev-agy.mjs --start` com ambiente sem `UPSTREAM_API_KEY`, `ROUTER_API_KEY`, `JEV_SHADOW`, `JEV_DEBUG_DUMP_DIR`, `CLOUD_CODE_URL` e `JEV_MEMORY_AGY_LAUNCH`. O health é validado com zod e exige `pid` igual a `~/.jev-gateway/agy.pid`. Sucesso: `CLOUD_CODE_URL=http://127.0.0.1:<porta>` só no ambiente do agy, e stderr `Jev gateway: http://127.0.0.1:8794 (passthrough)`. Falha: `Jev not used: <motivo>` e agy direto no Google. Código de saída do agy inalterado; hooks, MCP e finalização inalterados. O gateway é persistente.
- Install e rollback (`src/install.ts`, `src/cli.ts`): `install gateway` imprime `{previous, current}`; `gateway-versions` lista as versões completas (mais nova primeiro, `current` marcada); `gateway-rollback <id>` valida o id (40 hexadecimais), exige versão completa dentro de `.local/engines/jev-gateway/`, troca o ponteiro com escrita atômica e não apaga nada.
- Dashboard: cliente `agy` no histórico (`~/.jev-gateway/agy.log`), nas sondas e em `/gateways/status`. Card `obs-agy` "Antigravity", com nota de passthrough e sem o bloco "Com Jev × Baseline". O combinado "Combinado (Claude + Codex + Antigravity)" soma eventos, tokens, custo e modelos dos três; a comparação com e sem Jev continua só Claude + Codex, porque os eventos do agy são todos `routing_disabled`. Sem spec agy instalado, o card fica "Indisponível" sem sondar a porta. `status` e `doctor` passam a listar o agy.
- Documentação: [clientes](docs/guides/clients.md), [operação](docs/runbooks/operations.md), [CLI](docs/api/cli.md), [modelo de ameaças](docs/security/threat-model.md) (T52 e T53).

### B: validação (agy 1.4.7, Windows 10, 2026-10-24)

- Testes: typecheck, lint e `npm test` 513/513 na suíte; build ok.
- Jev com o patch v2: 446 testes, 444 passam. As 2 falhas são pré-existentes do upstream no Windows (`opencode-coverage` ×1, `setup` ×1, modo 0600 vira 0666). O vitest foi rodado com home temporário.
- Patch v2 aplica limpo em cópia LF e em cópia CRLF.
- Install real: `jev-memory install gateway` → `{previous: 0d15e05e48151c3423a50558ede7e101d6c83ae8, current: 4e03786dda52c2aecf9012181612da717015fe62}` em cerca de 4 s. A versão nova contém `src/codeassist.ts`, `dist/codeassist.js` e `bin/jev-agy.mjs`; a versão antiga ficou intacta.
- Rollback: ida e volta (`gateway-rollback 0d15…`, depois `4e03…`) ok. Id inválido e versão inexistente recusados com exit 1.
- Gateway Claude (PID 24728, porta 8789) não foi reiniciado em nenhum momento; continua na versão 0d15… até o próximo start.
- Launcher real: `jev-memory-agy -p ping` (uma requisição na cota normal) → exit 0 e `Jev gateway: http://127.0.0.1:8794 (passthrough)`. `/health` `{status ok, client agy, codeAssist 1, upstream daily-cloudcode-pa}` com `pid` igual ao de `agy.pid`. `agy.log`: 2 `streamGenerateContent` passthrough 200, `routing_disabled`: `gemini-3.5-flash-lite` input 119 / output 3; `gemini-3.8-flash-high` com 15 ferramentas, input 23.524 / output 178 / reasoning 169. Sem Bearer nem prompt no log.
- Sessão de memória `8dbcc308-ec74-4d69-8dba-419da8e5fbf0` com `agent_kind antigravity-cli`: session-start, stop e session-end (finalizada pelo launcher). Nenhum erro de hook.
- Fallbacks reais (com `--version`, sem modelo): `JMS_AGY_GATEWAY=off` → `Jev not used: disabled by JMS_AGY_GATEWAY=off`; `JEV_AGY_PORT=8789` → `Jev not used: gateway health invalid: client, codeAssist, upstream`; `CLOUD_CODE_URL` definido → `Jev not used: CLOUD_CODE_URL already set`; gateway agy parado (`jev-agy --stop`) → relançar sobe sozinho e volta `Jev gateway: …`.
- Dashboard (snapshot do dist novo com os logs reais; supervisor em execução não reiniciado): Antigravity `running` na 8794, `experiment passthrough`, 2 chamadas, input 23.643, output 181, reasoning 169. Custo `null`, com `missing` de preço para os dois modelos Gemini. Nenhum preço foi inventado.

### C: limites, pendências e incidente

- O card do Antigravity só aparece no painel em uso depois de `jev-memory restart`, que reinicia memória e dashboard, mas não os gateways Claude e Codex.
- Claude e Codex passam à versão 4e03… no próximo start do gateway deles. O patch não muda o comportamento deles, e os testes do Jev não mostram regressão.
- Se o gateway agy cair no meio de uma sessão, as requisições do agy falham até ele voltar. Não há fallback depois que o agy iniciou.
- Versão nova do agy cai no caminho direto até revalidação (`VALIDATED_AGY_VERSIONS`).
- Roteamento ativo, forced, direct e shadow continuam desligados. Formato de `functionCall` ainda não observado.
- Modelos Gemini sem preço configurado em `observability.pricing`: custo fica `null`.
- Arquivo de rastreio `launch/agy/3b7157ea2c6c293eebf5f1658cbc460f.sessions` da sessão de teste da manhã (janela fechada no X) continua pendente. A finalização no fechamento da janela não foi tratada neste marco.
- Não medido: custo real (sem preço configurado), `functionCall`, `thoughtSignature` em vários turnos, IDE e App do Antigravity, e a resposta do dashboard com o supervisor reiniciado.
- Incidente (T53): na Tarefa A do Marco 1, o `setup.test.ts` do Jev deixou um gateway Codex de teste (PID 9804, porta 8999, código da cópia de trabalho) e sobrescreveu `~/.jev-gateway/codex.pid`. O processo foi encerrado e o `codex.pid` removido. O gateway Codex real (8790) não estava rodando. Não dá para afirmar pelo log se o teste o derrubou. Mitigação: vitest com home temporário (T53). O defeito do teste upstream continua.

## Antigravity: estabilização, Marco 3 (2026-10-24)

Proposito: registrar a recuperação de sessões do agy (fechamento da janela, dono do lançamento e recuperação automática e manual), o feed por agente, os preços Gemini com validade e base de cobrança, o veredito do roteamento ativo e o isolamento dos testes. Publico: mantenedores. Data: 2026-10-24. Decisoes: [ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md) (acréscimo), [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md) (finalização), [ADR 0015](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md) (Marco 3) e [ADR 0016](docs/architecture/adr/0016-test-isolation.md).

### A: mudanças

- **Recuperação de sessões do agy (`src/launch.ts`, `src/cli.ts`).** Cada `agyLaunch` grava `<launchId>.owner.json` (`pid`, `startedAt`, `workspace`, `project`, `cwd`; sem conteúdo) ao lado de `<launchId>.sessions`; os dois são removidos ao finalizar. Fechar a janela envia `SIGHUP`, que finaliza o próprio lançamento uma única vez, com prazo total de cerca de 7 s. A recuperação automática, antes de cada lançamento, toca só lançamentos cujo dono tem pid morto, com claim por rename e escopo gravado. Manual: `jev-memory agy-finalize --recover` (inclui escopo divergente, marcado `scope: "recorded"`) e `--recover --legacy` (também registros sem owner, com o config atual do perfil). Nunca lê outro perfil.
- **Feed por agente (`src/hook.ts`, `src/dashboard.ts`, `src/dashboard-script.ts`).** O hook grava `active-session.<agente>` além do `active-session` legado. O feed lê as sessões por agente, rotula cada item como Claude, Codex, Antigravity ou Desconhecido, a partir de `agent_kind`, e une por data.
- **Preços e base de cobrança (`src/config.ts`, `src/gateway-metrics.ts`, `src/gateways.ts`, dashboard).** Defaults verificados para `gemini-3.5-flash-lite` e `gemini-3.8-flash` (fonte e `verifiedAt` 2026-10-24). `validUntil` no `gemini-3.8-flash` (2026-12-31), com `llm-price-expired:<modelo>` depois. `observability.pricing.aliases` (padrão vazio) para equivalências assumidas. `observability.billing` por cliente (padrões `unknown`, `unknown` e `subscription` para agy). Preço do usuário se mescla aos defaults.
- **Multi-turno (fixtures isoladas, sem rede).** 4 fixtures e 32 testes em `test/codeassist-multiturn.test.ts`, com as regras de assinatura de pensamento. Veredito em [ADR 0015, Marco 3](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md#marco-3-2026-10-24): passthrough seguro; none e forced desconhecidos; direct e shadow inseguros. Roteamento ativo: NO-GO.
- **Isolamento de testes.** Jev (patch): `vitest.config.ts` e `test/isolate-home.setup.ts`, com home temporário por arquivo; `setup.test.ts` corrigido. Suíte: `scripts/test-isolated.mjs`, com home temporário, preflight e comparação de sentinelas; `--real-uv-tools` para o shim do Headroom. Auditoria: no Jev só `setup.test.ts` vazava; na suíte, `e2e.ts`, `headroom-e2e.ts`, `headroom-codex-e2e.ts` e `projects-e2e.ts` podiam tocar o home real.
- **Documentação.** ADR 0011 (acréscimo), ADR 0012 (finalização e consequências), ADR 0015 (Marco 3 e Estado), ADR 0016 (novo), modelo de ameaças (T53 corrigido; T54 e T55 novos), operação, clientes, CLI, configuração e schema, README do patch e `tests.json` (`M-agy-5` e `M-iso-1`).

### B: validação (2026-10-24)

- Suíte: typecheck, lint e build ok. `npm test` 560/560, sem skips, com 50.217 entradas sentinela do home real inalteradas. `test:e2e` 4/4 e `test:projects` 1/1, pelo wrapper. E2E de recuperação 2/2, com janela de console real: fechar com `taskkill` sem `/F` finaliza pelo SIGHUP; `taskkill /F` seguido de recuperação recupera.
- Jev com o patch: 478 testes, 476 passam. As 2 falhas são pré-existentes do Windows (`opencode-coverage` ×1, `setup` ×1, modo 0600 lido como 0666).
- Recuperação real: o registro legado `3b7157ea2c6c293eebf5f1658cbc460f`, da janela fechada de manhã, não tinha dono. `--recover` retornou `skipped: no-owner`. `--recover --legacy` retornou `recovered: [1f2d74bf-605d-483a-935d-9fa209141312]`. A sessão ficou com `ended_at` 2026-10-24T16:16:22Z e 30 observações. O diretório de lançamentos ficou vazio. O supervisor não foi reiniciado (mesmo PID).
- Custo com os defaults: `gemini-3.5-flash-lite` com 2 M de entrada (1 M delas lidas do cache) e 1 M de saída = 2,83 USD. `gemini-3.8-flash` com 3 M de entrada (1 M do cache) e 0,5 M de saída = 3,45 USD. Com a data de 2027-01-01, o `gemini-3.8-flash` fica `expired`. Esses valores batem com a convenção de que a entrada inclui o cache.
- Gateways: Claude (8789, PID 24728) e agy (8794, PID 24060) não reiniciados. `dist` reconstruído. O gateway instalado continua em `4e03786dda52c2aecf9012181612da717015fe62`; o patch atual difere dele só em testes, fixtures e config do vitest, e o runtime é igual. O próximo `jev-memory install gateway` gera uma versão nova.

### C: limites e pendências

- Validação ao vivo de none e forced: exige aprovação de chamadas de modelo e revisão de privacidade.
- `test:claude-launch`, `test:codex-launch`, `test:headroom*` e `test:semantic` não foram rodados neste marco.
- Janela estreita: um id gravado durante a finalização por SIGHUP pode se perder. A próxima recuperação só o cobre se o arquivo permanecer.
- O painel em uso só mostra rótulos e preços novos depois de `jev-memory restart`, que não foi executado.
- `~/.claude.json` teve o mtime alterado durante uma rodada. Origem provável: a própria sessão do Claude Code; não comprovada.
- Perfis antigos de teste em `.local/profiles` não foram removidos.
- IDE e App do Antigravity não verificados.
- Não medido: custo real (há preço verificado só para dois modelos, e o resultado é estimativa de preço de API), `functionCall`, `thoughtSignature` em vários turnos ao vivo e o painel com os rótulos novos em uso.

## Antigravity: finalização da estabilização (2026-10-24)

Propósito: registrar o fechamento das pendências do Marco 3 do Antigravity: recuperação de sessões com `childPid`, autofinalização por claim, limpeza do feed, custo Jev zero sem chamadas, contabilidade Gemini verificada no gateway real, garantias do repasse e as suítes que estavam sendo omitidas. Público: mantenedores. Data: 2026-10-24. Decisões: [ADR 0011](docs/architecture/adr/0011-native-dashboard-and-token-observability.md) (acréscimo), [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md) (finalização e recuperação), [ADR 0015](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md) (finalização da estabilização) e [ADR 0016](docs/architecture/adr/0016-test-isolation.md) (acréscimo).

### A: mudanças

- **Recuperação de sessões (`src/launch.ts`).** O owner `<launchId>.owner.json` ganha `childPid` opcional, gravado depois do spawn do agy. O dono é considerado vivo se o pid do wrapper ou o `childPid` estiver vivo. Motivo: `taskkill /F` no wrapper deixa o `agy.exe` filho rodando e gravando ids; antes, a recuperação finalizaria a sessão de um agy ainda ativo. Owner antigo sem `childPid` continua válido.
- **Autofinalização por claim.** A saída normal e o SIGHUP usam claim por rename (`<launch>.sessions` para `<launch>.sessions.recovering-<pid>`) em até 3 passadas. Um id anexado por hook durante a finalização vai para um novo `.sessions` e é pego na passada seguinte. Se chegar depois da última passada, fica registrado com o owner para a próxima recuperação. O `unlink` incondicional que podia perder ids foi removido. Isso fecha a janela estreita de SIGHUP registrada no Marco 3.
- **Rename bloqueado no Windows.** Para EBUSY, EPERM e EACCES (arquivo aberto por um hook), há 5 novas tentativas de 100 ms. Se persistir, o owner fica e a recuperação termina depois.
- **Isolamento de projeto inalterado.** Só o diretório do próprio perfil, escopo gravado, escopo divergente só no comando manual. O risco de pid reaproveitado continua no lado seguro (vira skip). O claim usa o launchId aleatório, então não colide com lançamento anterior.
- **Sessões antigas no feed (`src/hook.ts`, `src/dashboard.ts`, `src/dashboard-script.ts`), sem mudança de layout.** Novo `clearActiveSession`, compare-and-delete de `active-session.<agente>` e `active-session`. Ele é chamado no `session-end` de Claude e Codex (num `finally`) e depois de cada finalização bem-sucedida do agy, que não tem session-end. `readActiveSessions` ignora breadcrumbs sem atividade há mais de 12 h (`ACTIVE_SESSION_STALE_MS`, pelo mtime). No navegador, `seen` dos toasts ficou acumulativo, limitado a 2000 chaves.
- **Custo Jev zero sem chamadas (`src/gateway-metrics.ts`, `src/gateways.ts`).** Sem chamadas Jev (`calls` 0 e `inputTokens` 0), o custo Jev é 0, e nem `jev-price` nem `jev-output-tokens` entram em `missing`. O total passa a ser o custo LLM. Antes, o gateway agy (só repasse) mostrava `total: null` mesmo para `gemini-3.5-flash-lite` com preço. Vale também para o agregado. Com chamadas Jev, nada muda.
- **Correção de ambiente nas suítes.** `package.json`: `test:codex-launch` ganha `--real-uv-tools`. `baseEnv()` (`src/local.ts`) passa a repassar `UV_TOOL_DIR`. A correção vale também em produção, porque antes o supervisor ignorava um `UV_TOOL_DIR` personalizado do usuário. Detalhes no [ADR 0016](docs/architecture/adr/0016-test-isolation.md).

### B: validação (2026-10-24)

- Testes: `npm test` 577/577, sem skips, com 50.217 sentinelas do home real inalteradas. `test:e2e` 4/4, `test:projects` 1/1, `test:semantic` 1/1, `test:headroom` 7/7, `test:headroom-codex` 11/11, `test:claude-launch` 7/7 e `test:codex-launch` 12/12. E2E de recuperação com janela real 2/2. Typecheck, lint e build ok.
- Regressão encontrada e corrigida: `test:codex-launch` pulava a suíte inteira (0 testes, exit 0), porque o wrapper não via o Python do Headroom. Sem `UV_TOOL_DIR` e `--real-uv-tools`, falhava 2/12 ("Headroom python not found"). Agora passa 12/12.
- `~/.claude.json`: o Claude Code grava backups rotativos em `~/.claude/backups/.claude.json.backup.<epoch-ms>` antes de cada escrita. Comparando só os caminhos de chave entre o último backup e o arquivo atual, nas duas mudanças (13:22:10 e 15:18:21), a única chave alterada foi `promptQueueUseCount`. O arquivo não tem referência às pastas temporárias dos testes. A escrita é da sessão interativa do Claude Code.
- Contabilidade Gemini no gateway real 8794 (somente leitura de `~/.jev-gateway/agy.log` e de `/gateways/status`): 10 gerações. As somas brutas do log batem com o painel: input 209.341 (63.563 sem cache e 145.778 do cache); output 1.502, que inclui 1.012 de reasoning, sem contagem dupla. `gemini-3.8-flash-high` (8 eventos) segue sem preço (`llm-price:gemini-3.8-flash-high`). `gemini-3.5-flash-lite` (2 eventos) tem estimativa de 0,0001 USD. Billing: agy `subscription`; Claude e Codex `unknown`.
- Repasse, revisão do patch e log real: `codeAssistAdapter.toInput` sempre devolve `{skip: "codeassist_passthrough_only"}`, e `decideFor` sai antes de `decide` e `askJev`. `config.shadow` é recusado em agy, e `/router/decide` não é registrado no modo agy. Log real: 10/10 gerações `passthrough / routing_disabled`, nenhuma linha com `jev` ou `shadow`, `jev.calls` 0. O `agy.log` (5.937 bytes) não tem `Bearer`, `ya29.`, `authorization`, `contents`, `systemInstruction` nem `thoughtSignature`.
- Achado de disponibilidade: o binário do agy 1.4.7 referencia cerca de 60 métodos `v1internal:*` e o caminho `/v1internal/buildWithGooglePlugins`, com barra. A allowlist tem 9. Ver ADR 0015, seção F.

### C: limites e pendências

Pendências do Marco 3 fechadas:

- Janela de SIGHUP: fechada pelo claim com passadas e pela remoção do `unlink` incondicional. Um id que chegue depois da última passada fica para a próxima recuperação.
- Testes omitidos: `test:claude-launch`, `test:codex-launch`, `test:headroom*` e `test:semantic` foram rodados neste marco, com a correção de `UV_TOOL_DIR` e `--real-uv-tools`.
- `~/.claude.json`: fechada, com origem atribuída à sessão interativa do Claude Code.
- Feed antigo: fechado pelo corte de 12 h e pelo `clearActiveSession`. O compare-and-delete não é atômico (ver limites abaixo).

Pendências que continuam:

- Validação ao vivo de none e forced: exige aprovação de chamadas de modelo e revisão de privacidade. Roteamento ativo segue NO-GO.
- Painel com as mudanças de feed, rótulos e preços: só vale depois de `jev-memory restart`, que não foi executado. Gateways Claude (8789) e agy (8794) não foram reiniciados.
- Perfis antigos de teste em `.local/profiles` não foram removidos.
- IDE e App do Antigravity não verificados.
- Não medido: custo real, `functionCall` e `thoughtSignature` em vários turnos ao vivo.
- Allowlist de métodos (ADR 0015, F): 9 métodos contra cerca de 60 no binário. A recomendação não foi implementada e exige novo patch, reinstalação e aprovação. Até lá, `JMS_AGY_GATEWAY=off` contorna. **Fechado em 2026-10-24**, ver [compatibilidade Code Assist](#antigravity-compatibilidade-code-assist-2026-10-24).
- Riscos residuais: compare-and-delete não atômico (uma gravação de outro cliente no mesmo intervalo some do feed até o próximo hook); caminho EBUSY sem teste automatizado; session-end via `captureNative` coberto só pela função `clearActiveSession`, não de ponta a ponta; dedupe de toasts sem teste de navegador.

## Antigravity: compatibilidade Code Assist (2026-10-24)

Propósito: registrar a compatibilidade das rotas Code Assist do agy 1.4.7 com o gateway (contrato 2), os redirects e limites de URL, as travas de arquivo do Windows na recuperação e o estado da instalação. Público: mantenedores. Data: 2026-10-24. Decisões: [ADR 0015](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md#compatibilidade-code-assist-2026-10-24) (compatibilidade Code Assist), [ADR 0012](docs/architecture/adr/0012-antigravity-cli-integration.md) (travas de arquivo) e [modelo de ameaças](docs/security/threat-model.md) (T50 e T57).

### A: mudanças

- Patch `patches/jev-gateway/0.5.1/codeassist-agy.patch` regenerado com o contrato 2 (`CODE_ASSIST_PATCH_VERSION` = 2). São 25 arquivos (antes 23; entraram `src/upstream.ts` e `test/codeassist-routes.test.ts`), 2.503 linhas, 0 CR.
- Tabela de 64 rotas, com casamento por igualdade no pathname cru e verbo conferido. Duas são de geração (adaptador) e as demais são auxiliares com repasse. Os templates `proxyCommand` e `streamProxyCommand` com `**` ficam fora e respondem 404.
- Respostas sem upstream: 405 com `Allow` para verbo errado em rota conhecida, `HEAD` ou `OPTIONS`; 404 para rota desconhecida; 414 para query acima de 4096 caracteres. Nenhuma dessas linhas tem `mode`, então não entra nas métricas.
- Redirects: no modo agy, `fetch` usa `redirect: "manual"`. Qualquer 3xx do upstream vira 502 `upstream_redirect_refused`, sem `Location` nem corpo.
- Log saneado: nome do método ou primeiro segmento após `/v1internal/` (só `[A-Za-z0-9_]`, até 64 caracteres). Nunca o resto do caminho nem a query.
- Suíte (`src/launch.ts`): `AGY_CODE_ASSIST_VERSIONS = [1, 2]`. Aceita o gateway instalado (contrato 1) e o contrato 2; outros valores são recusados e o agy segue direto.
- Travas de arquivo no Windows: `finalizeAgyLaunch` e `AgyRecoveryDeps` recebem injeção `fsOps` (`rename`, `sleep`), sem mudança de produção. Testes novos: EBUSY duas vezes e depois sucesso; EBUSY sempre, mantendo arquivos e owner, com recuperação posterior; EPERM e EACCES como EBUSY; EINVAL sem retry e sem lançar; EBUSY na recuperação dando `claimed-by-other`, com recuperação posterior; exatamente 6 tentativas (1 + 5) e 5 esperas.

### B: validação (2026-10-24)

- Jev com o patch: 574 testes, 572 passam. As 2 falhas pré-existentes do Windows continuam (`opencode-coverage` ×1, `setup` 0600 ×1). `test/codeassist-routes.test.ts` tem 96 testes novos. Os quatro arquivos de Code Assist e health somam 186/186, conferidos em separado.
- Suíte: typecheck, lint e build ok. `npm test` 588/588, sem skips, com 50.217 sentinelas inalteradas. `test:e2e` 4/4, `test:projects` 1/1, `test:semantic` 1/1, `test:headroom` 7/7, `test:headroom-codex` 11/11, `test:claude-launch` 7/7, `test:codex-launch` 12/12. E2E de recuperação 2/2.
- Patch: a simulação do passo de install (`applyGatewayPatches`) em cópias LF e CRLF da fonte vendorizada aplicou nas duas, com `CODE_ASSIST_PATCH_VERSION` = 2.
- Nota de verificação: `git apply --check` passou num clone limpo do baseline com `core.autocrlf=false`. Com `core.autocrlf` ligado no checkout, a verificação falha.
- Varredura do binário: 66 regras `google.api.http` no agy 1.4.7 (55 POST e 11 GET), com cobertura de todos os métodos.
- Tráfego real no gateway 8794: 10 `streamGenerateContent` com status 200, e 1 pedido 404 `codeassist_unknown_method` com nome vazio às 17:51:38Z. O pedido é compatível com `GET /v1internal/buildWithGooglePlugins`; o log antigo não registrava caminhos com barra.
- Estado: nada instalado nem reiniciado. O gateway instalado continua `4e03786dda52c2aecf9012181612da717015fe62`; o anterior, `0d15e05e48151c3423a50558ede7e101d6c83ae8`, está preservado. O gateway agy em execução (8794, PID 24060) segue com `codeAssist: 1` e responde 404 a `buildWithGooglePlugins`. O gateway Claude (8789, PID 24728) não foi tocado. Nenhuma chamada de modelo ou de rede real.

### C: limites e pendências

Fechado nesta etapa:

- Allowlist estreita (achado da seção de finalização, ADR 0015, F): a lista de 9 métodos foi substituída pela tabela de 64 rotas do contrato 2.
- Caminho EBUSY sem teste (risco da finalização): coberto pelos testes de trava acima. Os erros são simulados por `fsOps`; o comportamento com trava real de processo no Windows não foi reproduzido.

Pendências:

- `jev-memory install gateway` e o reinício do gateway agy exigem aprovação. Até lá, o agy segue com `codeAssist: 1`, e `buildWithGooglePlugins` responde 404.
- Validação ao vivo depois da instalação, só com chamadas não-modelo (por exemplo, abrir o agy e conferir zero linhas `codeassist_unknown_method`), exige aprovação. Das rotas declaradas, só a de geração e o 404 de `buildWithGooglePlugins` foram observados em tráfego real.
- Uma atualização do agy pode declarar rotas novas. `VALIDATED_AGY_VERSIONS` continua `['1.4.7']`; rotas novas exigem repetir a varredura.
- Os métodos de chat auxiliares (`generateChat`, `streamGenerateChat`, `tabChat`, `internalAtomicAgenticChat`, `completeCode`, `generateCode`, `transformCode`) não têm contagem de tokens no painel. Se o agy gerar por algum deles, esses tokens não aparecem.
- Os templates `**` de `proxyCommand` e `streamProxyCommand` seguem bloqueados. Um recurso remoto do agy que os use não funciona pelo gateway; `JMS_AGY_GATEWAY=off` contorna.
- Roteamento ativo segue NO-GO (ADR 0015, Marco 3).

## Antigravity: endurecimento do Gateway v2 (2026-10-24)

Propósito: registrar a ativação da `53948cb9` só no gateway agy, a correção do toggle de roteamento no modo Code Assist, a regressão pós-commit e a avaliação do advisory do zod. Público: mantenedores. Data: 2026-10-24. Decisões: [ADR 0015](docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md) (endurecimento do gateway Code Assist).

### A: mudanças

- **Instalação e ativação (commit `8757339c`, local, sem push).** `jev-memory install gateway` gerou `53948cb9899f6c20e48c79e1b6d04223bbc26ca1` (anterior `4e03786dda52c2aecf9012181612da717015fe62`; `0d15e05e48151c3423a50558ede7e101d6c83ae8` também preservada). Só o gateway agy (8794) foi reiniciado, via `jev-agy --stop` da versão antiga e `jev-agy --start` da nova: PID 24060 -> 4980, `/health` com `codeAssist: 2`.
- **Achado de segurança.** No modo agy, `POST /dashboard/routing?enabled=true` respondia 200 e ligava o flag de roteamento em memória (o gateway agy roda sem `ROUTER_API_KEY`). Sem efeito prático, porque `toInput` do adaptador Code Assist sempre devolve skip, mas a garantia dependia de uma só trava. Durante a validação de 2026-10-24 o toggle foi acionado uma vez por engano no 8794 e revertido em seguida (`{"routing":false}`); o log não teve nenhuma linha com `mode` no intervalo.
- **Correção no patch (`patches/jev-gateway/0.5.1/codeassist-agy.patch`).** `src/dashboard.ts` recusa `POST /dashboard/routing` com 403 (`routing is locked off for Code Assist (agy)`) como primeira instrução quando `config.codeAssist`, sem ler query nem origin. `src/app.ts` torna o `set` do switch um no-op no modo agy (`routing = config.codeAssist ? false : enabled`) nas duas chamadas de `dashboardRoutes`. Clientes fora do agy mantêm o toggle. Patch: 26 arquivos (antes 25; entrou `src/dashboard.ts`), 2.586 linhas, 0 CR. `CODE_ASSIST_PATCH_VERSION` continua 2 (o contrato de rotas não mudou).
- **Testes novos no patch (`test/codeassist.test.ts`, describe `agy: routing switch`, 4 testes).**
  - 403 para 4 parâmetros x 3 origens com routing false depois e zero chamadas ao upstream.
  - Geração segue passthrough intacto, sem chamar o Jev, com a config real (motivo `routing_disabled`) e com routing forçado (motivo `codeassist_passthrough_only`).
  - Cliente não-agy ainda alterna o routing (200).

### B: validação (2026-10-24)

- Pós-commit, contra a `53948cb9` (só mocks locais, sem chamadas pagas): `test:claude-launch` 7/7, `test:codex-launch` 12/12, `test:headroom` 7/7, `test:headroom-codex` 11/11 e `test:semantic` 1/1. Depois da correção, nova rodada de `test:claude-launch` 7/7 e `test:codex-launch` 12/12. Durante a rodada, o gateway do teste rodou de `53948cb9…\src\index.ts` (amostra de processo). `test:codex-launch` usou a versão não commitada de `test/codex-launch-e2e.ts` do usuário.
- Suíte: `npm test` 588/588, sem skips, com 50.217 sentinelas inalteradas. Antes do commit, também build, typecheck e lint ok, `test:e2e` 4/4, `test:projects` 1/1 e E2E de recuperação 2/2.
- Jev com o patch novo: 578 testes, 576 passam (antes 574/572). As 2 falhas são as pré-existentes do Windows (`opencode-coverage` ×1, `setup` 0600 ×1). Code Assist e health: 190/190. Typecheck e build ok. `applyGatewayPatches` aplicou o patch novo em cópias LF e CRLF da fonte vendorizada.
- Gateway agy em produção (`53948cb9`), sondas sem chegar ao upstream: método desconhecido, `proxyCommand`, `agentPlugins/..`, `agentPlugins/a/b`, `/v1/messages`, `/v1beta/*` e `/router/decide` 404; verbo errado, HEAD e OPTIONS 405; query acima de 4096 caracteres 414. `GET /v1internal/buildWithGooglePlugins` sem token chegou ao upstream fixo e voltou 401 do Google (antes era 404 local). Log sem `Bearer`, `ya29.`, `authorization`, `systemInstruction` nem `thoughtSignature`.
- Compatibilidade da versão compartilhada: o gateway Claude (8789, PID 24728) roda `0d15e05…` e só muda no próximo start. Entre `0d15` e `53948cb9`, as mudanças de `app.ts`, `config.ts` e `upstream.ts` ficam atrás de `config.codeAssist`. Fora do agy, só `usage.ts` muda (pensamentos do Gemini contam como saída), o que afeta só o cliente Gemini.
- Escopo do `jev-memory restart` (não executado): para e sobe só o supervisor do perfil `default` (PID 34664), com `ai-memory.exe` (36364) e o dashboard dentro do processo. `suite.json` tem `gateway.enabled: false` (porta 18878). Os gateways 8789 (pai 10380) e 8794 (pai 37852) não são filhos do supervisor e não são afetados. `freePort` só sonda a porta e não mata processo.
- Zod (GHSA-mrhx-c7xc-m3w5, high, CVSS 7,5, CWE-770, < 4.6.6): a suíte usa `zod@4.3.6` fixado; o gateway não depende de zod (runtime só hono). Na suíte, zod valida só entradas locais (config, stdin de hook, MCP local, ai-memory local; dashboard só em 127.0.0.1 com checagem de Host). Avaliação isolada do bump para `4.6.7` exato: só `package.json` e `package-lock.json` (2 entradas do lock: raiz e `node_modules/zod`), typecheck e lint ok, mesmos resultados de teste que a base na cópia sem `.local/`, `npm audit --omit=dev` com 0 vulnerabilidades. Não aplicado.

### C: limites e pendências

- O gateway agy em execução (`53948cb9`) ainda aceita o toggle. A correção só vale depois de `jev-memory install gateway` (próximo id calculado: `8a497c5a782436f7b2e4664cc61e924f95f6f311`) e de reiniciar só o gateway agy, o que exige aprovação.
- Bump do zod para 4.6.7 proposto como mudança separada (patch de 42 linhas fora do repositório). Aplicar depois de rodar a suíte completa com `.local/`. A 4.6.7 foi publicada em 2026-10-12.
- Continuam:
  - sessão real do agy na v2 não validada;
  - `proxyCommand` e `streamProxyCommand` bloqueados;
  - métodos de chat auxiliares sem contagem de tokens;
  - card do painel só após `jev-memory restart`;
  - Claude passa para `53948cb9` (ou a próxima) no próximo start;
  - roteamento ativo do AGY segue NO-GO.
