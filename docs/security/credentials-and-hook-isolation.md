# Credenciais e isolamento de hooks

Propósito: listar onde cada segredo fica, quem o lê e como o processo de hooks e os filhos são isolados. Público: mantenedores e operadores. Data: 2026-10-21.

Este documento descreve locais e regras. Não contém valores de segredos, e os comandos de exemplo não devem ser executados com conteúdo de arquivos de segredo colado em chats, issues ou commits.

## Inventário de segredos

| Segredo | Onde fica | Quem usa | Persistência |
|---|---|---|---|
| Token de controle do perfil | `.local/profiles/<p>/control-token` (64 hex) | CLI e supervisor. Não é entregue a clientes nem ao Gateway. | Arquivo. Criado no primeiro uso. Não substituído se inválido. |
| Chave de roteador do perfil | `.local/profiles/<p>/router-token` (64 hex) | `launch` (passado ao cliente nativo como `ANTHROPIC_AUTH_TOKEN` ou `JMS_ROUTER_KEY`), e como `ROUTER_API_KEY` do Gateway. O Gateway recusa o `control-token`; o supervisor recusa o `router-token`. | Arquivo. Criado no primeiro uso. Não substituído se inválido. |
| Credencial do AI Memory | `.local/profiles/<p>/memory/auth-tokens/default` | AI Memory; cliente de diagnóstico `jev-memory mcp` | Arquivo gerado por `ai-memory init` em diretório novo. Nunca recriada. |
| Chave do upstream | Variável de ambiente cujo nome está em `gateway.upstreamKeyEnv` (padrão `JMS_UPSTREAM_KEY`) | Supervisor, que a repassa somente ao filho do Gateway como `UPSTREAM_API_KEY` | Apenas na memória dos processos. Não gravada. |
| Chave do Jev | Variável de ambiente cujo nome está em `gateway.jevKeyEnv` (padrão `JMS_JEV_KEY`) | Supervisor, que a repassa somente ao filho do Gateway como `TYPESAFE_API_KEY` | Idem |

Regras:

- Chaves são lidas do ambiente no momento do `start`. O gerenciador nunca as escreve em arquivo nem em log.
- O conteúdo de `control-token` e de `auth-tokens` nunca é impresso. `doctor` informa apenas se o arquivo existe.
- Em cópias de backup do perfil (diretório `.local/profiles/<p>/`), os tokens estão presentes. Trate a cópia como segredo.

## Isolamento do ambiente dos filhos

Os filhos (`ai-memory`, Gateway) recebem um ambiente construído a partir de uma **allowlist** (`baseEnv`):

- Variáveis de sistema necessárias para executar: `PATH`, `SystemRoot`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, e similares.
- `TEMP` e `TMP` apontam para `.local/tmp`.
- `CARGO_HOME` aponta para `.local/cargo-home` e o cache do npm para `.local/npm-cache`.
- `AI_MEMORY_BACKFILL_ON_START=false` e `AI_MEMORY_MAINTENANCE__ENABLED=false`. Defesa em profundidade: hooks nativos não devem importar histórico anterior do cliente.

Variáveis do ambiente do usuário que não estão na allowlist não chegam aos filhos.

## Redação de logs

Logs de filhos passam por esta redação antes de serem gravados:

- Substitui os valores das chaves conhecidas (token de controle, chave de roteador e as duas chaves de provedor) por `[REDACTED]`.
- Substitui `Bearer <valor>` por `Bearer [REDACTED]`.
- Substitui padrões `sk-…` por `[REDACTED]`.
- O tamanho de cada linha é limitado a 16 KiB, e o total por execução de filho a cerca de 5 MB.

A redação é por padrão e não é exaustiva. Segredos em outros formatos podem aparecer. `supervisor.log` recebe a saída do próprio supervisor sem essa redação.

## Isolamento dos hooks

1. Os hooks são executados com `dist/src/hook.js`, que valida o payload antes de ler a configuração ou o token.
2. `transcript_path` é removido, e o hook não lê transcrições.
3. O `cwd` precisa estar dentro do workspace. Links e junctions são recusados.
4. O processo `ai-memory hook` roda com `--capture-mode allowlist`. Sem marcador `.ai-memory.toml` nos ancestrais, nada é capturado.
5. O hook não recebe segredos de provedor. Ele só fala com o AI Memory do próprio perfil, em loopback.
6. Limites de tempo (20 s) e de saída (256 KiB) encerram processos que se comportam mal.

Detalhes em [ADR 0004](../architecture/adr/0004-hook-boundary-and-capture-allowlist.md) e [hooks e bridge](../api/hooks-and-bridge.md).

## O que não é isolado

- **Outros MCPs do cliente.** `launch` não usa `--strict-mcp-config`. Os outros servidores MCP configurados continuam carregados.
- **Dados entre clientes do mesmo perfil.** Claude, Codex e Desktop compartilham a mesma memória do perfil, por desenho.
- **Hooks globais do AI Memory.** Se o usuário tiver uma instalação global, seus hooks podem ler `.ai-memory.toml`. A suíte não controla esses hooks.
- **Processos da mesma conta de usuário.** Qualquer processo da conta pode ler os arquivos de segredo, porque o Windows não aplica os modos POSIX.

## Operação segura

- Não cole `control-token`, `router-token` ou `auth-tokens` em chats, issues ou logs.
- Não versione `.local/`. O `.gitignore` já o exclui em qualquer nível.
- Se um token for exposto, pare o perfil, remova o arquivo de token do perfil e inicie de novo, para que a suíte gere um novo token. Para a credencial do AI Memory, revise o procedimento antes, porque ela não é recriada automaticamente. Depois revogue os clientes que a usavam.
- Se uma chave de provedor for exposta, revogue-a no provedor. A suíte não tem como invalidar chaves externas.
