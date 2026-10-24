# ADR 0009 — dono duplo do Gateway, sonda de portas upstream e reinício limitado

Atualização 2026-10-22: o painel incorporado da [ADR 0010](0010-unified-dashboard.md) foi mantido e complementado pela [ADR 0011](0011-native-dashboard-and-token-observability.md), que acrescenta a observabilidade de tokens. Esta decisão não foi reescrita.

Propósito: registrar quem é dono de cada Gateway Jev, como a suíte descobre e sonda as portas dos gateways upstream e até onde o supervisor reinicia um serviço que cai. Público: mantenedores e revisores de segurança. Data: 2026-10-22. Estado: aceito.

## Contexto

Existem dois donos possíveis para o Jev Gateway no mesmo computador:

- **Launcher upstream** (`jev-codex` e `jev-claude`, da instalação do Jev Gateway). Ele sobe um gateway destacado por cliente: `codex` na porta 8790 (`JEV_CODEX_PORT`) e `claude` na porta 8789 (`JEV_CLAUDE_PORT`). O PID fica em `~/.jev-gateway`, e `--stop` encerra o processo. Este é o caminho padrão de `jev-memory-codex` e `jev-memory-claude`.
- **Supervisor da suíte.** Só possui um gateway quando `gateway.enabled` está ligado. O padrão é desligado, a porta é 18878, e o caminho usado por `jev-memory launch`.

Os dois não rodam para o mesmo perfil, porque `jevLaunch` recusa o lançamento quando o gateway da suíte está habilitado (`src/launch.ts`). Mesmo assim, a arquitetura não dizia isso de forma explícita, e três problemas apareceram:

- O painel incorporava `http://localhost:8790/dashboard` fixo, sem olhar a porta configurada do cliente.
- `doctor` não mostrava o estado dos gateways upstream e não detectava conflito entre uma porta de perfil e a porta de um gateway upstream.
- O supervisor não reiniciava um filho que caía depois de pronto. Ele passava a `failed` e o operador precisava agir sem nenhum diagnóstico no `/status`.

## Decisão

1. **Dono duplo mantido e explícito.** O gateway upstream continua com o launcher: quem o inicia, para (`--stop`) e reinicia é o `jev-codex` ou o `jev-claude`. A suíte não inicia, não encerra e não mata esse processo. Ela só o consulta.
2. **Descoberta e sonda em `src/gateways.ts`.**
   - `upstreamGateways()` lê `portEnv` e a porta padrão da instalação upstream instalada (`bin/clients.mjs`). Se a especificação estiver ausente ou ilegível, usa 8789 e 8790 com `source: 'fallback'`, e o `doctor` informa a origem.
   - Uma variável de porta só é aceita como decimal entre 1024 e 65535. Valor inválido gera `portValid: false` e a suíte usa a porta padrão.
   - `probeGateway()` espelha a sonda `/health` do launcher. Aceita apenas origens `127.0.0.1` e `localhost`, bloqueia redirecionamento (`redirect: 'error'`), tem timeout de 1 s e retorna um de três estados: `running`, `stopped` ou `unavailable`. Não devolve texto de erro. A URL do upstream é exibida sem credenciais, query e fragmento.
3. **Painel sem porta fixa.** O painel tem um iframe rotulado por cliente (claude e codex), montado a partir de `upstreamGateways()`. A CSP `frame-src` lista exatamente essas origens, nas formas `localhost` e `127.0.0.1`. `jev-memory start` repassa `JEV_CODEX_PORT` e `JEV_CLAUDE_PORT` ao supervisor somente quando são válidos (`src/lifecycle.ts`).
4. **Diagnóstico e portas.** `doctor` inclui `gateways.claude` e `gateways.codex`, com `portEnv`, `port`, `portValid`, `source`, `state` e, quando conhecidos, `pid` e `upstream`. Também inclui `conflicts`, com as portas de perfil iguais a uma porta de gateway upstream. `availablePorts` em `src/projects.ts` exclui as portas upstream ao escolher portas para um perfil novo.
5. **Reinício limitado no supervisor** (`src/supervisor.ts`, função pura `restartDelay`).
   - Um serviço que sai depois de ter ficado `ready` é reiniciado até 3 vezes em uma janela de 60 s, com backoff de 1 s, 2 s e 4 s. Antes de reiniciar, o supervisor confere a porta.
   - Durante a espera, `/status` mostra `services[nome] = 'restarting'` e o mapa `restarts` conta as tentativas.
   - Um serviço que falha antes do primeiro `ready` mantém o comportamento anterior: falha de inicialização encerra o supervisor.
   - Esgotado o orçamento, a fase vai para `failed` e o supervisor encerra limpo. O próximo `jev-memory-codex|claude` (por `ensureServicesReady`) ou `jev-memory start` sobe os serviços de novo.

## Consequências

- A parada do gateway upstream continua com o launcher. Um gateway upstream órfão pode existir sem supervisão da suíte até um `--stop` ou uma reinicialização do usuário. Esse é o risco residual principal desta decisão.
- O reinício limitado contém quedas transitórias. Ele não corrige uma causa que derruba o serviço de forma repetida: depois de `failed`, o operador precisa ler os logs antes de iniciar de novo.
- A sonda diz apenas `running`, `stopped` ou `unavailable`. `unavailable` não distingue um processo parado de uma porta ocupada por outro processo. A distinção exige olhar o launcher upstream e os logs.
- A porta padrão de fallback (8789 e 8790) pode ficar desatualizada se o formato da especificação upstream mudar. Por isso o `doctor` mostra `source`.
- Nenhuma dessas mudanças altera os motores em `upstream/`.

## Alternativas rejeitadas

- **Supervisor assumir o gateway upstream.** Duplicaria o launcher e tiraria do operador o `--stop` já conhecido. Também mudaria o lançamento padrão, que é do upstream.
- **Porta fixa no painel.** Quebra quando o cliente usa outra porta. A descoberta a partir da instalação resolve isso sem configuração extra.
- **Reinício infinito ou com backoff longo.** Esconde uma falha repetida e deixa o perfil em estado ambíguo. O limite de 3 tentativas em 60 s torna a falha visível.

## Validação

Medido em perfil descartável, com processos reais (2026-10-22):

- `kill` em `ai-memory serve`: `restarting` em cerca de 0,5 s, `starting` em cerca de 1,3 s, `ready` em cerca de 2,0 s, `restarts: 1`. Os kills 2 e 3 também se recuperaram (`restarts: 2` e `3`). O quarto kill levou a `failed`, e o supervisor encerrou. Um `start` depois voltou a `ready`.
- `doctor` com as portas padrão: claude na porta 8789 em `running`, com `pid` e `upstream` `https://api.anthropic.com/v1`; codex na porta 8790 em `running`, com `upstream` `https://chatgpt.com/backend-api/codex`; `conflicts: []`. Com `JEV_CODEX_PORT=19790`, o codex reportou a porta 19790 em `stopped`.
- Testes: `test/gateways.test.ts` e `test/supervisor.test.ts`, incluídos na execução de `npm test` (197/197). Detalhes em [progress.md](../../../progress.md), Marco de estabilização 3.

Procedimentos de operação: [runbook de operação](../../runbooks/operations.md#recuperação-automática). Modelo de ameaças: [T29](../../security/threat-model.md).
