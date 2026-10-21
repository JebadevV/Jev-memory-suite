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

## M7: pending

Documentacao e revisao final de seguranca.

## Evidencias registradas

- M0-executor: passed. Correct workspace, read/write OK, existing Git main without commits, no ownership or sandbox error
- M1-scaffold: passed. All required files and documentation directories exist; test register parsed
- M2-subtrees: passed. Both imported trees exactly match their source commits; MIT licenses preserved; no submodules
- M3-1792601561819: passed. AI Memory fonte fixada compilada em 3m45s; Jev instalado e compilado localmente; 3 testes passaram, incluindo supervisor real, autenticacao e preservacao de listener externo. AI Memory iniciou autenticado em loopback. Teste inicial de listener travou e foi corrigido; nova execucao aprovada. Atualizacao subtree implementada, nao executada para manter commits fixados.
- M4-1792609191317: passed. Hook aceita raiz canonica e descendentes, rejeita escapes/junctions/payload invalido antes da config; schemas por evento, limites de stdin/stdout e profundidade; MCP limitado a 4 MB durante leitura; instalacao versionada imutavel (arvores c146869/0d15e05 iguais aos commits upstream) com ponteiro atomico, sem sobrescrever exe em uso; registro de clientes transacional com preflight, backup, rollback testado, propriedade por perfil e preservacao de MCPs/hooks; launch gera configuracao por perfil e recusa registro de outro perfil; testes de clientes independentes do perfil default. 42 testes passaram. Captura real e clientes reais ficam para M5/M6.
- M5-1792609613105: passed. A: supervisor 401 sem token, gateway 401 sem chave, rota 200 com x-jev-gateway-mode=forced/tool=get_synthetic_weather, upstream recebeu so a chave do upstream, Jev consultado; memoria fechada. B: MCP 401 sem bearer, handshake, 24 ferramentas, memory_status com escopo explicito, pagina sintetica escrita/consultada/lida, captura real via dist/src/hook.js + binario ai-memory recuperada, persistencia apos stop/start; gateway fechado. C: ambos prontos, rota e MCP ok. D: services {}, portas fechadas, MCP rejeitado, launch sem flags. LIMITACAO: Jev (mock-jev.mjs upstream) e provedor OpenAI simulados em loopback; nao comprova provedor real. Hooks acionados com payload sintetico; captura por cliente real fica em M6. Evidencias .local/evidence/e2e-*.json
- M6-1792610836049: partial. Claude Code CLI APROVADO: MCP conectado, 5 hooks reais exit 0, 7 observacoes capturadas, token recuperado, persistencia apos restart, recuperacao por nova sessao (2 defeitos do launch corrigidos). Codex CLI PARCIAL: MCP memory_status/memory_query reais e recuperacao cruzada da sessao do Claude; captura por hooks PENDENTE de confianca nativa (/hooks). Codex Desktop PENDENTE: exige uso no app. Upstream: gateway typecheck ok, vitest 397/400 (3 falhas Windows launcher/setup); AI Memory fmt ok, 956/957 (falha router mid_session_out_of_tree, causa provavel TEMP dentro do checkout, nao verificada). Evidencias .local/evidence/M6-*.

## Clientes

- claudeCli: passed
- codexCli: partial (MCP passed; hook capture pending native trust)
- codexDesktop: pending (requires validation inside the app)
