# CLI

Propósito: documentar os comandos de `jev-memory`, com efeitos, saídas, erros e a saída de `doctor` para os gateways. Público: integradores e operadores. Data: 2026-10-23.

Forma de invocação: `node bin/jev-memory.mjs [--profile <nome>] <comando>`, ou `npm run suite -- <comando>`.

## Opções globais

| Opção | Padrão | Regra |
|---|---|---|
| `--profile <nome>` | `default` | Expressão regular `^[a-z][a-z0-9-]{0,40}$` |
| `--dir <dir>` | Pasta atual | Projeto existente, absoluto ou relativo à pasta atual; usado por launchers, registro e comandos operacionais |

Tudo que vem depois de `--` é repassado sem interpretação ao cliente nativo em `launch`.

## Comandos

| Comando | Efeito | Saída e observações |
|---|---|---|
| `init` | Cria `.local/profiles/<perfil>/suite.json` a partir de `config/default.json` e o token de controle. | Usa criação exclusiva: falha se `suite.json` já existir. |
| `install all\|gateway\|memory` | Compila o motor indicado e atualiza `.local/engines/current.json`. Sem argumento, usa `all`. | Grava `.local/installed.json`. Logs de build em `.local/evidence/`. Não inicia serviços. |
| `start` | Inicia o supervisor destacado e aguarda `phase: ready`. | Imprime o status JSON. Falha se o perfil já estiver em execução, se a porta de controle pertencer a outro processo ou se faltarem as chaves do Gateway. |
| `stop` | Pede parada via `POST /stop` autenticado. | Sem efeito se o perfil já estiver parado. Não mata PIDs. Aguarda até 12 s. |
| `restart` | Executa `stop` e depois `start`. | Mesmo comportamento que `recover`. |
| `recover` | Idêntico a `restart` na implementação atual. | Não faz diagnóstico nem reparo adicional. |
| `status` | Consulta o supervisor. | Imprime o JSON de `/status`. Se parado, imprime `{"phase":"stopped"}`. Se a porta pertencer a outro processo, imprime `port-conflict` e sai com código 1. |
| `doctor` | Gera relatório de diagnóstico. | Mostra presença de motores e chaves (apenas booleanos), ponteiros, estado do supervisor, `gateways` dos clientes e aviso de confiança do Codex. Não mostra valores de segredos. Os gateways são só sondados: `doctor` não inicia nem para nenhum gateway upstream. Ver [saída de doctor dos gateways](#saída-de-doctor-gateways) e [saída de doctor do Headroom](#saída-de-doctor-headroom). |
| `config <arquivo.json>` | Valida o arquivo e substitui `suite.json` atomicamente. | O arquivo precisa estar dentro do repositório e sem links. Exige perfil parado. |
| `update gateway\|memory <sha>` | Executa `git subtree pull --prefix=<prefixo> <url> <sha> --squash`. | Exige árvore Git limpa e SHA de 40 caracteres minúsculos. Acrescenta registro em `upstream.updates.json`. Não instala nem reinicia. |
| `mcp` | Faz handshake MCP com o AI Memory e chama `memory_status` com o workspace e o projeto do perfil. | Imprime `handshake`, `toolsCount` e o status. Exige memória habilitada e em execução. |
| `clients install\|remove\|check claude\|codex\|desktop\|antigravity [dir]` | Registra, remove ou verifica MCP e hooks no projeto selecionado. `dir` é opcional e parte de `--dir` ou da pasta atual. Instala os hooks do host: 9 eventos no Claude, 7 no Codex e 4 no Antigravity (`agy`), em `.agents/hooks.json`. | Saída inclui `validatedInClient: false`, porque a validação dentro do cliente é separada. Reinstale após atualizar a suíte; no Codex, revise `/hooks` depois. Veja [guia de clientes](../guides/clients.md) e [instalação](../guides/installation.md#hooks). |
| `migrate-history --from <dir> [--project <workspace>/<projeto>] [--as <workspace>/<projeto>] [--apply]` | Importa o histórico de uma instalação original do AI Memory (`<dir>` é o diretório de dados, com `db/memory.sqlite`) para o perfil selecionado. Sem `--apply`, faz só a simulação, sobre uma cópia do destino. Com `--apply`, cria backup antes de gravar. `--project` copia só o escopo de origem indicado (sessões, observações, páginas, handoffs e a wiki desse projeto). `--as` escolhe o projeto de destino, que precisa existir no perfil; sem ele, o destino tem o mesmo nome. `--as` exige `--project`. Handoffs com `cwd` fora da raiz do projeto de destino não são inseridos. | Imprime o relatório JSON e grava `.local/evidence/migration-<ts>-dryrun.json` ou `-apply.json`. Com `--apply`, exige suíte parada (`stop`). Status diferente de `ok` sai com código 1. Sem `--from` falha com `migrate-history requer --from <diretório de dados da origem>`. Procedimento e leitura do relatório em [migração do histórico](../guides/migration.md). |
| `launch claude\|codex [--dir <dir>] -- <args>` | Executa o CLI nativo com configuração do perfil. | Exige serviços habilitados em fase `ready`. Desktop não é lançado por aqui. Não passa pelo Headroom. |
| `[--dir <dir>] codex\|claude <args>` | Inicia a memória se necessário e executa o launcher upstream com MCP do projeto. | `--dir` deve vir antes do cliente. Projetos externos recebem perfis isolados automaticamente; veja [projetos externos](../guides/external-projects.md). Com `headroom.enabled`, o `claude` tenta passar pelo Headroom; veja [Claude com Headroom](#claude-com-headroom). Com também `headroom.codex`, o `codex` tenta o mesmo; veja [Codex com Headroom](#codex-com-headroom). |
| `jev-memory agy [args]` (ou `jev-memory-agy [args]`) | Verifica memória, hooks, MCP e marcador de escopo (apenas avisos) e executa o Antigravity CLI (`agy`) com os mesmos argumentos, diretório e stdio. Devolve o código de saída do `agy`. Resolve o `agy` pelo PATH ou em `%LOCALAPPDATA%\agy\bin\agy.exe`. Ao sair, finaliza as sessões registradas por este lançamento. | Sem roteamento pelo Jev Gateway. Procedimento em [clientes](../guides/clients.md#antigravity-cli-agy). |
| `agy-finalize [--session <id>]` | Finaliza sessões do Antigravity CLI com `ai-memory finalize-session --agent antigravity-cli --reopen`. Sem `--session`, usa a sessão agy aberta mais recente do projeto. | Fallback para sessões não iniciadas pelo launcher ou após queda do launcher. Ver [operação](../runbooks/operations.md#sessões-do-antigravity-cli-agy). |

## Saída de doctor: gateways

`doctor` inclui `gateways.claude` e `gateways.codex`, e no nível superior a chave `conflicts`. Forma (valores de exemplo, sem segredos):

```json
{
  "gateways": {
    "claude": { "portEnv": "JEV_CLAUDE_PORT", "port": 8789, "portValid": true, "source": "installed", "state": "running", "pid": 4242, "upstream": "https://api.anthropic.com/v1" },
    "codex": { "portEnv": "JEV_CODEX_PORT", "port": 8790, "portValid": true, "source": "installed", "state": "running", "pid": 4343, "upstream": "https://chatgpt.com/backend-api/codex" }
  },
  "conflicts": []
}
```

- `port`: porta usada. Vem de `JEV_CLAUDE_PORT` ou `JEV_CODEX_PORT` quando válida (decimal de 1024 a 65535), senão da instalação upstream.
- `portValid`: `false` quando a variável de ambiente existe e não é válida. Nesse caso a porta exibida é a padrão.
- `source`: `installed` quando a especificação veio da instalação upstream; `fallback` quando ela estava ausente ou ilegível e a suíte usou 8789 e 8790.
- `state`: `running`, `stopped` ou `unavailable`. A sonda aceita apenas `127.0.0.1` e `localhost`, tem timeout de 1 s, não segue redirecionamento e não devolve texto de erro. `unavailable` não diz a causa; `stopped` indica conexão recusada.
- `pid` e `upstream`: aparecem quando conhecidos. A URL do upstream não tem credenciais, query nem fragmento.
- `conflicts`: lista as portas de perfil iguais à porta de um gateway upstream. Lista vazia quando não há conflito.

Procedimento: [solução de problemas](../guides/troubleshooting.md).

## Saída de doctor: Headroom

`doctor` sempre inclui `headroom`, mesmo com o recurso desligado. Forma (valores de exemplo):

```json
{
  "headroom": {
    "enabled": true, "port": 18880, "version": "0.41.0",
    "detected": { "ok": true, "executable": "<caminho absoluto>", "version": "0.41.0" },
    "state": "ready",
    "codex": {
      "enabled": true,
      "python": { "ok": true, "python": "<caminho absoluto>", "version": "0.41.0" },
      "active": true
    }
  }
}
```

- `detected`: `null` quando `headroom.enabled` é `false`. Caso contrário, é o resultado da detecção: `ok: true` com `executable` e `version`, ou `ok: false` com `reason`.
- `state`: valor de `services.headroom` no supervisor. Vale `stopped` quando o supervisor não informa o serviço.
- `reason`: `headroomReason` do supervisor. Aparece somente quando o início falhou.
- `conflicts` inclui `headroom.port` quando ela coincide com a porta de um gateway upstream.
- `codex.enabled`: valor de `headroom.codex`.
- `codex.python`: detecção do interpretador do `headroom-ai`, na mesma forma de `detected`. `null` quando `headroom.enabled` ou `headroom.codex` é `false`.
- `codex.active`: `true` quando o supervisor iniciou o shim do Codex.
- `codex.reason`: `headroomCodexReason` do supervisor. Aparece quando o modo Codex não está ativo.

## Claude com Headroom

Com `headroom.enabled: true`, `jev-memory claude <args>` (ou `jev-memory-claude`) tenta iniciar o Claude pelo Headroom. Sem opção do launcher, o fluxo é:

1. Com `JMS_HEADROOM=off` no ambiente, o caminho original é usado e nada é iniciado.
2. Senão, garante o supervisor, executa `jev-claude --start` (que reaproveita o gateway em execução) e espera até 60 s enquanto o Headroom está `starting` ou `restarting`.
3. O Headroom só é usado se estiver `ready`, com `upstreamPort` igual à porta atual do Jev claude, `/livez` respondendo e o `/health` do Jev em `running`. Então o `claude` é iniciado com `ANTHROPIC_BASE_URL=http://127.0.0.1:<headroom.port>`. Argumentos e demais variáveis são os mesmos do launcher.
4. Se alguma verificação falhar, stderr recebe `Headroom not used: <motivo>; launching through jev-claude.` e o launcher segue pelo caminho original.

O fallback só ocorre antes de o Claude iniciar. As opções do launcher (`--status`, `--stop`, `--start` e as demais) não passam pelo Headroom. `launch claude`, que usa o gateway da suíte, também não passa pelo Headroom nesta fase. Motivos e ações em [solução de problemas](../guides/troubleshooting.md#headroom). Decisão em [ADR 0013](../architecture/adr/0013-headroom-context-compression.md).

## Codex com Headroom

Com `headroom.enabled: true` e `headroom.codex: true`, `jev-memory codex <args>` (ou `jev-memory-codex`) tenta iniciar o Codex pelo Headroom. Sem opção do launcher, o fluxo é:

1. Com `JMS_HEADROOM=off` no ambiente, o caminho original é usado e nada é iniciado.
2. Senão, garante o supervisor, executa `jev-codex --start` (que reaproveita o gateway em execução, com a saída do upstream em stderr) e espera até 60 s enquanto o Headroom está `starting` ou `restarting`.
3. O Headroom só é usado se `headroom.codex` estiver ligado no `/status`, com `codexUpstreamPort` igual à porta atual do Jev codex, `/livez` respondendo e o `/health` do Jev codex em `running`. Então o `codex` é iniciado diretamente, com as sobrescritas de provedor do launcher upstream (`jev-gateway`) apontando para `http://127.0.0.1:<headroom.port>/v1`, com `wire_api` `responses` e `requires_openai_auth` `true`. O argv segue o do launcher upstream: as sobrescritas vêm antes dos argumentos e, em `exec`, `e`, `resume`, `review` e `fork`, logo depois do subcomando.
4. Se alguma verificação falhar, ou se a especificação do Codex no upstream não puder ser lida, stderr recebe `Headroom not used: <motivo>; launching through jev-codex.` e o launcher segue pelo caminho original.

O provedor não habilita WebSocket. As opções do launcher (`--status`, `--stop`, `--start` e as demais) não passam pelo Headroom, e `launch codex` também não passa. Os hooks do Codex continuam exigindo confiança nativa em `/hooks`. Motivos e ações em [solução de problemas](../guides/troubleshooting.md#codex). Decisão em [ADR 0014](../architecture/adr/0014-headroom-codex-routing.md).

## Erros

Erros são impressos em stderr com a mensagem do gerenciador e saem com código 1. Mensagens genéricas, como `Command failed`, aparecem quando a exceção não é de domínio. Consulte [solução de problemas](../guides/troubleshooting.md) para as mensagens mais comuns.

## Exemplos

```bash
node bin/jev-memory.mjs --profile default status
node bin/jev-memory.mjs clients check claude .
node bin/jev-memory.mjs clients install antigravity .
node bin/jev-memory.mjs agy-finalize
node bin/jev-memory.mjs launch claude --dir . -- --help
```
