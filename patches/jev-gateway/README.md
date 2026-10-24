# Patches do jev-gateway

## O que o patch faz

`0.5.1/codeassist-agy.patch` adiciona ao jev-gateway 0.5.1 um adaptador para a Code Assist API, usada pelo Antigravity CLI (`agy`). Com `JEV_CLIENT=agy`, o gateway vira um repasse puro: o tráfego de geração (`streamGenerateContent`, `generateContent`) e as rotas de conta, cota e auxiliares são encaminhadas ao upstream sem serem lidas nem roteadas pelo Jev. São 64 rotas, listadas em [Rotas suportadas](#rotas-suportadas). A rota `jev-agy` e o launcher `agy` apontam o CLI para o gateway local por `CLOUD_CODE_URL`.

O patch é cumulativo: contém a versão 2 do patch, as alterações do Marco 3 (testes multi-turno e isolamento do home dos testes) e o contrato de rotas 2 (`CODE_ASSIST_PATCH_VERSION` = 2). Tamanho atual: 25 arquivos e 2.503 linhas, sem CR (LF canônico). Em relação ao patch anterior, entraram `src/upstream.ts` e `test/codeassist-routes.test.ts`.

Arquivos alterados:

- Código do gateway: `src/codeassist.ts` (novo; nomes dos métodos, validação do upstream e leitura do método a partir do caminho), `src/adapters/codeassist.ts` (novo; reutiliza o adaptador Gemini, com `toInput` sempre em skip), `src/config.ts` (campo `codeAssist` e recusas de configuração do modo agy), `src/app.ts` (no modo agy, só `/health`, `/dashboard`, `/v1internal:<método>` e `/v1internal/<caminho>`), `src/usage.ts` (no ramo Gemini, `thoughtsTokenCount` conta como saída e como `reasoning`) e `src/dashboard.html` (porta 8794 na lista de portas observadas).
- Cliente e launcher: `bin/clients.mjs` e `bin/jev-agy.mjs` (spec com `passthroughOnly: true` e launcher), `bin/launcher.mjs` (com `passthroughOnly`, não pede nem exige chave do Jev) e `package.json` (entrada `jev-agy`).
- Testes: `test/codeassist.test.ts` (novo), `test/codeassist-multiturn.test.ts` (novo; 32 testes sobre as fixtures), `test/fixtures/codeassist/*.json` (novo; 4 fixtures: turno sequencial, chamadas paralelas, assinatura em SSE e histórico concluído), `test/health.test.ts`, `test/kilo.test.ts`, `test/launcher.test.ts`, `test/usage.test.ts` e `test/setup.test.ts`.
- Isolamento do home: `vitest.config.ts` e `test/isolate-home.setup.ts` (novos).
- Rotas e redirects (contrato 2): `src/upstream.ts` (novo) e `test/codeassist-routes.test.ts` (novo; 96 testes de rotas).

A versão 1 do patch não tinha `passthroughOnly`, o `/health` do agy não trazia o contrato e os pensamentos do Gemini não entravam na saída. A versão 2 corrigiu esses pontos.

## Por que existe

O agy manda todo o tráfego Code Assist para `CLOUD_CODE_URL`. Sem um adaptador, esse tráfego não passa pelo gateway, e o Jev não consegue medir nem atender o cliente. O patch faz o gateway aceitar esse tráfego e encaminhá-lo, com o token OAuth do próprio usuário, somente aos hosts da Code Assist.

O roteamento e a leitura da conversa ficam desligados de propósito. A análise do Marco 3 manteve o veredito: o passthrough é seguro, e o roteamento ativo segue NO-GO ([ADR 0015, Marco 3](../../docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md#marco-3-2026-10-24)). Até a revisão de privacidade aprovar, nenhuma requisição do agy chega ao Jev.

## Versionamento

Há uma pasta por versão do Jev (`patches/jev-gateway/<versão>/`). O patch atual é o da 0.5.1. Para uma versão nova do jev-gateway, gere um patch novo a partir da versão nova, em outra pasta, e rode a verificação abaixo. O patch não deve ser aplicado a uma versão diferente da que foi validada.

## Isolamento dos testes

O `vitest.config.ts` do patch carrega `test/isolate-home.setup.ts` antes de cada arquivo de teste. Esse setup aponta `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` e `APPDATA` para um diretório temporário novo e interrompe a execução se `os.homedir()` continuar no home real. A comparação usa impressão digital, então nenhum caminho pessoal entra no repositório. `test/setup.test.ts` passa `USERPROFILE`, `APPDATA`, `HOMEDRIVE` e `HOMEPATH` aos processos filhos que ele executa.

Só `HOME` não isola nada no Windows: o home vem de `USERPROFILE`. Sem isso, um teste pode subir um gateway real e sobrescrever os arquivos de `~\.jev-gateway`, como aconteceu com o `codex.pid` na porta 8999 (T53). A regra completa está na [ADR 0016](../../docs/architecture/adr/0016-test-isolation.md).

## Como aplicar e verificar

O patch é guardado em LF; o install converte para CRLF quando a cópia do upstream usa CRLF. Ao aplicá-lo manualmente, use sempre `-c core.autocrlf=false`, para que o Git não converta as quebras de linha durante a aplicação.

Nota de verificação: `git apply --check` passou num clone limpo do baseline com `core.autocrlf=false`. Com `core.autocrlf` ligado no checkout, a verificação falha.

Os comandos abaixo rodam numa cópia limpa do upstream, fora do repositório principal:

```
git -c core.autocrlf=false apply --check --whitespace=nowarn patches\jev-gateway\0.5.1\codeassist-agy.patch
```

Depois de aplicado na cópia, rode na pasta da cópia:

```
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
node node_modules/typescript/bin/tsc -p tsconfig.build.json
```

Resultado atual (2026-10-24, contrato 2, Windows 10, com o home isolado por arquivo): 574 testes, 572 passam. Falham 2, ambas herdadas do upstream no Windows: `test/opencode-coverage.test.ts` ×1 e `test/setup.test.ts` ×1 (a checagem de modo 0600 do arquivo de chave, que no Windows dá 0666). O patch aplica limpo nas cópias LF e CRLF. `test/codeassist-routes.test.ts` tem 96 testes novos. Os quatro arquivos de Code Assist e health somam 186/186, conferidos em separado.

Histórico: no Marco 3 (contrato 1, 2026-10-24), o resultado foi 478 testes, 476 passam, com as mesmas 2 falhas. Na versão 1 do patch, o upstream puro tinha 400 testes, com 3 falhas pré-existentes; com o patch v1, eram 438 testes e as mesmas 3 falhas. Na versão 2, com o home temporário, eram 446 testes, com 444 passando.

## Rotas suportadas

Contrato 2: `CODE_ASSIST_PATCH_VERSION` = 2, e `/health` reporta `codeAssist: 2`. A tabela vem da varredura das regras `google.api.http` nos descritores protobuf do `agy.exe` 1.4.7: 66 regras, sendo 55 POST e 11 GET. O casamento é por igualdade no pathname cru, com verbo conferido. Total: 64 rotas.

| Tipo | Rotas | Quantidade | Tratamento |
|---|---|---|---|
| POST colon, geração | `generateContent`, `streamGenerateContent` | 2 | adaptador, com contagem de tokens |
| POST colon, auxiliares | 51 métodos de conta, cota, configuração e auxiliares (lista completa no ADR) | 51 | repasse puro |
| GET colon | `getCodeAssistGlobalUserSetting`, `listAgents`, `listCloudAICompanionProjects`, `listInstances`, `listRemoteRepositories` | 5 | repasse auxiliar |
| GET com barra, exatos | `/v1internal/agentPlugins`, `/v1internal/buildWithGooglePlugins`, `/v1internal/cascadeNuxes`, `/v1internal/webDocsOptions`, `/v1internal/health` | 5 | repasse auxiliar |
| GET template de um segmento | `/v1internal/agentPlugins/<id>`, com id `^[A-Za-z0-9._~-]{1,128}$`; `.` e `..` são recusados | 1 | repasse auxiliar |

A lista completa dos 51 POST auxiliares está em [ADR 0015, Compatibilidade Code Assist](../../docs/architecture/adr/0015-jev-gateway-antigravity-code-assist.md#compatibilidade-code-assist-2026-10-24).

Excluídos de propósito, com 404: `POST /v1internal:proxyCommand/{target_instance_uuid}/{rpc_path=**}` e `POST /v1internal:streamProxyCommand/{...}/{rpc_path=**}`. Um caminho arbitrário de vários segmentos seria um proxy amplo. Um recurso remoto do agy que dependa desses templates não funciona pelo gateway; `JMS_AGY_GATEWAY=off` contorna.

Métodos de chat auxiliares: `generateChat`, `streamGenerateChat`, `tabChat`, `internalAtomicAgenticChat`, `completeCode`, `generateCode` e `transformCode` são repasse auxiliar, sem contagem de tokens no painel. Se o agy usar algum deles para gerar, esses tokens não aparecem.

A suíte (`src/launch.ts`, `AGY_CODE_ASSIST_VERSIONS = [1, 2]`) aceita o gateway instalado (contrato 1) e o contrato 2. Outros valores são recusados, e o agy segue direto.

## Garantias

- Só loopback: `loadConfig` recusa `HOST` diferente de `127.0.0.1`, `::1` ou `localhost` no modo agy.
- Allowlist de upstream: só `https://daily-cloudcode-pa.googleapis.com` ou `https://cloudcode-pa.googleapis.com`, na porta 443, sem usuário e senha, sem caminho, sem query. Qualquer outra origem derruba a inicialização. A mensagem de erro não repete a URL informada, porque ela pode conter credenciais.
- Sem roteamento, shadow e dump: `routing` é forçado a `false`. `JEV_SHADOW` e `JEV_DEBUG_DUMP_DIR` são recusados no modo agy, porque o primeiro enviaria prompts ao Jev e o segundo gravaria prompts em disco.
- Sem chaves: `ROUTER_API_KEY` e `UPSTREAM_API_KEY` são recusadas, porque o cabeçalho `Authorization` já carrega o token do usuário.
- Rotas fechadas: no modo agy, `/v1/*`, `/v1beta/*`, `/exa.*` e `/router/decide` não são registrados. Método desconhecido ou caminho fora da lista responde 404 sem chamar o upstream.
- Verbo errado em rota conhecida, `HEAD` ou `OPTIONS`: 405 com `Allow`, sem chamar o upstream.
- Query acima de 4096 caracteres: 414, sem chamar o upstream.
- Redirects: no modo agy, `fetch` usa `redirect: "manual"`. Qualquer 3xx do upstream vira 502 `upstream_redirect_refused`, sem `Location` nem corpo, porque o token Google do usuário não pode seguir redirect. Os outros clientes (Claude, Codex, Gemini) não recebem a opção, e há teste para isso.
- Destino fixo: `config.upstreamBaseUrl` (allowlist HTTPS de 2 hosts), com pathname validado e query.
- Auxiliares repassam bytes, gzip, SSE e `authorization` intactos. Não há linha `route` no log, porque a métrica de LLM conta só linhas com `mode`; as linhas 404, 405 e 414 também não têm `mode`.
- Sem chave Jev no agy: o launcher não pergunta nem exige chave (`passthroughOnly`). O gateway força `routing` a `false` e recusa shadow no `loadConfig` do modo agy, então o roteador nunca chama o Jev.
- Log sem segredos: o log registra só o nome do método, ou o primeiro segmento após `/v1internal/` (só `[A-Za-z0-9_]`, até 64 caracteres), nunca o corpo, o token, o resto do caminho, a query ou o texto do prompt. Isso é coberto por teste.
- Modo normal inalterado: fora do `JEV_CLIENT=agy`, o comportamento é o mesmo de antes, e `/v1internal:*` continua 404.

## Como aposentar o patch

Quando o jev-gateway trouxer suporte nativo ao agy, este patch deixa de ser necessário: use a versão que já traz a funcionalidade e remova esta pasta.

A contribuição proposta ao upstream é este mesmo patch, levado ao repositório do jev-gateway como pull request. Enquanto o PR não for aceito, a pasta `0.5.1/` continua sendo a referência.
