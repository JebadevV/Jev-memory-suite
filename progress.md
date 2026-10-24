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
