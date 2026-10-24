# ADR 0014 — Headroom para o Codex: roteamento pelo gateway Jev codex, com shim de runtime versionado

Propósito: registrar por que o Codex com login ChatGPT pode passar pelo Headroom por um shim de runtime versionado, que aponta o tráfego ao gateway Jev codex; como o shim é executado, verificado e isolado; como o launcher monta a rota; e quais limites permanecem. Público: mantenedores e revisores de segurança. Data: 2026-10-24. Estado: aceito (fase 2, Codex, com Headroom 0.41.0 fixado). Complementa a [ADR 0013](0013-headroom-context-compression.md), que cobre a fase 1 (somente Claude).

## Contexto

A fase 1 ([ADR 0013](0013-headroom-context-compression.md)) cobre só o Claude, porque o Headroom 0.41.0 envia o tráfego do Codex com login ChatGPT direto a chatgpt.com, sem passar pelo Jev. As rotas afetadas são `/responses`, `/responses/*`, WebSocket, `/models` e o passthrough. A origem está no próprio código do Headroom: `providers/codex/runtime.py`, linhas 68-76, `proxy/handlers/openai.py`, linha 6021, as constantes de `endpoints.py` e a constante importada em `proxy_targets.py`.

Três fatos moldam a decisão:

- A compressão só reduz custo se ocorrer antes do Jev Gateway e do provedor. A cadeia do Codex é, portanto, Codex → Headroom → gateway Jev codex (`JEV_CODEX_PORT`, padrão 8790) → backend ChatGPT ou OpenAI. O Jev não muda.
- Com a rota padrão, o Jev não vê nem contabiliza essas requisições, e o painel e o `doctor` ficariam incompletos.
- O upstream do Headroom não tem opção de destino para essas rotas. Uma correção existe como proposta (`patches/headroom/0.41.0/chatgpt-codex-base-url.patch`), mas não há release com ela.

## Decisão

1. **Opt-in dentro do bloco `headroom`.** `headroom.codex` tem padrão `false` e só vale com `headroom.enabled: true`. `headroom.python` é opcional e deve ser caminho absoluto. Sem `headroom.codex`, o comportamento do Claude e do Codex não muda. Campos em [schema de configuração](../../api/configuration-schema.md).

2. **Shim versionado, sem editar a instalação.** `patches/headroom/0.41.0/jms_headroom_shim.py` roda com o interpretador do próprio Headroom, o do ambiente uv que contém `headroom-ai`, com `-I`: `<uv tool dir>/headroom-ai/Scripts/python.exe -I jms_headroom_shim.py proxy ...`. Ele:
   - lê `HEADROOM_CHATGPT_CODEX_BASE_URL`, que precisa ser exatamente `http://127.0.0.1:<porta>/v1`;
   - confere que os quatro atributos originais têm os valores esperados para a versão 0.41.0, e recusa código diferente;
   - reatribui `endpoints.CHATGPT_BACKEND_API_URL`, `endpoints.CHATGPT_BACKEND_WS_URL`, `endpoints.CODEX_BACKEND_PREFIX` e `proxy_targets.CHATGPT_BACKEND_API_URL`, apenas como atributos de módulo na memória do processo;
   - faz autoteste das URLs resultantes e varre as strings dos módulos `headroom.*` procurando `chatgpt.com`, com uma exceção para um módulo de consulta de cota.

   Nenhum arquivo do pacote instalado é alterado.

3. **Recusa de versão.** O shim só executa a versão `SUPPORTED_VERSION` (0.41.0). Qualquer outra sai com código 3. A regra de manutenção está no item 10.

4. **Guard de egress no processo.** Antes de entregar o controle ao CLI do Headroom, o shim instala um guard que aceita somente loopback (`127.0.0.0/8`, `::1` e `localhost`):
   - nomes que não são loopback são recusados antes de qualquer resolução DNS, em `socket.getaddrinfo`;
   - `socket.connect`, `socket.connect_ex` e `sock_connect` dos loops asyncio selector e proactor verificam o endereço;
   - a recusa gera `ConnectionRefusedError` e a linha `jms-egress-blocked host=<host>` no stderr, só com o host.

   O guard não é sandbox (ver Segurança).

5. **Modo `--check`.** `python -I jms_headroom_shim.py --check` imprime uma linha JSON com `ok`, as URLs resultantes e o estado do guard, e sai com código 0. Falhas saem com código 2 (base inválida), 3 (versão diferente), 4 (forma do código diferente: módulo que não importa ou atributo com valor inesperado) ou 5 (autoteste ou guard falhou). O supervisor roda `--check` antes de iniciar o proxy.

6. **Duas formas de roteamento.** O login ChatGPT usa a variável de ambiente `HEADROOM_CHATGPT_CODEX_BASE_URL`, montada por `codexShimEnv`. A chave de API usa o argumento `--openai-api-url http://127.0.0.1:<porta codex>/v1`, que `headroomArgs` acrescenta quando há porta do Codex.

7. **Supervisor.** Com `headroom.codex: false`, o `headroom.exe` inicia como antes. Com `headroom.codex: true`, o supervisor:
   - detecta o interpretador: `headroom.python`; sem ele, `UV_TOOL_DIR`, `uv tool dir` e `%APPDATA%\uv\tools`, nessa ordem, com o primeiro existente;
   - confere a versão do pacote `headroom-ai`;
   - roda `--check`;
   - inicia o shim com os argumentos de `headroomArgs` e o ambiente de `codexShimEnv(headroomEnv(...))`.

   Qualquer falha desses pré-requisitos, ou um modo Codex que não fica saudável, para o processo do Codex, libera a porta e volta ao Headroom só para o Claude, com `headroomCodexReason`. O Claude nunca perde o Headroom por causa do Codex.

8. **Launcher `jev-memory codex`.** Com `headroom.enabled` e `headroom.codex`, o `jev-memory-codex` (ou `jev-memory codex`):
   - com `JMS_HEADROOM=off`, desvia antes de qualquer ação;
   - garante o supervisor e executa `jev-codex --start`, que reaproveita o gateway em execução (a saída do upstream vai para stderr);
   - espera até 60 s enquanto o Headroom está `starting` ou `restarting`;
   - usa o Headroom só se o Codex estiver `active`, `codexUpstreamPort` for igual à porta atual do Jev codex, `/livez` responder e o `/health` do Jev estiver `running`;
   - então inicia o `codex` diretamente, com as sobrescritas de provedor do launcher upstream (`jev-gateway`) apontando para o Headroom: `base_url` `http://127.0.0.1:<porta do Headroom>/v1`, `wire_api` `responses` e `requires_openai_auth` `true`. O argv segue o do launcher upstream: as sobrescritas vêm antes dos argumentos e, em `exec`, `e`, `resume`, `review` e `fork`, logo depois do subcomando;
   - qualquer falha, inclusive ao ler a especificação do Codex no upstream, imprime `Headroom not used: <motivo>; launching through jev-codex.` e segue pelo caminho original.

   O provedor não habilita WebSocket. O caminho WebSocket do Headroom também aponta para o Jev, mas o provedor não o usa.

9. **Correção de dependência, válida também para o Claude.** O litellm, dependência do Headroom, buscava a tabela de preços em `raw.githubusercontent.com` ao ser importado, apesar de `HEADROOM_OFFLINE`. `headroomEnv` passou a definir `LITELLM_LOCAL_MODEL_COST_MAP=True`. O guard detectou o problema no teste E2E do Codex.

10. **Regra de manutenção.** Cada versão do Headroom tem uma pasta de patch (`patches/headroom/<versão>/`), e `headroom.version` é fixada. Subir a versão exige nova pasta, `--check` aprovado, `npm run test:headroom-codex` aprovado e revisão das verificações de forma do código. Se a forma mudar e não houver patch seguro, o Codex fica no caminho direto do Jev, sem Headroom (fallback).

11. **Aposentadoria do shim.** Quando o upstream publicar a variável `HEADROOM_CHATGPT_CODEX_BASE_URL`, o shim deixa de ser necessário. A suíte passaria a definir a variável e a iniciar `headroom.exe` diretamente. Essa mudança de código é tarefa própria. Procedimento e contribuição: [patches do Headroom](../../../patches/headroom/README.md).

## Alternativas rejeitadas

- **Editar o site-packages instalado.** Altera a instalação do operador, não é versionado e não é auditável como mudança do projeto. O shim muda apenas atributos na memória do processo.
- **Vendorizar ou fazer fork do Headroom.** Mesmo motivo da [ADR 0013](0013-headroom-context-compression.md): o upstream está em reescrita ativa, e manter uma cópia exigiria acompanhá-la.
- **Arquitetura B, Jev antes do Headroom, também para o Codex.** Não escolhida. A compressão precisa ocorrer antes do Jev e do provedor, como na ADR 0013, e a arquitetura A é a validada.
- **Cabeçalho `X-Headroom-Base-Url` por requisição.** Não serve como controle de destino. Com login ChatGPT, o Headroom ignora o cabeçalho, e o destino é validado contra SSRF. A suíte não pode garantir o roteamento com base nele.
- **Aguardar só o upstream.** Sem data de release, o Codex ficaria sem compressão e sem contabilização pelo Jev. O upstream é o caminho de aposentadoria do shim, não o plano único.
- **Processo Headroom separado para o Codex.** Exigiria um segundo processo, de cerca de 600 a 700 MB de RAM. Um processo por perfil atende Claude e Codex.

## Consequências

- O Codex passa pelo Headroom só com `headroom.codex: true`. Sem a opção, o caminho direto do Jev continua.
- No modo Codex, um processo Headroom por perfil atende os dois clientes, com cerca de 600 a 700 MB de RAM.
- O shim depende de uma pasta de patch por versão. Um upgrade do Headroom sem patch seguro desliga a rota do Codex, sem afetar o Claude.
- Uma falha do modo Codex não derruba o Headroom do Claude. Em contrapartida, como na ADR 0013, não há fallback depois que o Codex inicia: se o proxy cair, as requisições falham até o reinício do supervisor.
- Com login ChatGPT ao vivo (H5, 2026-10-23, [tests.json](../../../tests.json)), os turnos de mesmo conteúdo tiveram −0,5% de tokens de entrada (n=1). A cobrança real não foi medida. Os testes automatizados usam backend simulado.
- O MCP de memória funciona no Codex por code mode. As ferramentas não são declaradas no nível superior da requisição: o modelo as descobre pelo `ALL_TOOLS` e chama `tools.mcp__jev_memory_suite__<ferramenta>(...)` de dentro do `exec`. Por isso os esquemas das 24 ferramentas não viajam em toda requisição; eles entram no contexto quando o modelo consulta `ALL_TOOLS` ou chama uma ferramenta. Validado no H5, com e sem Headroom.
- Os hooks do Codex continuam exigindo confiança nativa em `/hooks`. Esta rota não altera isso. A confiança fica em `CODEX_HOME/config.toml`: o projeto precisa de `[projects.'<dir em minúsculas>'] trust_level = "trusted"`, e cada hook, de `[hooks.state.'<chave>'] trusted_hash = "sha256:..."`, em que a chave é `<caminho do hooks.json>:<evento em snake_case>:<i>:<j>`. Um hook com comando alterado muda de hash e volta como `modified`. A suíte não grava confiança no `~/.codex/config.toml` do usuário.
- Antigravity e Kompress continuam fora do escopo.

## Segurança

Riscos registrados em [T43 a T46](../../security/threat-model.md):

- **T43:** o shim roda código no processo do Headroom. Um patch com alvos fora da forma esperada, ou uma versão nova com os mesmos nomes e outro comportamento, pode passar pelo `--check`. Mitigado pela pasta por versão, pelo código de saída 4 para forma diferente, pelo autoteste de URL (código 5) e pelo teste E2E.
- **T44:** tentativa de conexão para fora do loopback. Mitigado pelo guard (item 4) e pelo teste que recusa `api.openai.com` por override e confirma zero tentativas a chatgpt.com. O guard vale só dentro do processo Python: chamadas à API do SO fora do módulo `socket` não são filtradas, e outros processos não são cobertos.
- **T45:** o processo do Headroom vê o JWT OAuth do Codex e o `ChatGPT-Account-ID`. Mitigado pelo repasse sem alteração e por logs só com metadados. O teste confirma que JWT, account id, chave de API e canário não aparecem nos logs. O processo tem o mesmo nível de confiança do Jev (T38).
- **T46:** interpretador sequestrado por `headroom.python`, `UV_TOOL_DIR` ou `uv tool dir`. Mitigado pelo caminho absoluto de `headroom.python`, pela ordem fixa de candidatos, pela leitura da versão com `-I` e pela execução do shim com `-I`. Não há verificação de hash, como em T40.

## Validação

Dados de 2026-10-23, Windows 10, Headroom 0.41.0 instalado com uv.

- **`npm run test:headroom-codex`:** 11/11. Usa o Headroom real pelo shim, o Jev codex real, um backend ChatGPT simulado e um JWT falso. Verifica:
  - streaming de `/responses` com `Authorization` e `ChatGPT-Account-ID` sem alteração;
  - resultado de ferramenta reduzido de 27.883 para 11.430 bytes, com 120/120 ids e 3/3 linhas ERROR mantidas, sem ferramenta de recuperação;
  - prefixo dos turnos anteriores idêntico byte a byte;
  - `/models` pelo Jev;
  - caminho de chave de API por `--openai-api-url`;
  - override inseguro de `x-headroom-base-url` ignorado, e `api.openai.com` recusado pelo guard;
  - WebSocket chega ao backend só pelo Jev;
  - nenhuma tentativa a chatgpt.com nos logs;
  - nenhum JWT, account id, chave ou canário nos logs;
  - estado só no perfil, com `~/.headroom` inalterado;
  - rollback.
- **`test/headroom-shim.test.ts`:** shim real com `--check`, bases inválidas e cópia com versão divergente (código 3).
- **Testes unitários** de argumentos, ambiente, detecção, montagem do spawn e fallback.
- **Número de compressão:** a redução de 27.883 para 11.430 bytes vem de teste automatizado com backend simulado. Não é medição de economia.
- **`npm run test:codex-launch`:** 10/10 em 2026-10-23, com Codex 0.163 real, login ChatGPT falso e `CODEX_HOME` isolado ([tests.json](../../../tests.json), `H4-headroom-codex`).
- **H5, login ChatGPT real ao vivo** (2026-10-23, gpt-6-luna, com Headroom e sem ele, [tests.json](../../../tests.json), `H5-headroom-codex-live`):
  - 7 requisições Codex → Headroom → jev-codex → backend, todas com status 200; uso do Jev igual ao do Codex; descoberta de modelos pelo Headroom com 2× 200; streaming até `response.completed`.
  - Sem anomalia de autenticação. `authorization` e `chatgpt-account-id` aparecem redigidos nos logs.
  - Tokens: −0,5% de entrada nos turnos de mesmo conteúdo (24.835 contra 24.966 e 29.818 contra 29.957; n=1). Overhead de otimização de cerca de 5 ms; RAM do Headroom de 645 MB.
  - Captura por hooks não comprovada nesse run: 0 observações, porque o projeto não era confiável e não houve bypass.
- **H6, qualidade** (2026-10-24, [tests.json](../../../tests.json), `H6-codex-hooks-native-trust`): `npm run test:codex-launch` 12/12.
  - MCP de memória pelo code mode: o `exec` listou as 24 ferramentas e leu o handoff, com e sem Headroom.
  - Captura por hooks com confiança nativa em `CODEX_HOME` isolado, via `hooks/list` e `config/batchWrite`, sem flag de bypass: 7 hooks `trusted` e 6 tipos de observação, com e sem Headroom.
  - `HEADROOM_LOSSLESS_ONLY=1`: sem a variável, o SmartCrusher descartava itens de array sem marcador (16 de 24 nomes chegaram ao modelo).
  - Pendente: o handoff não chegou à primeira requisição, com e sem Headroom.
- **Não validado:** TUI interativo, Codex Desktop, cobrança real, captura por hooks com confiança normal no projeto real do usuário (S3) e entrega do handoff pelo SessionStart no Codex.

Registro: [progress.md](../../../progress.md), seção "Headroom fase 2 (Codex): integração (2026-10-23)". Procedimentos: [otimização de tokens](../../guides/token-optimization.md#headroom-com-codex-opcional) e [operação](../../runbooks/operations.md#headroom-com-codex).
