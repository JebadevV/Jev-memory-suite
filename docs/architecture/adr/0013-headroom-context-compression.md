# ADR 0013 — Headroom: compressão de contexto opcional para o Claude, antes do Jev Gateway

Propósito: registrar por que o Headroom entra como processo externo opcional, somente para o Claude, na cadeia Claude → Headroom → Jev Gateway; como ele é localizado, lançado e isolado; e quais limites permanecem. Público: mantenedores e revisores de segurança. Data: 2026-10-24. Estado: aceito (fase 1, somente Claude, com Headroom 0.41.0 fixado).

> **Atualização (2026-10-23):** a fase 2 estende a decisão ao Codex, com um shim de runtime versionado para o Headroom 0.41.0. Ver [ADR 0014](0014-headroom-codex-routing.md). Este texto descreve a fase 1 e não foi reescrito; onde ele diz que o Codex não é coberto, vale a ADR 0014 a partir da fase 2.

## Contexto

O Headroom é um proxy de compressão de contexto, com licença Apache-2.0, escrito em Python com núcleo em Rust. Ele roda como processo separado e comprime conteúdo antes de encaminhá-lo ao upstream. A suíte não o incorpora: não o vendoriza, não o redistribui e não o modifica. O operador o instala por fora, com uv, e a suíte apenas o localiza e o executa.

O motivo é o volume de saída de ferramentas. Sessões do Claude Code enviam resultados grandes de Bash, MCP e logs, e boa parte desse conteúdo é JSON. A compressão atua sobre esse conteúdo sem alterar o prompt de sistema nem as mensagens anteriores.

Três fatos moldam a decisão:

- A compressão só reduz custo se acontecer antes do Jev Gateway e do provedor. Por isso a cadeia é Claude Code → Headroom → gateway Jev do claude (porta `JEV_CLAUDE_PORT`, padrão 8789) → Anthropic. O Jev não muda.
- Com login ChatGPT, o Headroom 0.41.0 envia `/responses`, `/responses/*`, WebSocket e `/models` direto a chatgpt.com, sem passar pelo Jev (`providers/codex/runtime.py`, linhas 68-76, e `proxy/handlers/openai.py`, linha 6021, no código do próprio Headroom). Corrigir isso exige mudança no upstream do Headroom. Por isso a fase 1 cobre só o Claude. O Antigravity não tem integração de proxy.
- Os padrões do Headroom conflitam com a suíte. Ele injeta a ferramenta `headroom_retrieve`, que o Jev veria no inventário de ferramentas; faz cache semântico de respostas; e limita a 60 requisições por minuto, o que travaria o Claude Code. Cada um precisa ser desligado de forma explícita.

## Decisão

1. **Opt-in, desligado por padrão.** `headroom.enabled` começa como `false`. Com a chave desligada, `jev-memory-claude` segue o caminho original, sem alteração. Campos em [schema de configuração](../../api/configuration-schema.md).
2. **Versão fixada e exata.** `headroom.version` tem padrão `0.41.0`. A detecção aceita somente o banner `headroom, version X.Y.Z` de `headroom --version`, com a versão igual à configurada. Outra versão, mesmo mais nova, é recusada.
3. **Localização sem fallback silencioso.** Se `headroom.executable` estiver configurado, ele é o único caminho considerado, e precisa ser absoluto. Sem ele, a ordem é `where.exe headroom.exe` (ou `which headroom` fora do Windows) e, por último, `~/.local/bin`, onde o uv instala por padrão.
4. **Serviço opcional do supervisor.** O Headroom é iniciado em segundo plano, somente depois de a fase ficar `ready`. Falhas viram estado do serviço (`unavailable` ou `failed`) com `headroomReason`. Não alteram a fase nem a memória. A recuperação segue a regra dos demais serviços: no máximo 3 reinícios em 60 s, após `ready`.
5. **Argumentos fixos.** `proxy --host 127.0.0.1 --port <headroom.port> --mode cache --no-ccr --no-cache --no-rate-limit --anthropic-api-url http://127.0.0.1:<porta do Jev claude> --log-file <perfil>/logs/headroom-requests.jsonl`. Cada flag tem uma razão:
   - `--mode cache` mantém os turnos anteriores byte a byte, para que o cache de prefixo do provedor continue acertando;
   - `--no-ccr` não injeta `headroom_retrieve` e não emite marcadores de recuperação;
   - `--no-cache` desliga o cache semântico de respostas, para que toda requisição chegue ao Jev e ao provedor;
   - `--no-rate-limit` evita o limite padrão de 60 requisições por minuto;
   - `--log-messages` nunca é usado.
6. **Ambiente controlado.** O ambiente parte da allowlist de `baseEnv()`. Variáveis `HEADROOM_*`, `DO_NOT_TRACK` e `HF_HUB_OFFLINE` herdadas são removidas. Depois, a suíte define `HEADROOM_OFFLINE=1`, `HEADROOM_BEACON=off`, `HEADROOM_TELEMETRY=off`, `HEADROOM_UPDATE_CHECK=off`, `HEADROOM_LOSSLESS_ONLY=1` (modo estrito do SmartCrusher, abaixo), `DO_NOT_TRACK=1`, `HF_HUB_OFFLINE=1` e `HEADROOM_UPSTREAM_ALLOWED_HOSTS=127.0.0.1`. `HEADROOM_LOSSLESS_ONLY=1` (definida pela suíte) liga o modo estrito do SmartCrusher: a compactação tabular sem perda continua, mas nenhum item de array JSON é descartado sem marcador. Sem ela, com `--no-ccr`, o SmartCrusher descartava itens sem aviso (24 → 11 no teste offline). A flag `--lossless` não serve: desliga a compactação tabular e não economizou nada. `HEADROOM_WORKSPACE_DIR` e `HEADROOM_CONFIG_DIR` apontam para dentro do perfil, e `PYTHONIOENCODING` e `PYTHONUTF8` são fixados em UTF-8.
7. **Rota no launcher, com fallback antes do cliente iniciar.** Em `jev-memory-claude` (ou `jev-memory claude`), com `headroom.enabled` e sem opção do launcher:
   - `JMS_HEADROOM=off` desvia antes de qualquer ação, sem efeito colateral;
   - senão, garante o supervisor e executa `jev-claude --start`. Esse comando reaproveita um gateway em execução e nunca o reinicia; a entrada padrão é herdada, para que o prompt de chave da primeira execução funcione;
   - espera até 60 s enquanto o Headroom está `starting` ou `restarting`;
   - usa o Headroom somente se ele estiver `ready`, com `upstreamPort` igual à porta atual do Jev claude, `/livez` respondendo e `/health` do Jev em `running`;
   - então inicia o `claude` diretamente, com o mesmo argv e o mesmo ambiente do launcher, trocando apenas `ANTHROPIC_BASE_URL` por `http://127.0.0.1:<headroom.port>`;
   - qualquer verificação que falhe imprime `Headroom not used: <motivo>; launching through jev-claude.` e segue o caminho original.
   - As opções do launcher (`--status`, `--stop`, `--start` e as demais) não passam pelo Headroom e seguem sem alteração.
8. **Sem mudança no Jev.** O upstream do Jev não muda, então o gateway não é reiniciado. Trocar `JEV_CLAUDE_PORT` exige reiniciar o perfil; a divergência de porta cai no fallback.

## Alternativas rejeitadas

- **Vendorizar, usar subtree ou submodule.** O núcleo tem cerca de 240 mil linhas de Python e Rust, o ambiente ocupa cerca de 1,8 GB, e o upstream está em reescrita ativa. Manter uma cópia exigiria acompanhar essa reescrita.
- **`headroom wrap claude`.** Grava MCP (Serena) e configurações em `~/.claude.json` e no settings do Claude. Isso conflita com o registro transacional da [ADR 0003](0003-transactional-client-registration.md).
- **Arquitetura B (Jev antes do Headroom).** Não escolhida. A compressão precisa ocorrer antes do Jev e do provedor, e a arquitetura A é a que foi validada.
- **Bloquear o start do supervisor até o Headroom ficar pronto.** Poderia estourar o tempo de start e derrubar a memória junto. Por isso o Headroom sobe depois de `ready`.
- **Codex pelo Headroom, com patch no upstream.** Não aprovado. Exigiria manter uma modificação de projeto externo.

## Consequências

- O ganho depende do conteúdo da sessão. Saídas de ferramenta em JSON, MCP e logs são comprimidas. Leitura de arquivo e `cat` não são: o Headroom protege leituras por desenho. Sessões dominadas por Read e Edit têm economia pequena. Estimativa, não medida: cerca de 0 a 5% nessas sessões e 20 a 50% nas de JSON, MCP ou log intenso.
- Custo: entre 3 e 50 ms por requisição com o processo aquecido. A primeira requisição leva de 0,3 a 0,5 s, e a primeira fria, 4,4 s. O Headroom usa de 420 a 585 MB de RAM; o Jev, 61 MB.
- Não há fallback durante a sessão. Se o Headroom cair depois que o Claude iniciou, o supervisor o reinicia (até 3 vezes em 60 s), e as requisições falham nesse intervalo.
- Trocar a versão fixada é decisão deliberada: exige rodar `npm run test:headroom` com a nova versão antes de alterar `headroom.version`.
- Codex e Antigravity não são cobertos. Nesta fase, `launch claude`, que usa o gateway da suíte, também não passa pelo Headroom.
- Taxa de acerto de cache e custo reais no provedor não foram medidos.

## Segurança

Riscos registrados em [T38 a T42](../../security/threat-model.md):

- **T38:** o processo do Headroom vê prompts e o bearer OAuth do Claude na memória, com o mesmo nível de confiança do Jev Gateway. Escuta só em loopback, repassa o `Authorization` sem alteração e não adiciona cabeçalhos `x-headroom-*`.
- **T39:** telemetria ou tráfego de saída. Mitigado pelo ambiente `OFFLINE`, pelos desligamentos de beacon, telemetria e verificação de atualização, e pelo host permitido somente `127.0.0.1`. O Kompress, que baixaria modelo, não é usado.
- **T40:** executável escolhido pelo PATH. Mitigado pela versão exata e pelo caminho absoluto recomendado em `headroom.executable`. Não há verificação de hash ou assinatura.
- **T41:** conteúdo em log. Sem `--log-messages`, o JSONL de requisições guarda só metadados, e o supervisor redige segredos conhecidos e os padrões `Bearer` e `sk-` em `logs/headroom.log`.
- **T42:** mudança de comportamento no upstream. Versão exata e teste E2E que verifica a forma das requisições, a compressão sem perda e o prefixo de cache.

## Validação

Dados de 2026-10-23: Windows 10, Headroom 0.41.0 instalado com uv em `~/.local/bin/headroom.exe`, Claude Code 2.1.309.

- **`npm run test:headroom`:** 7/7. Cobre chamada de ferramenta em streaming com rota `hint` do Jev; resultado de ferramenta reduzido de 27.817 para 11.247 bytes, com 120/120 ids e 3/3 linhas ERROR mantidas, sem `headroom_retrieve` e sem marcadores; sistema e mensagens do turno 1 idênticos byte a byte, com `cache_control` de 3 para 3; `Authorization` repassado sem alteração, sem cabeçalhos `x-headroom-*` e sem canário nos logs do Headroom; requisição sem streaming; estado somente no perfil, com `~/.headroom` inalterado; rollback, com recusa quando o Headroom está parado. Evidência: `.local/evidence/headroom-e2e.json`.
- **Supervisor, perfil descartável (memória desligada):** start em 0,32 s; Headroom pronto em 11,1 s; `doctor` mostra a detecção. Com o Headroom morto, houve 1 reinício e o serviço voltou a `ready`, sem que a fase saísse de `ready`. `stop` deixa a porta recusando conexão.
- **Isolamento de falhas:** versão divergente resulta em `unavailable` ("Headroom 0.41.0 found; this profile requires 0.40.0"); executável ausente, em `unavailable`; porta ocupada, em `failed` ("Headroom port is in use"). A fase permaneceu `ready` nos três casos.
- **Medições com Claude Code real (login OAuth), passando pelo Headroom e depois por um Jev isolado e um provedor simulado local, sem chamadas pagas:**
  - esquemas de ferramentas: −337 tokens por requisição (cerca de 2,5%), por remover `$schema` e colapsar quebras de linha nas descrições; prompt de sistema e mensagens não mudam;
  - leitura de arquivo e `cat` pelo Bash: não comprimidos (0%);
  - comando Bash que imprime 25 KB de JSON: requisição −23% (23.249 para 17.910 tokens estimados), resultado da ferramenta −65%, com as 120 linhas e as 3 linhas ERROR mantidas (JSON recodificado como tabela);
  - resultado de ferramenta de 167 KB enviado direto: 73.826 para 36.251 tokens (−51%), 800/800 linhas mantidas, sem perda;
  - o Claude Code trunca saídas grandes de Bash (cerca de 30 mil caracteres); o texto truncado não é JSON válido e não é comprimido;
  - decisão do Jev: cerca de −0,5% de tokens, porque o Jev já limita cada mensagem a 4.000 caracteres;
  - `--lossless` não economizou nada nesses testes, e `--mode cache --no-ccr` economizou o mesmo que o modo CCR padrão.
- **Suíte:** build, typecheck e lint ok; `npm test` 420/420; `npm run test:headroom` 7/7; `npm run test:e2e` 4/4; `npm run test:projects` 1/1.

Não medidos: taxa de acerto de cache e custo reais do provedor, que exigiriam chamadas pagas.

Registro: [progress.md](../../../progress.md), seção "Headroom fase 1 (Claude): integração (2026-10-23)", e check `H1-headroom-claude` em [tests.json](../../../tests.json). Procedimentos: [otimização de tokens](../../guides/token-optimization.md#headroom-opcional-claude) e [operação](../../runbooks/operations.md#headroom-claude).
