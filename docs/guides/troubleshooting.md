# Solução de problemas

Propósito: associar sintomas e mensagens do gerenciador às causas prováveis e às ações seguras. Público: operadores e usuários. Data: 2026-10-21.

Comece sempre por `node bin/jev-memory.mjs --profile <nome> doctor`. Ele não mostra valores de segredos.

## Tabela de sintomas

| Sintoma ou mensagem | Causa provável | Ação |
|---|---|---|
| `Profile is already running` | `start` chamado com o supervisor ativo | Use `status`. Para reiniciar, use `restart`. |
| `Control port <porta> is used by another supervisor or process` | A porta de controle responde com `401` ou `403`: outro processo ou outro perfil a ocupa | Mude `controlPort` com `config` (perfil parado). Não mate o processo cegamente; identifique-o primeiro. |
| `port-conflict` em `status` | Mesma causa, com saída `1` | Igual à linha anterior |
| Perfil novo não inicia enquanto `default` roda | Perfis novos copiam as portas padrão 18877, 49375 e 18878 | Defina três portas distintas com `config` antes do `start` |
| `401` ao chamar `/status`, `/stop` ou MCP | Token errado: outro perfil ou arquivo de token diferente | Confirme `--profile`. Use `launch` ou `clients` para configurar os clientes, em vez de copiar tokens. Não cole tokens em chats ou arquivos versionados. |
| `Gateway requires the two configured JMS_* key environment variables` | Variáveis de chave ausentes no ambiente | Defina as duas variáveis cujos nomes estão em `gateway.upstreamKeyEnv` e `gateway.jevKeyEnv` |
| `Memory engine not installed; run: jev-memory install memory` | Ponteiro sem motor de memória | Execute `install memory` |
| `Gateway engine not installed; run: jev-memory install gateway` | Ponteiro sem Gateway | Execute `install gateway` |
| `doctor` mostra `installed` falso | Motor ausente ou ponteiro removido | Execute `install <motor>` |
| `Referenced gateway version is incomplete; refusing to remove it` | Diretório referenciado por `current.json` sem `.jev-suite-complete` ou sem `dist/index.js` | Repare manualmente. Não apague o diretório referenciado. |
| `Upstream source modified; refusing to build` | Alterações não commitadas em `upstream/` | Reverta-as ou faça commit; não compile a partir de fonte alterada |
| `Startup timeout; inspect local logs` | Filho não ficou saudável em cerca de 45 s | Leia `logs/memory.log` ou `logs/gateway.log` e `logs/supervisor.log` |
| `Supervisor failed; inspect local logs` ou `Service startup failed` | Um filho saiu ou falhou no health check | Mesma ação da linha anterior |
| `Stop profile before changing configuration` | `config` com perfil em execução | Execute `stop` e repita |
| `Hook rejected or unavailable; run doctor` (stderr do hook) | Payload inválido, `cwd` fora do workspace, timeout de 20 s, saída acima de 256 KiB ou binário ausente | Rode `doctor`. Verifique se o `cwd` está dentro do workspace e se o perfil está `ready`. |
| `No .ai-memory.toml scope marker between ...` | Nenhum marcador nos ancestrais do diretório | Registre com `clients install <host> <dir>`. Sem marcador, a captura fica desligada. |
| `Scope marker <path> declares ..., profile expects ...` | Marcador de outro projeto | Revise o marcador. Não o altere sem confirmar o projeto correto. |
| `Workspace client registration belongs to profile <x>` | Registro de outro perfil no diretório | Remova com o perfil dono ou lance com ele |
| `Managed MCP entry changed; refusing overwrite` ou `Managed hook changed` | Alteração manual nas entradas registradas | Revise o diff. A suíte não sobrescreve alterações manuais. |
| `MCP name already in use; refusing overwrite` | Já existe `jev_memory_suite` sem manifesto | Remova ou renomeie a entrada existente após revisão |
| `Registration failed and rollback was incomplete` | Falha de escrita com rollback parcial | Restaure a partir de `.local/client-backups/<timestamp>-<host>/` ([backup e recuperação](../runbooks/backup-and-recovery.md)) |
| `mcp` falha com `Required memory tools missing` | Servidor respondeu sem as ferramentas esperadas | Confirme a versão do motor instalada e o perfil iniciado |
| `MCP response too large` | Resposta acima de 4 MB | Reduza o escopo da consulta |
| Claude ou Codex não listam o servidor | Confiança nativa não concedida | Veja [clientes](clients.md#etapas-de-confiança-nativa) |
| Codex ignora hooks | Hooks não revisados ou alterados | Revise em `/hooks` no Codex |
| Perfil novo herdando a porta de controle 18877 reporta `port-conflict` | O perfil copiou as portas padrão enquanto `default` ou outro processo usa 18877 | Defina portas distintas com `config` (perfil parado) e repita `start` |
| `codex exec` não lança o servidor MCP da suíte, mesmo com `-c` | `-c` colocado antes do subcomando `exec` é ignorado pelo `codex exec` | O lançamento da suíte já insere os overrides depois de `exec`, `e`, `resume`, `review` ou `fork`. Se usar o Codex manualmente, coloque `-c` depois do subcomando. |
| `codex exec` fica parado sem resposta | `codex exec` espera stdin | Feche a entrada, por exemplo com `< /dev/null` |
| O modelo chama uma ferramenta de outro servidor MCP com o mesmo nome | Outro servidor MCP global (por exemplo, um `ai-memory` do usuário) expõe ferramentas de mesmo nome | Nomeie `jev_memory_suite` explicitamente nos prompts. Veja [modelo de ameaças](../security/threat-model.md) (T19). |

## Diagnóstico passo a passo

1. `doctor`: confira `installed`, `engines`, `enabled`, `credentials` (somente presença) e `supervisor`.
2. `status`: `ready` indica que os serviços habilitados estão saudáveis. `stopped` indica que nada está rodando. `port-conflict` indica porta ocupada.
3. Leia os logs em `.local/profiles/<perfil>/logs/`. Os logs de filhos são limitados a cerca de 5 MB por execução e têm segredos redigidos por padrão.
4. Para falhas de build, leia `.local/evidence/memory-build.log` e `gateway-build.log`.
5. `mcp`: confirma o handshake e o escopo, sem depender de cliente nativo.

## Quando parar

- Não apague `.local/engines/`, `.local/profiles/` ou `.local/client-backups/` como primeiro passo. Esses diretórios podem conter o único estado que permite recuperação.
- Se o problema envolver `ai-memory purge-project`, `reset` ou `restore`, pare e leia [operação e recuperação](../runbooks/README.md) antes de executar qualquer comando.
