# Progresso

Proposito: acompanhar marcos verificaveis. Publico: mantenedores. Data: 2026-10-21.

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
