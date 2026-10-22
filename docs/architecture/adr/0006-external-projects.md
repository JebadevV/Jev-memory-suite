# ADR 0006 — instalação independente dos projetos

Propósito: registrar a seleção de projetos externos e o isolamento da memória. Público: mantenedores e revisores de segurança. Data: 2026-10-21. Estado: aceito.

## Contexto

As fronteiras descritas em [0001](0001-engines-and-boundaries.md) e [0004](0004-hook-boundary-and-capture-allowlist.md) foram implementadas usando a instalação da suíte como raiz de trabalho. O produto precisa iniciar Codex e Claude em qualquer projeto, preservando a instalação e os outros projetos. Este ADR substitui apenas a interpretação de workspace como pasta da instalação nesses registros.

## Decisão

- Launchers usam a pasta atual ou `--dir` como diretório do cliente. Argumentos nativos continuam sendo vetores, com `shell: false`.
- Para projetos externos, a raiz Git (ou a pasta selecionada sem Git) e o perfil base identificam um perfil estável por hash. Configuração, SQLite, tokens e serviços de memória são independentes por projeto e permanecem em `.local/profiles/` da instalação.
- O campo opcional `projectRoot` registra a fronteira canônica. Perfis sem esse campo mantêm a fronteira anterior para compatibilidade. `assertLocal` continua restringindo gravações internas da suíte à instalação.
- O registro de clientes permanece explícito e transacional. Leituras, gravações, backups e rollback de arquivos de cliente ficam dentro do projeto selecionado, com rejeição de links/junctions e preservação de entradas alheias.
- Hooks validam agente/evento/schema antes de ler configuração; depois verificam `cwd` dentro de `projectRoot`. O marcador mais próximo dentro da fronteira precisa declarar o workspace/projeto do perfil, tanto no lançamento quanto em cada captura. Sem marcador, o hook não captura.
- Novos perfis recebem portas locais disponíveis e distintas das portas de outros perfis persistidos. Um lock na instalação serializa a criação entre clientes. Um lock deixado por interrupção é informado como ocupado; ele não é removido automaticamente.
- Launchers upstream do Jev continuam compartilhados por cliente e recebem `HOST=127.0.0.1`. Os motores upstream não são alterados. A descoberta do executável Codex no Windows também aceita a instalação local do Desktop, sem alterar PATH global; isso não comprova integração no app.

## Consequências e validação

Mover um projeto gera outro perfil e preserva a memória anterior. Pastas homônimas têm perfis diferentes; subpastas de um mesmo repositório Git usam o mesmo perfil. Registrar arquivos em uma subpasta habilita hooks onde o marcador é encontrado; registre na raiz para cobrir todo o projeto.

`npm run test:projects` valida pastas externas, CLIs reais com `--version`, processos reais de memória, captura sintética por hook nativo, isolamento e persistência após reinício. O Gateway é simulado apenas no endpoint de saúde durante a execução dos launchers upstream. Captura interativa do Codex, roteamento real em projeto externo e Desktop não são certificados por esse teste.

Procedimento: [projetos externos](../../guides/external-projects.md). Estado verificável: [tests.json](../../../tests.json).
