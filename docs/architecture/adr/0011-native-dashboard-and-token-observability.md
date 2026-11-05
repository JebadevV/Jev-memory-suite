# ADR 0011 — observabilidade de tokens complementar ao painel incorporado

Propósito: registrar por que a suíte mede tokens do Jev Gateway a partir do histórico do log do launcher, sem recriar a interface do gateway; como essa seção convive com o painel original incorporado pela [ADR 0010](0010-unified-dashboard.md); e por que uma tentativa de interface nativa foi retirada no mesmo dia. Público: mantenedores e revisores de segurança. Data: 2026-10-22. Estado: aceito. Complementa a [ADR 0010](0010-unified-dashboard.md), que continua válida.

## Contexto

A [ADR 0010](0010-unified-dashboard.md) embute a página original do Jev Gateway em um único iframe, do agregador. Essa página mostra os roteadores, filtros, interruptores de roteamento e gráficos, e lê `GET /dashboard/events` de cada processo. Ela tem um limite: o upstream retém no máximo 1000 eventos por processo. Não há total histórico, nem custo, nem uma visão por modelo com a chave de cobrança, nem comparação com e sem Jev em todo o período.

A auditoria de 2026-10-22 mediu o uso real a partir dos logs do launcher em `~/.jev-gateway/`, somente com metadados. Os números estão em [otimização de tokens](../../guides/token-optimization.md). Em resumo: o Jev recebeu cerca de 304,6 M tokens de entrada em 14.505 chamadas, e nenhuma chamada evitou o LLM. Não existe período de referência com o roteamento desligado, então não há evidência comparativa de economia.

## Decisão

1. **Painel original mantido.** A ADR 0010 continua valendo: uma única página, do agregador, com `?peers=` para as demais portas configuradas. A suíte não recria a interface do gateway. Os interruptores de roteamento, filtros e gráficos ficam na página original.
2. **Seção complementar de observabilidade de tokens.** A página da suíte ganha uma seção compacta, "Observabilidade de tokens (histórico do log)", com:
   - totais do histórico por cliente e combinados, lidos do log do launcher (`~/.jev-gateway/<cliente>.log`) de forma incremental;
   - tabela por modelo, com a chave de cobrança `sentModel ?? model`;
   - estimativa de custo a partir de `observability.pricing.models` e `observability.pricing.jev`;
   - comparação de histórico, Com Jev × Baseline (roteamento desligado);
   - o experimento configurado em `gatewayExperiment`.
3. **Leitor incremental do log.** `src/gateway-history.ts` guarda um deslocamento em bytes. Reinicia do início quando o arquivo é truncado ou rotacionado, lê no máximo 8 MiB por atualização e ignora linhas com mais de 64 KiB.
4. **Módulos.** `src/gateway-metrics.ts` normaliza, agrupa por modelo e estima custo. `src/gateway-history.ts` lê o log. `src/gateway-views.ts` calcula apenas a comparação com e sem Jev, seguindo as regras da página legada (`upstream/jev-gateway/src/dashboard.html`). `src/gateways.ts` monta o snapshot com `aggregatorFor`, as informações do roteador, o histórico, os modelos, o custo e a comparação.
5. **`GET /gateways/status`.** Responde `{ ok, generatedAt, aggregator, gateways, combined, pricing }`. Cada gateway traz `client`, `label`, `port`, `portValid`, `state`, `metrics`, `router`, `history`, `historyCompare`, `cost: { history }`, `models: { history }` e `experiment`. `combined` soma contagens do histórico. `pricing` ecoa somente `source` e `verifiedAt`. Todas as rotas aceitam somente `GET`; outros métodos respondem `405`.
6. **Experimento configurável.** `gatewayExperiment.{claude,codex}` aceita `default`, `shadow` ou `metering`. `shadow` define `JEV_ROUTING=true` e `JEV_SHADOW=true`; `metering` define `JEV_ROUTING=false` e `JEV_SHADOW=false`; `default` não define nada. A variável vale quando o roteador inicia; o launcher reutiliza um roteador em execução.
7. **Preços somente da configuração.** `observability.pricing` guarda preços por modelo (até 100) e do Jev. Não há preço padrão. Sem preço, o custo aparece como não configurado.

### Retirada da interface nativa (2026-10-22)

Entre a ADR 0010 e esta decisão, a suíte chegou a recriar a interface do gateway no próprio painel: tabelas de janela, filtros, linha do tempo, comparação por faixa, tabela de requisições e estado do roteador. Também foram criados um interruptor de roteamento em `POST /gateways/routing`, com token CSRF e limite de chamadas, e um redirecionamento da página legada, que exigia um patch local em `upstream/jev-gateway/`.

Essa variante foi retirada no mesmo dia. Causa: o pedido de trabalho dizia "uma única interface de gestão, sem painéis incorporados". A instrução foi seguida ao pé da letra, sem confirmar com a integração existente e funcionando da ADR 0010. O resultado duplicou a interface do upstream. O usuário esclareceu que o objetivo era acesso integrado aos dois painéis originais.

Foram removidos: a recriação nativa das visões; a rota `POST /gateways/routing`, o token CSRF e o limite de chamadas; os campos de janela, requisições recentes e faixas de `/gateways/status`; a opção `dashboard.legacyRedirect`; a injeção de `JEV_DASHBOARD_REDIRECT` no lançamento; o patch local no upstream, revertido. O diretório `upstream/` voltou a estar limpo, e o verificador de árvore limpa da instalação deixou de bloquear. Os arquivos da ADR 0010 foram mantidos. As páginas diretas `http://localhost:8790/dashboard` e `http://localhost:8789/dashboard` continuam acessíveis e respondem `200`, sem redirecionamento.

## Alternativas rejeitadas

- **Recriar a interface do gateway na suíte.** Foi tentada e retirada, pelas razões acima. Duplicava a página do upstream e dependia de cada mudança dela.
- **Redirecionar a página legada para a suíte.** Exigiria patch no upstream e, na prática, removeria a página original. Foi retirada.
- **Interruptor de roteamento na suíte.** Duplicaria o interruptor da página original e exigiria CSRF próprio. O interruptor fica na página original, sob a política do próprio upstream.
- **Usar só o log, sem API.** O log não tem o estado em tempo real. A seção combina as duas fontes: a API para o estado e o log para o histórico.
- **Preço padrão do Jev ou dos modelos.** Um número sem fonte e data verificadas seria apresentado como custo real.
- **Aplicar otimizações agora.** A auditoria não tem comparação, e os limiares afetam a qualidade das decisões. A mudança depende de dados de referência.

## Consequências

- A visão de rotas e a alternância continuam dependendo do upstream. Se `/dashboard` ou `/dashboard/events` mudarem, a página original muda com elas.
- Os totais da seção vêm do log, que cresce sem rotação própria. A leitura incremental limita o trabalho por atualização, não o tamanho do arquivo.
- Os custos são **estimativas de preço de API**, calculadas a partir de contagens. Não são cobrança de assinatura e não são economia confirmada.
- O custo do Jev está sempre incompleto, porque o upstream não registra tokens de saída do Jev. A estimativa lista `jev-output-tokens` em `missing`.
- Sem período de referência com `metering`, a comparação com e sem Jev não tem dados. Para o Claude, o modo `hint` nunca evita uma chamada ao LLM, então a referência é necessária antes de qualquer conclusão sobre economia.
- A seção não substitui a página original: ela não mostra janela de eventos, filtros nem o estado detalhado de cada roteador.

## Segurança

Riscos residuais, registrados em [T30](../../security/threat-model.md) e [T32](../../security/threat-model.md):

- A página do agregador tem o interruptor de roteamento do upstream. `POST /dashboard/routing` do upstream aceita qualquer origem local e requisições sem `Origin`. A suíte não altera esse código, e a retirada da rota da suíte não muda essa exposição.
- O token e os dados de `/dashboard/events` e do log são legíveis por processos locais da mesma conta. Contêm metadados de requisição, não prompts.
- Quando o roteamento Jev está ligado, o provedor do Jev recebe, em cada requisição, o prompt de sistema, o estado da conversa (até 60.000 caracteres) e as descrições de ferramentas (até 48.000 caracteres). Isso é exposição a terceiros, tratada no [LGPD](../../security/lgpd.md).
- `GET /gateways/status` não contém chave, `pid`, texto de prompt ou URL de upstream. `router.upstream` guarda só origem e caminho. Todas as rotas são somente `GET`.
- Dados de gateway e do log são tratados como não confiáveis: validação estrita e escrita com `textContent`.

## Validação

Dados de 2026-10-22, com ambiente descartável e gateways reais nas portas 8789 (claude) e 8790 (codex):

- **Página do painel:** exatamente um iframe, `src="http://localhost:8790/dashboard?peers=8789"`, com `data-aggregator="codex:8790"`. CSP com `frame-src http://localhost:8790 http://127.0.0.1:8790`.
- **Página original:** renderizada dentro do iframe, com os dois roteadores, filtros, interruptores, cartões e gráficos. Sem erros de console e sem rolagem horizontal.
- **`/gateways/status`:** 24,7 KB, sem segredos. Métodos diferentes de `GET` respondem `405`.
- **Páginas diretas:** `:8790/dashboard` e `:8789/dashboard` respondem `200`, sem redirecionamento.
- **Testes:** `npm test` 357/357; `npm run test:e2e` 4/4; `npm run test:projects` 1/1; `npm run test:semantic` 1/1; typecheck, lint e build ok; `npm audit` com 0 vulnerabilidades.
- **Auditoria de tokens:** período do Claude de 2026-09-30 a 2026-10-22 e do Codex de 2026-09-22 a 2026-10-22, por metadados dos logs. Evidência: `.local/evidence/jev-token-audit-2026-10-22.json` e `.local/evidence/jev-token-metrics-2026-10-22.txt`.
- **Não validado:** alternância ao vivo do roteamento (para não interromper as sessões do usuário), cenários de falha de gateway com processo real, e preços reais, que ainda não foram informados.

Registro: [progress.md](../../../progress.md), seção "Correção: painel original restaurado (2026-10-22)". Procedimentos: [operação](../../runbooks/operations.md#painel-de-gateways). Rotas: [API do painel](../../api/supervisor-http.md#painel-local). Configuração: [schema](../../api/configuration-schema.md).

## Acréscimo (2026-10-24)

Este acréscimo não reescreve a decisão 7. Ela continua valendo para qualquer modelo fora dos padrões: sem preço configurado, não há estimativa. O que muda:

- **Rótulo do cliente no feed.** O feed do painel lê as sessões por agente (`active-session.<agente>`, até 3 chamadas MCP), rotula cada item como Claude, Codex, Antigravity ou Desconhecido, a partir de `agent_kind`, e une os itens por data. O rótulo é um prefixo textual, sem mudança de layout. Sessões simultâneas de clientes diferentes aparecem juntas. Limite: o arquivo de um cliente com sessão antiga continua no feed até que esse cliente abra uma nova sessão.
- **Preços padrão verificados.** Há preços padrão para dois modelos Gemini (`gemini-3.5-flash-lite` e `gemini-3.8-flash`), com fonte, `verifiedAt` (2026-10-24) e a página de preços como origem (última atualização 2026-10-22, UTC; tier Standard; USD por milhão de tokens; a saída inclui o raciocínio). Um preço configurado para o mesmo id vence o padrão.
- **Validade (`validUntil`).** O `gemini-3.8-flash` vale até 2026-12-31. Depois disso não há estimativa, e o painel mostra `llm-price-expired:<modelo>`. A página anuncia outros valores a partir de 2027-01-01, e a suíte não os aplica sozinha.
- **Aliases.** `observability.pricing.aliases` (padrão vazio) mapeia um modelo observado sem preço para outro com preço, como equivalência assumida. Serve ao `gemini-3.8-flash-high`, id usado pelo agy, que não aparece na página de preços. A estimativa é marcada no painel.
- **Base de cobrança.** `observability.billing` declara, por cliente, se os tokens são cobrados por API (`api`), cobertos por assinatura (`subscription`) ou não informados (`unknown`). Padrões: Claude e Codex `unknown`; agy `subscription`. O card mostra a base, e no caso de assinatura diz que o custo por token não se aplica. O rótulo "Estimativa de preço de API" continua em todos os cards.
- **Sessões antigas no feed (2026-10-24).** `readActiveSessions` ignora breadcrumbs sem atividade há mais de 12 h (`ACTIVE_SESSION_STALE_MS`, pelo mtime, que todo hook atualiza), o que cobre crash sem session-end. `clearActiveSession` faz compare-and-delete de `active-session.<agente>` e `active-session`. Ele é chamado no `session-end` de Claude e Codex, num `finally`, e depois de cada finalização bem-sucedida do agy, que não tem session-end. A operação não é atômica: se outro cliente gravar exatamente nesse intervalo, a sessão dele some do feed até o próximo hook.
- **Toasts sem repetição (2026-10-24).** O conjunto `seen` dos toasts do navegador é acumulativo, limitado a 2000 chaves, para que uma sessão que sai e volta ao feed não repita toasts. Não há teste de navegador para isso.
- **Custo Jev sem chamadas (2026-10-24).** Sem chamadas Jev (`calls` 0 e `inputTokens` 0), o custo Jev é 0, e nem `jev-price` nem `jev-output-tokens` entram em `missing`. O total passa a ser o custo LLM. Isso vale também para o gateway agy (só repasse), que antes mostrava `total: null` mesmo com preço para `gemini-3.5-flash-lite`, e para o agregado. Com chamadas Jev, nada muda.

Os custos seguem sendo estimativas de preço de API, não cobrança de assinatura nem economia confirmada. Detalhes em [configuração, preços para custo estimado](../../guides/configuration.md#preços-para-custo-estimado).

## Acréscimo (2026-10-25): painel AGY e `agyLive`

Este acréscimo não altera as decisões acima. O agy ganhou um bloco próprio no painel, porque o card no formato de Claude e Codex aparecia como "Indisponível".

- **Causa.** `applyGateways` em `src/dashboard-gateway-script.ts` montava `gateways` só com `claude` e `codex` e descartava o agy. O card recebia sempre `null`. Corrigido no frontend.
- **Bloco AGY.** `#obs-agy` fica entre Codex e Combinado. Mostra o modo passthrough com roteamento travado, o contrato Code Assist, PID, tempo ativo, host do upstream e a base de cobrança (`subscription`). Traz seis indicadores da janela recente, modelos do histórico e até 15 atividades recentes. Não mostra custo, comparação com e sem Jev, cache de escrita nem experimento, porque o agy só faz repasse.
- **Campo `agyLive`.** Aparece em `GET /gateways/status` só na entrada do agy. Contém `pid`, `codeAssist`, `routing`, `startedAt`, `window` (contagens, status, tokens, p50 e p90) e `recent` (até 15 itens com `model`, `method`, `status`, `durationMs` e tokens). Não contém conteúdo de prompt, chave nem token. Vem dos mesmos `/dashboard/events` e `/health` já consultados, sem chamadas novas. Claude e Codex não ganham o campo.
- **Exceção à lista de campos ausentes.** A seção Segurança acima diz que `/gateways/status` não contém `pid`. Com `agyLive`, o `pid` do gateway agy passa a aparecer. É um identificador de processo local, exposto só pelo dashboard em 127.0.0.1 e só nessa entrada. Os demais campos seguem a regra.
- **Janela recente.** A janela inclui eventos anteriores ao `startedAt`, porque o gateway recarrega o log ao iniciar. Por isso o painel diz "janela recente", e não sessão.
- **Validação.** Dados reais via `gatewaySnapshot`, em harness fora do repositório, sem build nem restart. Em 390 px, `scrollWidth` = `clientWidth`. Registro: check `M-agy-obs-1` em [tests.json](../../../tests.json) e seção de 2026-10-25 em [progress.md](../../../progress.md). O painel vivo só mostra a mudança depois de `jev-memory restart`, que não foi executado nesta data.
