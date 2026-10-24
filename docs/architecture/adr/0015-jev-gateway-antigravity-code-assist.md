# ADR 0015 — Jev Gateway para o Antigravity CLI: patch Code Assist com allowlist de métodos e passthrough

Propósito: registrar por que o agy pode passar pelo Jev Gateway com `CLOUD_CODE_URL`, como o modo `agy` do gateway recebe e repassa o tráfego Code Assist, por que o roteamento fica desligado e quais riscos permanecem. Público: mantenedores e revisores de segurança. Data: 2026-10-24. Estado: aceito (Marco 3: estabilização; roteamento ativo NO-GO). Complementa a [ADR 0012](0012-antigravity-cli-integration.md), que cobre a integração por hooks e MCP.

## Contexto

O agy não usa a rota Gemini API do Jev Gateway. Dois fatos mostram isso:

- O agy ignora `GOOGLE_GEMINI_BASE_URL` e `GEMINI_API_KEY`. Com endpoint falso e proxy bloqueador, todo o tráfego foi para `daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`.
- O agy aceita `CLOUD_CODE_URL`. O próprio `cli.log` registra "Overriding CloudCodeServerURL via CLOUD_CODE_URL environment variable". A variável não é documentada e vale só para o processo que a recebe. OAuth, feature flags (`antigravity-unleash.goog`) e telemetria (`play.googleapis.com`) continuam diretos.

Tráfego observado com proxy transparente (agy 1.4.7, 2026-10-24, um "ping" com a conta Google e cota normal):

- 18 chamadas `POST /v1internal:<método>`, todas com status 200; agy saiu com código 0.
- Métodos: loadCodeAssist, fetchAdminControls, fetchUserInfo, retrieveUserQuotaSummary, fetchAvailableModels, listExperiments, writeTrajectoryAcls e streamGenerateContent (`?alt=sse`).
- Todas as chamadas levam `Authorization: Bearer` (OAuth Google), repassado intacto.
- O SSE usa só linhas `data:`, sem `event:` e sem compressão. As respostas JSON auxiliares vêm em gzip.

Formato observado:

- Requisição: `{model, project, requestId, userAgent, requestType, request: {contents, systemInstruction, tools, generationConfig, labels, sessionId}}`.
- Resposta: `{response: {candidates, usageMetadata, modelVersion, responseId}, traceId, metadata}`. `usageMetadata` fica em `response.usageMetadata`, com promptTokenCount, candidatesTokenCount, totalTokenCount e thoughtsTokenCount. As partes trazem `thoughtSignature`.
- O mesmo ping gerou duas gerações: `gemini-3.5-flash-lite` (119 tokens de prompt) e `gemini-3.8-flash-high` com 15 ferramentas (23.197 tokens de prompt).

## Decisão

1. **Patch versionado, sem editar `upstream/`.** O patch é `patches/jev-gateway/0.5.1/codeassist-agy.patch` (LF, 833 linhas, 10 arquivos), com `patches/jev-gateway/README.md`. Ele é aplicado pelo install da suíte (item 7).
2. **Modo `agy` no gateway.** `JEV_CLIENT=agy` ativa o modo Code Assist em `src/config.ts`. Nesse modo, o carregamento de configuração:
   - define `codeAssist` e força `routing=false`;
   - recusa upstream fora da allowlist, host que não seja loopback, `ROUTER_API_KEY`, `UPSTREAM_API_KEY`, `JEV_SHADOW` e `JEV_DEBUG_DUMP_DIR`.
3. **Allowlist de hosts e métodos.** `src/codeassist.ts` aceita só `cloudcode-pa.googleapis.com` e `daily-cloudcode-pa.googleapis.com`, em https na porta 443, sem path, userinfo ou query. Os métodos de geração são `generateContent` e `streamGenerateContent`. Os 7 métodos auxiliares verificados também são aceitos. Desde o contrato de versão 2 (`CODE_ASSIST_PATCH_VERSION` = 2), essa lista de 7 auxiliares e 2 de geração é substituída pela tabela de 64 rotas em [Compatibilidade Code Assist](#compatibilidade-code-assist-2026-10-24).
4. **Rotas.** `src/app.ts`, no modo agy, registra só `/health`, `/dashboard` e `/v1internal:*`. Método fora da lista, ou que não seja POST, responde 404 sem chamar o upstream. O log registra só o nome do método.
5. **Passthrough.** `src/adapters/codeassist.ts` reutiliza o adaptador Gemini, desembrulhando `request`. `toInput` devolve sempre o skip `codeassist_passthrough_only`, então o Jev não trata a requisição como entrada de roteamento. O corpo é repassado sem alteração.
6. **Cliente e porta.** `bin/clients.mjs` e `bin/jev-agy.mjs` definem o cliente `agy` na porta 8794, com `CLOUD_CODE_URL` apontando para o gateway. `package.json` ganha o bin. `src/dashboard.html` lista a porta 8794 entre os peers do painel do próprio Jev.
7. **O install da suíte aplica o patch.** `src/install.ts` aplica `patches/jev-gateway/<versão>/*.patch` depois da cópia e antes do `pnpm install`. Os controles estão em [T51](../../security/threat-model.md).
8. **Roteamento desligado.** Roteamento ativo, forced, direct e shadow permanecem desligados até revisão de privacidade e nova validação com `thoughtSignature` em vários turnos ([T49](../../security/threat-model.md)).

Itens do Marco 2:

9. **Launcher.** `jev-memory-agy` (e `jev-memory agy`) usa o gateway quando todas as verificações passam (`agyGatewayRoute` em `src/launch.ts`, que nunca lança exceção). A ordem é: `JMS_AGY_GATEWAY=off`; `CLOUD_CODE_URL` já definido, que não é sobrescrito; `agy --version` em `VALIDATED_AGY_VERSIONS` (1.4.7); gateway instalado com spec `agy`; porta `JEV_AGY_PORT` válida ou 8794; health com timeout de 1,5 s e, se ele não responder, `node <gatewayDir>/bin/jev-agy.mjs --start` com ambiente sem `UPSTREAM_API_KEY`, `ROUTER_API_KEY`, `JEV_SHADOW`, `JEV_DEBUG_DUMP_DIR`, `CLOUD_CODE_URL` e `JEV_MEMORY_AGY_LAUNCH`. No sucesso, `CLOUD_CODE_URL=http://127.0.0.1:<porta>` vai só no ambiente do agy. Na falha, o stderr recebe `Jev not used: <motivo>` e o agy segue direto ao Google. O código de saída do agy não muda. Hooks, MCP e finalização de sessão seguem como no Marco 1. O gateway é persistente e não para quando o agy sai.
10. **Health validado.** No modo agy, `/health` responde `client: "agy"` e `codeAssist: 1` (`CODE_ASSIST_PATCH_VERSION`). O launcher valida o health com zod (`status ok`, `client agy`, `codeAssist 1`, upstream na allowlist e `pid` inteiro) e exige que o `pid` seja igual ao de `~/.jev-gateway/agy.pid`. Controles em [T52](../../security/threat-model.md).
11. **Chave e passthrough.** A spec `agy` tem `passthroughOnly: true`, e o launcher `jev-agy` não chama `ensureKey()` para esse cliente. No modo agy, o gateway força `routing=false` e recusa shadow, então nunca chama o Jev. Os outros clientes continuam exigindo a chave.
12. **Tokens.** Em `usage.ts`, o Gemini passa a ter `output = candidatesTokenCount + thoughtsTokenCount` e `reasoning = thoughtsTokenCount`. A suíte calcula custo só por `output`, e `reasoning` é subconjunto, como no OpenAI. A regra "último relatório vence" é mantida: não há soma entre eventos SSE cumulativos. A mudança vale também para `jev-gemini`.
13. **Rollback e versões.** `install gateway` imprime `{previous, current}`. `gateway-versions` lista as versões completas, da mais nova para a mais antiga, com a ativa marcada como `current`. `gateway-rollback <id>` valida o id (40 caracteres hexadecimais), exige versão completa dentro de `.local/engines/jev-gateway/`, troca o ponteiro com escrita atômica e não apaga nada. Detalhes em [CLI](../../api/cli.md).
14. **Dashboard.** O cliente `agy` entra no histórico (`~/.jev-gateway/agy.log`), nas sondas e em `/gateways/status`. O card "Antigravity" mostra a nota de passthrough e não tem o bloco "Com Jev × Baseline". O card combinado "Combinado (Claude + Codex + Antigravity)" soma eventos, tokens, custo e modelos dos três. A comparação com e sem Jev continua só com Claude e Codex, porque os eventos do agy são todos `routing_disabled`. Sem spec agy instalado, o card fica "Indisponível" e a porta não é sondada.

## Alternativas rejeitadas

- **Rota Gemini API com API key (`jev-gemini`).** O agy ignora `GOOGLE_GEMINI_BASE_URL` e `GEMINI_API_KEY`, então a rota não recebe o tráfego. A rejeição original, em [ADR 0012](0012-antigravity-cli-integration.md), vale para essa rota.
- **Editar `upstream/` diretamente.** A mudança não ficaria versionada como alteração da suíte e não poderia ser revertida por patch. O patch fica em `patches/` e é aplicado no install.
- **Ativar o roteamento junto com o passthrough.** O conteúdo de geração sairia para o provedor do Jev (T32 e T49), sem revisão de privacidade e sem validação com `thoughtSignature` em vários turnos.
- **Allowlist aberta de métodos ou hosts.** Ampliaria o envio do Bearer para destinos não previstos. Só as rotas declaradas pelo próprio agy (9 métodos no contrato 1; tabela de 64 rotas no contrato 2) e os 2 hosts são aceitos. Rota nova recebe 404 (T50).
- **Definir `CLOUD_CODE_URL` no ambiente global do usuário.** A variável vale só para o processo do agy que a recebe. O launcher a define no próprio processo, sem efeito sobre outros programas.

## Consequências

- No modo agy, o Jev só faz passthrough. Nenhuma compressão é aplicada ao tráfego do agy.
- `thoughtsTokenCount` não é contado como raciocínio pelo `usage.ts` do Jev. O custo de saída fica subestimado.
- Uma atualização do agy pode mudar o protocolo. Método Code Assist novo recebe 404 até a lista ser revalidada, o que pode quebrar o agy após o auto-update.
- Pendências do Marco 2: `jev-memory-agy` ainda não injeta `CLOUD_CODE_URL`; o launcher `jev-agy` ainda pede a chave do Jev (`ensureKey`), mesmo sem chamar o Jev; os dashboards da suíte não mostram o gateway agy; `jev-memory install` não foi rodado, e o ponteiro do gateway ativo não mudou.

## Segurança

Riscos registrados em [T47 a T53](../../security/threat-model.md):

- **T47:** o token OAuth Google passa pelo processo do gateway. Mitigado pelo repasse intacto, pela allowlist de hosts e por logs sem Bearer nem texto de prompt, confirmados por teste e pela validação ao vivo. O processo tem o mesmo nível de confiança do Jev (T38).
- **T48:** `CLOUD_CODE_URL` é variável não documentada, e o agy se atualiza sozinho.
- **T49:** conteúdo Code Assist pode chegar ao Jev se o roteamento for ligado. Hoje ele fica desligado.
- **T50:** a lista de métodos e hosts pode ficar defasada. A falha é fechada, com 404, mas afeta a disponibilidade.
- **T51:** o patch é aplicado a uma fonte vendorizada. A integridade depende do id da versão, do patch LF canônico e da verificação reversa.
- **T52 (Marco 2):** processo local ocupa 127.0.0.1:8794 e responde `/health` falso para receber o token OAuth. Mitigado pela validação do health e pela igualdade do `pid` com `agy.pid`. Residual: processo da mesma conta pode escrever o pid.
- **T53 (Marco 2):** o teste `setup.test.ts` do Jev usa o home real no Windows e pode sobrescrever `~/.jev-gateway/codex.pid`. Mitigado com home temporário no vitest. O defeito do teste upstream continua.

## Validação

Dados de 2026-10-24, agy 1.4.7, Windows 10, Jev Gateway 0.5.1 com o patch.

- **Testes do Jev:** antes do patch, 400 testes (397 ok); depois, 438 (435 ok). Os 38 novos estão em `test/codeassist.test.ts` e cobrem SSE byte a byte com `thoughtSignature`, `generateContent`, os 7 auxiliares, 404 sem chamada ao upstream para método e caminho fora da lista, 400, 429 e 500 repassados, 502 para host inalcançável, gzip com servidor real, cancelamento, roteamento e shadow forçados desligados sem chamar o Jev, ausência de Bearer e de prompt no log, recusas do carregamento de configuração, envelopes diretos e a especificação do cliente.
- **Falhas herdadas:** `setup.test.ts` (2) e `opencode-coverage.test.ts` (1) também falham no gateway instalado sem o patch (tree `0d15e05e…`). São do upstream no Windows, não regressão. Os adaptadores Claude (messages), Codex (responses), chat, Gemini e exa não tiveram regressão.
- **Patch:** aplica limpo em cópia LF e em cópia CRLF. Typecheck e build ok.
- **Suíte:** typecheck e lint ok; `npm test` 462/462, incluindo 14 testes novos de install.
- **Proxy transparente:** as 18 chamadas descritas no Contexto, todas com status 200, e agy com código 0.
- **Ao vivo, com o patch:** gateway numa porta efêmera, sem alterar os gateways ativos e sem `jev-memory install`. `agy -p ping` com `CLOUD_CODE_URL` saiu com código 0. Duas chamadas `streamGenerateContent` passaram em passthrough, com status 200 e motivo `routing_disabled`. Tokens medidos (prompt/saída): 119/3 e 23.192/9. A segunda chamada tinha 15 ferramentas. Negativos com 404: `POST /v1/messages`, `POST /v1beta/models/x:generateContent`, `POST /v1internal:deleteEverything` e `GET /v1internal:loadCodeAssist`. O log do gateway não tem Bearer nem o texto do prompt.
- **Configuração do agy:** `settings.json`, `config/mcp_config.json`, `config/config.json` e `settings.json` têm hash idêntico antes e depois da validação.
- **Não validado:** resposta com `functionCall` (o ping não chamou ferramenta); vários turnos com `thoughtSignature`; IDE e App do Antigravity.

Registro: [progress.md](../../../progress.md), seção "Jev Gateway: Antigravity via Code Assist, Marco 1 (2026-10-24)", e checks `M-agy-2` e `M-agy-3` em [tests.json](../../../tests.json).

### Marco 2 (2026-10-24)

Dados de 2026-10-24, agy 1.4.7, Windows 10.

- **Testes:** typecheck, lint e `npm test` 513/513 na suíte; build ok. Jev com o patch v2: 446 testes, 444 passam. As 2 falhas são do upstream no Windows (`opencode-coverage` e `setup`, este último com o modo 0600 lido como 0666). O vitest foi rodado com home temporário (T53). O patch v2 aplica limpo em cópia LF e em cópia CRLF.
- **Install real:** `jev-memory install gateway` imprimiu `{previous: 0d15e05e48151c3423a50558ede7e101d6c83ae8, current: 4e03786dda52c2aecf9012181612da717015fe62}` em cerca de 4 s. A versão nova contém `src/codeassist.ts`, `dist/codeassist.js` e `bin/jev-agy.mjs`. A versão antiga ficou intacta.
- **Rollback:** ida e volta (`gateway-rollback 0d15…` e depois `4e03…`) funcionaram. Id inválido e versão inexistente foram recusados com saída 1.
- **Gateway Claude:** ativo (PID 24728, porta 8789) e não reiniciado em nenhum momento. Continua na versão 0d15… até o próximo start.
- **Launcher real:** `jev-memory-agy -p ping`, com uma requisição na cota normal da conta, saiu com 0 e mostrou `Jev gateway: http://127.0.0.1:8794 (passthrough)`. `/health` retornou `{status ok, client agy, codeAssist 1, upstream daily-cloudcode-pa}`, com `pid` igual ao de `agy.pid`. No `agy.log`, 2 `streamGenerateContent` passthrough com status 200 e motivo `routing_disabled`: `gemini-3.5-flash-lite` (input 119, output 3) e `gemini-3.8-flash-high` com 15 ferramentas (input 23.524, output 178, reasoning 169). O log não tem Bearer nem prompt.
- **Sessão de memória:** `8dbcc308-ec74-4d69-8dba-419da8e5fbf0`, com `agent_kind antigravity-cli`, session-start, stop e session-end (finalizada pelo launcher). Nenhum erro de hook.
- **Fallbacks reais** (com `--version`, sem modelo): `JMS_AGY_GATEWAY=off` deu `Jev not used: disabled by JMS_AGY_GATEWAY=off`; `JEV_AGY_PORT=8789` (porta do gateway Claude) deu `Jev not used: gateway health invalid: client, codeAssist, upstream`; `CLOUD_CODE_URL` definido deu `Jev not used: CLOUD_CODE_URL already set`. Com o gateway agy parado, relançar o subiu sozinho e voltou `Jev gateway: …`.
- **Dashboard** (snapshot do dist novo com os logs reais; supervisor em execução não reiniciado): Antigravity `running` na 8794, `experiment passthrough`, 2 chamadas, input 23.643, output 181, reasoning 169. Custo `null`, com `missing` de preço para os dois modelos Gemini.
- **Registro:** seção "Jev Gateway: Antigravity via Code Assist, Marco 2 (2026-10-24)" em [progress.md](../../../progress.md) e check `M-agy-4` em [tests.json](../../../tests.json).
- **Limites:** ver a seção C da seção de progresso. O card só aparece no painel em uso depois de `jev-memory restart`. Roteamento segue desligado, e o formato de `functionCall` não foi observado.

### Marco 3 (2026-10-24)

Dados de 2026-10-24, agy 1.4.7, Windows 10. O veredito abaixo vale para o roteamento ativo de cada modo. Ele se baseia em 32 testes com fixtures isoladas e sem rede (`test/codeassist-multiturn.test.ts`) e nas regras de assinatura de pensamento (thought signatures) da documentação do Vertex AI. Não há chamada de modelo ao vivo neste marco.

| Modo | Veredito | Motivo |
|---|---|---|
| passthrough | seguro (offline) | Corpo e resposta byte a byte iguais. Assinaturas, ordem e agrupamento preservados. O Jev nunca é consultado. |
| none | desconhecido | `contents` e assinaturas ficam intactos, e só `toolConfig` muda. A aceitação pelo Google no meio de um turno não é documentada. |
| forced | desconhecido | Mesmo caso de none: só `toolConfig` muda. |
| direct | inseguro | Um `functionCall` sintetizado sem `thoughtSignature` recebe 400 no Gemini 3. `skip_thought_signature_validator` é recurso de último caso e degrada o modelo. |
| shadow | inseguro por privacidade | O `toInput` enviaria ao Jev o prompt de sistema, todos os textos (inclusive os de `thought: true`), argumentos e resultados de ferramentas, e nomes, descrições e schemas de ferramentas e MCP. `maxMessageChars` não é aplicado. |

**Veredito do roteamento ativo: NO-GO.** Para reabrir, são necessários a validação ao vivo de none e forced, com aprovação para chamadas de modelo, e a revisão de privacidade de qualquer modo que envie conteúdo ao Jev. Direct e shadow, como estão, não são candidatos.

Validação deste marco, além das fixtures:

- Typecheck, lint e build ok. `npm test` 560/560, sem skips, com 50.217 entradas sentinela do home real inalteradas. `test:e2e` 4/4 e `test:projects` 1/1, pelo wrapper de isolamento ([ADR 0016](0016-test-isolation.md)).
- Jev com o patch: 478 testes, 476 passam. As 2 falhas são pré-existentes do upstream no Windows (`opencode-coverage` ×1 e `setup` ×1, modo 0600 lido como 0666).
- Recuperação de sessões do agy (ver [ADR 0012](0012-antigravity-cli-integration.md), item 7): e2e real 2/2, com janela de console de verdade.

Não validado: none e forced ao vivo, `functionCall` e `thoughtSignature` em vários turnos ao vivo, IDE e App do Antigravity.

Registro: [progress.md](../../../progress.md), seção "Antigravity: estabilização, Marco 3 (2026-10-24)", e checks `M-agy-5` e `M-iso-1` em [tests.json](../../../tests.json).

### Finalização da estabilização (2026-10-24)

Dados de 2026-10-24, agy 1.4.7, Windows 10. As medições vêm da leitura do `~/.jev-gateway/agy.log` e de `/gateways/status` do gateway real na porta 8794, somente leitura. Nenhum serviço foi reiniciado neste marco.

**E. Garantias do repasse (revisão do patch e log real).**

- `codeAssistAdapter.toInput` sempre retorna `{skip: "codeassist_passthrough_only"}`, e `decideFor` sai antes de `decide` e `askJev`.
- `config.shadow` é recusado em agy, e `/router/decide` não é registrado no modo agy.
- Se o switch `/dashboard/routing` do gateway (com checagem de origem local) for ligado, o `toInput` mantém o repasse. É defesa em profundidade.
- Log real: 10/10 gerações `passthrough / routing_disabled`, nenhuma linha com `jev` ou `shadow`, `jev.calls` 0.
- O `agy.log` (5.937 bytes) não tem `Bearer`, `ya29.`, `authorization`, `contents`, `systemInstruction` nem `thoughtSignature`.

**F. Achado de disponibilidade e recomendação.**

- O binário do agy 1.4.7 referencia cerca de 60 métodos `v1internal:*`, por exemplo `countTokens`, `recordClientEvent`, `recordCodeAssistMetrics`, `checkUrlDenylist`, `checkUrlAntivirus`, `rewriteUri`, `listModelConfigs` e `onboardUser`. Ele também referencia o caminho `/v1internal/buildWithGooglePlugins`, com barra em vez de dois-pontos. A allowlist tem 9 métodos.
- No gateway real houve 1 pedido 404 `codeassist_unknown_method`, com nome vazio, às 17:51:38Z. É compatível com o caminho com barra.
- Com `CLOUD_CODE_URL`, todo o tráfego Code Assist do agy passa pelo gateway, e o método fora da allowlist recebe 404 sem ir ao Google. Isso pode degradar recursos do agy; sem o gateway (`JMS_AGY_GATEWAY=off`) o agy chama o Google direto. Não se sabe se `checkUrlDenylist` e `checkUrlAntivirus` falham abertos ou fechados no agy.
- Recomendação, não implementada (exige novo patch, reinstalação e aprovação): validar e repassar como auxiliares os métodos observados em uso, e registrar o primeiro segmento de caminhos com barra. Até lá, `JMS_AGY_GATEWAY=off` contorna.

**D. Contabilidade Gemini.**

- 10 gerações. As somas brutas do log batem com o painel: input 209.341, sendo 63.563 sem cache e 145.778 do cache; output 1.502, que inclui 1.012 de reasoning, sem contagem dupla.
- `gemini-3.8-flash-high` (8 eventos) segue sem preço (`llm-price:gemini-3.8-flash-high`). `gemini-3.5-flash-lite` (2 eventos) tem estimativa de 0,0001 USD.
- Billing: agy `subscription`; Claude e Codex `unknown`.

**Veredito.** Consolidação do repasse: GO. Roteamento ativo: NO-GO. A consolidação vale para o passthrough, cujo código e log foram verificados. O roteamento segue bloqueado pelos motivos do Marco 3 e porque none e forced não têm validação ao vivo.

Registro: [progress.md](../../../progress.md), seção "Antigravity: finalização da estabilização (2026-10-24)", e checks `M-agy-6` e `M-iso-2` em [tests.json](../../../tests.json).

### Compatibilidade Code Assist (2026-10-24)

Dados de 2026-10-24, agy 1.4.7, Windows 10. Esta subseção substitui a lista de 9 métodos (7 auxiliares e 2 de geração) pela tabela de rotas do contrato 2 (`CODE_ASSIST_PATCH_VERSION` = 2).

**Evidência.**

- Varredura das regras `google.api.http` (HttpRule) nos descritores protobuf do `agy.exe` 1.4.7: 66 regras, sendo 55 POST e 11 GET: as 64 rotas suportadas mais os 2 templates `**` excluídos. São 58 nomes com dois-pontos distintos.
- A lista bruta de strings `v1internal:` tem 66 sequências distintas. Destas, 14 são artefatos de concatenação de strings do Go (por exemplo, `notifyUserA` = `notifyUser` + outra string), e todas começam por um nome de regra. Nenhum método aparece nas strings sem regra correspondente.
- Tráfego real no gateway 8794: 10 `streamGenerateContent` com status 200, e 1 pedido 404 `codeassist_unknown_method` com nome vazio às 17:51:38Z. O pedido é compatível com `GET /v1internal/buildWithGooglePlugins`; o log antigo não registrava caminhos com barra.

**Rotas suportadas (64).** Casamento por igualdade no pathname cru, com verbo conferido.

| Tipo | Rotas | Quantidade | Tratamento |
|---|---|---|---|
| POST colon, geração | `generateContent`, `streamGenerateContent` | 2 | adaptador, com contagem de tokens |
| POST colon, auxiliares | ver lista abaixo | 51 | repasse puro |
| GET colon | `getCodeAssistGlobalUserSetting`, `listAgents`, `listCloudAICompanionProjects`, `listInstances`, `listRemoteRepositories` | 5 | repasse auxiliar |
| GET com barra, exatos | `/v1internal/agentPlugins`, `/v1internal/buildWithGooglePlugins`, `/v1internal/cascadeNuxes`, `/v1internal/webDocsOptions`, `/v1internal/health` | 5 | repasse auxiliar |
| GET template de um segmento | `/v1internal/agentPlugins/<id>`, com id `^[A-Za-z0-9._~-]{1,128}$`; `.` e `..` são recusados | 1 | repasse auxiliar |

POST colon auxiliares (51): battleModeAutoTrigger, battleModeOverrides, checkUrlAntivirus, checkUrlDenylist, completeCode, connectInstance, connectInstanceV2, countTokens, deleteInstance, fetchAdminControls, fetchAvailableModels, fetchCodeCustomizationState, fetchFromTrawlerCache, fetchUserInfo, generateChat, generateCode, getBundleWriteMint, initiateMeshSession, internalAtomicAgenticChat, listAuthorizedDevices, listExperiments, listModelConfigs, loadCodeAssist, migrateDatabaseCode, notifyUser, onboardUser, onboardUserBackgroundTasks, pollSignalingMessages, provisionConversationBundleDir, proxyCommand, recordClientEvent, recordCodeAssistMetrics, recordSmartchoicesFeedback, recordTrajectoryAnalytics, registerInteraction, registerWebPush, retrieveUserQuota, retrieveUserQuotaSummary, revokeAuthorizedDevice, rewriteUri, searchSnippets, sendSignalingMessage, setCodeAssistGlobalUserSetting, setUserSettings, streamGenerateChat, streamProxyCommand, tabChat, transformCode, updateInstance, uploadPerformanceProfile, writeTrajectoryAcls.

**Métodos de chat sem contagem.** `generateChat`, `streamGenerateChat`, `tabChat`, `internalAtomicAgenticChat`, `completeCode`, `generateCode` e `transformCode` são repasse auxiliar, sem contagem de tokens no painel. Se o agy usar algum deles para gerar, esses tokens não aparecem.

**Excluídos de propósito (404).** `POST /v1internal:proxyCommand/{target_instance_uuid}/{rpc_path=**}` e `POST /v1internal:streamProxyCommand/{...}/{rpc_path=**}`. Um caminho arbitrário de vários segmentos seria um proxy amplo. Um recurso remoto do agy que dependa desses templates não funciona pelo gateway; `JMS_AGY_GATEWAY=off` contorna.

**Segurança.**

- Verbo errado em rota conhecida, `HEAD` ou `OPTIONS`: 405 com `Allow`, sem upstream.
- Rota desconhecida: 404, sem upstream.
- Query acima de 4096 caracteres: 414, sem upstream.
- Redirect: no modo agy, `fetch` usa `redirect: "manual"`. Qualquer 3xx do upstream vira 502 `upstream_redirect_refused`, sem `Location` nem corpo. O token Google do usuário não pode seguir redirect. Claude, Codex e Gemini não recebem a opção, e há teste para isso.
- Destino fixo: `config.upstreamBaseUrl` (allowlist HTTPS de 2 hosts), com pathname validado e query.
- Auxiliares repassam bytes, gzip, SSE e `authorization` intactos, sem linha `route` no log, porque a métrica de LLM conta só linhas com `mode`. As linhas 404, 405 e 414 não têm `mode` e ficam fora das métricas.
- Log saneado: nome do método ou primeiro segmento após `/v1internal/` (só `[A-Za-z0-9_]`, até 64 caracteres). Nunca o resto do caminho nem a query.
- O gateway não acrescenta credencial: usa a do próprio agy, para o mesmo host que o agy usaria direto.

**Versão.** `CODE_ASSIST_PATCH_VERSION` = 2, e `/health` reporta `codeAssist: 2`. A suíte (`src/launch.ts`, `AGY_CODE_ASSIST_VERSIONS = [1, 2]`) aceita 1 (gateway instalado) e 2. Outros valores são recusados, e o agy segue direto.

**Estado.**

- Nada instalado nem reiniciado. O gateway instalado continua `4e03786dda52c2aecf9012181612da717015fe62`; o anterior, `0d15e05e48151c3423a50558ede7e101d6c83ae8`, também está preservado.
- O gateway agy em execução (8794, PID 24060) ainda reporta `codeAssist: 1` e responde 404 a `buildWithGooglePlugins` até `jev-memory install gateway` e o reinício do gateway agy. Ambos exigem aprovação.
- O gateway Claude (8789, PID 24728) não foi tocado. Nenhuma chamada de modelo ou de rede real.
- Validação ao vivo depois da instalação, só com chamadas não-modelo (por exemplo, abrir o agy e conferir zero linhas `codeassist_unknown_method`), exige aprovação. Só a rota de geração e o 404 de `buildWithGooglePlugins` foram observados em tráfego real.
- Uma atualização do agy pode declarar rotas novas. `VALIDATED_AGY_VERSIONS` continua `['1.4.7']`, e rotas novas exigem repetir a varredura.
- Roteamento ativo segue NO-GO.

Registro: [progress.md](../../../progress.md), seção "Antigravity: compatibilidade Code Assist (2026-10-24)", e checks `M-agy-7` e `M-agy-8` em [tests.json](../../../tests.json).
