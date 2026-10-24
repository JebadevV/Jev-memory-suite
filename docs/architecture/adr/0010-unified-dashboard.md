# ADR 0010 — painel unificado do Jev Gateway, sondagem somente leitura e painel de gateways

Propósito: registrar por que o painel local da suíte passou a incorporar um único agregador do Jev Gateway, como ele obtém o estado dos gateways upstream sem expor dados sensíveis e quais riscos residuais a decisão mantém. Público: mantenedores e revisores de segurança. Data: 2026-10-22. Estado: aceito (complementado pela [ADR 0011](0011-native-dashboard-and-token-observability.md)).

## Contexto

O painel local (`jev-memory dashboard`, porta `dashboard.port`, padrão 18879) reúne o painel de memória do AI Memory e o painel do Jev Gateway. Antes desta decisão, três problemas apareceram na validação:

- **Visão duplicada e sondagem dupla.** `src/dashboard-page.ts` renderizava um iframe por gateway (claude e codex). Mas o painel do gateway upstream já agrega todos os roteadores: ele consulta `/dashboard/events` na própria porta e nas portas padrão 8787 a 8793 e nas indicadas em `?peers=` (`upstream/jev-gateway/src/dashboard.html`, linhas 200 a 214). CORS para origens locais está em `upstream/jev-gateway/src/dashboard.ts`, linhas 10 a 33. Dois iframes repetiam a mesma visão e dobravam as consultas.
- **Porta customizada perdida.** Os iframes não recebiam `?peers=`, então um gateway em porta fora do padrão não aparecia no agregador.
- **Quadro quebrado quando um gateway estava parado.** A lista de gateways era resolvida uma única vez, na partida do supervisor. Um gateway parado depois disso deixava o iframe com erro, sem explicação.

Além disso, o painel não tinha métricas unificadas do Gateway (requisições, roteadas, tokens e latência).

## Decisão

1. **Um único iframe, o do agregador.** `src/gateways.ts` escolhe o agregador em `aggregatorFor`: prefere o Codex quando ele está em execução e usa o Claude caso contrário. A URL é `http://localhost:<porta>/dashboard?peers=<demais portas configuradas>`, com portas numéricas, sem duplicatas e sem a própria porta. O painel renderiza exatamente um iframe (`id="gateway-slot"`, `data-aggregator="cliente:porta"`, sandbox `allow-scripts allow-same-origin`). Se nenhum gateway estiver em execução, a página mostra um bloco de fallback com os comandos `jev-memory-codex` e `jev-memory-claude`.
2. **Estado por `GET /gateways/status`, somente leitura.** A rota do painel devolve `{ ok, aggregator, gateways }`, com `aggregator` igual a `{ client, port }` ou `null`, e cada gateway com `client`, `label`, `port`, `portValid`, `state`, `metrics` e, quando disponível, `summary`. A sondagem é feita em `src/gateways.ts`:
   - `/health` primeiro, com as mesmas restrições do [ADR 0009](0009-gateway-ownership-and-recovery.md) (origem `127.0.0.1` ou `localhost`, sem redirecionamento, timeout de 1 s).
   - Em seguida, `GET /dashboard/events?since=0` com timeout de 1500 ms, `redirect: 'error'`, `credentials: 'omit'`, sem cabeçalhos e com corpo limitado a 2 MB.
   - O JSON é validado estritamente: `router.client` com padrão de até 64 caracteres, `router.routing` booleano, lista de eventos com no máximo 5000 itens, eventos malformados ignorados, números finitos e não negativos.
   - Somente contagens saem da validação: requisições, roteadas, falhas ou passagem direta, tokens (entrada, saída e em cache), latência média e último evento. Não há URL, modelo, motivo, caminho nem texto livre.
   - `401` ou `403` vira `metrics: 'auth-required'`, e nenhuma chave é enviada. Outras falhas viram `unavailable`. Gateway parado vira `offline`.
3. **Cache e Host.** O snapshot dos gateways fica em cache por 5 s, com uma única atualização em voo. Uma falha de atualização é tratada como snapshot offline, também em cache, para que uma verificação quebrada não seja repetida a cada requisição. A rota aceita somente o cabeçalho `Host` exato (`127.0.0.1:<porta>` ou `localhost:<porta>`) e responde `no-store`.
4. **CSP por página.** A página `/` é montada a cada requisição a partir do snapshot em cache. Seu `frame-src` lista apenas as duas origens de loopback do agregador escolhido, ou `'none'` quando nenhum gateway está em execução. O restante da política não muda: `script-src 'self'`, `connect-src 'self'` e `frame-ancestors 'none'`.
5. **Painel de gateways no navegador.** `src/dashboard-script.ts` consulta `/gateways/status` a cada 5 s, com o padrão `setInterval` e `fetch` com `no-store` já usado pelo painel. Os valores são gravados com `textContent`. Se o agregador mudar, aparece um aviso para recarregar a página; o painel não recarrega sozinho. Uma falha na consulta afeta apenas os cartões dos gateways.
6. **Dono e backends sem alteração.** A memória continua no supervisor do perfil. Os gateways continuam sob o launcher upstream ([ADR 0009](0009-gateway-ownership-and-recovery.md)). O código em `upstream/` não é modificado. As páginas diretas `http://localhost:8790/dashboard` e `:8789` continuam acessíveis. `jev-memory dashboard` e `jev-memory-{codex,claude} --dashboard` continuam abrindo o painel da suíte.

## Alternativas rejeitadas

- **Reimplementar nativamente a página do upstream.** Duplicaria cerca de 521 linhas de interface e quebraria a cada atualização do Jev Gateway. A incorporação do agregador usa o código que o próprio upstream mantém.
- **Proxy reverso para a origem da suíte.** Faria o script inline do upstream rodar na mesma origem das APIs de memória, o que exigiria `'unsafe-inline'` na CSP. A decisão preserva a separação por origem.
- **Dois iframes com `?peers=` cada um.** Manteria a visão duplicada e a sondagem dupla, sem resolver o problema de origem.

## Consequências

- O painel depende do agregador do upstream para a visão de rotas. Se o upstream mudar `/dashboard`, `?peers=` ou `/dashboard/events`, a visão quebra. A suíte valida a resposta de `/dashboard/events`, mas não a aparência da página.
- Os contadores cobrem a janela retida pelo upstream, que mantém no máximo 1000 eventos por processo (`upstream/jev-gateway/src/events.ts`, linha 38). Não são totais históricos. A interface mostra "Requisições (até 1.000 retidas)".
- A troca de agregador exige recarregar a página. Isso é explícito, para não substituir um iframe enquanto o operador lê.
- Um gateway fora do agregador escolhido aparece só nos cartões de métricas, não na visão de rotas.
- O gateway possuído pelo supervisor (`gateway.enabled`, com chave de roteador) não entra na seção unificada. Suas métricas seriam `auth-required`, e a chave nunca é enviada.

## Segurança

Riscos residuais, registrados também em [T30](../../security/threat-model.md):

- `POST /dashboard/routing` do upstream aceita qualquer origem local e requisições sem `Origin`. Um processo local da mesma conta pode alternar o roteamento (`upstream/jev-gateway/src/dashboard.ts`, linhas 58 a 67). A suíte não altera esse comportamento, porque o código é do upstream.
- Os gateways iniciados pelo launcher rodam sem chave de roteador. Por isso `/dashboard/events` (metadados de requisição, sem conteúdo de prompt) pode ser lido por processos locais.
- O painel da suíte não tem token. Processos locais da mesma conta podem ler resumos e o feed de memória. Os controles são: escuta só em loopback, `Host` exato contra DNS rebinding e CSP restrita.
- O JSON de `/gateways/status` não contém URL, chave, modelo, caminho nem `pid`. A página contém apenas a URL do iframe do agregador, em loopback e sem credenciais.

## Validação

Medido em perfil descartável, com processos reais (2026-10-22):

- Gateways reais: claude na porta 8789 e codex na 8790. A página `/` tinha exatamente um iframe, `src="http://localhost:8790/dashboard?peers=8789"`, com `data-aggregator="codex:8790"`. A CSP trazia `frame-src http://localhost:8790 http://127.0.0.1:8790`.
- `/gateways/status` devolveu os dois gateways em execução, com métricas `ok` (roteamento ligado, janela de 1000 requisições, contagem de tokens e latência). `Host` inválido respondeu 403. A resposta não continha chave, `Bearer`, URL de upstream nem `pid`.
- Navegador (Chrome DevTools, contexto isolado): os painéis de memória estavam íntegros, a seção de gateways foi preenchida para os dois clientes, e o único iframe mostrou a página do upstream com "codex · :8790" e "claude · :8789", com o filtro por cliente. Nenhum erro ou aviso no console.
- Cenários sem processo real (só o Claude ou só o Codex em execução, os dois parados, portas customizadas, timeouts, respostas malformadas ou acima do limite e proteção de segredos) estão cobertos por testes unitários. Não foram reproduzidos ao vivo, para não parar os gateways do usuário.
- Testes: `test/dashboard.test.ts` 39/39 e `test/gateways.test.ts` 35/35. `npm test` 229/229 e `npm run test:e2e` 4/4. Typecheck, lint e build ok.

Registro em [progress.md](../../../progress.md), seção "Painel unificado Jev Gateway + AI Memory", e em [tests.json](../../../tests.json). Procedimentos: [operação](../../runbooks/operations.md#painel-de-gateways). Rotas: [API do painel](../../api/supervisor-http.md#painel-local).
