# CLI

Propósito: documentar os comandos de `jev-memory`, com efeitos, saídas e erros. Público: integradores e operadores. Data: 2026-10-21.

Forma de invocação: `node bin/jev-memory.mjs [--profile <nome>] <comando>`, ou `npm run suite -- <comando>`.

## Opções globais

| Opção | Padrão | Regra |
|---|---|---|
| `--profile <nome>` | `default` | Expressão regular `^[a-z][a-z0-9-]{0,40}$` |
| `--dir <dir>` | `.` | Usada apenas por `launch`; caminho relativo dentro do workspace |

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
| `doctor` | Gera relatório de diagnóstico. | Mostra presença de motores e chaves (apenas booleanos), ponteiros, estado do supervisor e aviso de confiança do Codex. Não mostra valores de segredos. |
| `config <arquivo.json>` | Valida o arquivo e substitui `suite.json` atomicamente. | O arquivo precisa estar dentro do repositório e sem links. Exige perfil parado. |
| `update gateway\|memory <sha>` | Executa `git subtree pull --prefix=<prefixo> <url> <sha> --squash`. | Exige árvore Git limpa e SHA de 40 caracteres minúsculos. Acrescenta registro em `upstream.updates.json`. Não instala nem reinicia. |
| `mcp` | Faz handshake MCP com o AI Memory e chama `memory_status` com o workspace e o projeto do perfil. | Imprime `handshake`, `toolsCount` e o status. Exige memória habilitada e em execução. |
| `clients install\|remove\|check claude\|codex\|desktop <dir>` | Registra, remove ou verifica MCP e hooks em um diretório do workspace. | Saída inclui `validatedInClient: false`, porque a validação dentro do cliente é separada. Veja [guia de clientes](../guides/clients.md). |
| `launch claude\|codex [--dir <dir>] -- <args>` | Executa o CLI nativo com configuração do perfil. | Exige serviços habilitados em fase `ready`. Desktop não é lançado por aqui. |

## Erros

Erros são impressos em stderr com a mensagem do gerenciador e saem com código 1. Mensagens genéricas, como `Command failed`, aparecem quando a exceção não é de domínio. Consulte [solução de problemas](../guides/troubleshooting.md) para as mensagens mais comuns.

## Exemplos

```bash
node bin/jev-memory.mjs --profile default status
node bin/jev-memory.mjs clients check claude .
node bin/jev-memory.mjs launch claude --dir . -- --help
```
