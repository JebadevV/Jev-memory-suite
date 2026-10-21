# Operação

Propósito: descrever a rotina de iniciar, parar, verificar, diagnosticar e reiniciar um perfil, com suas portas e logs. Público: operadores. Data: 2026-10-21.

Os comandos usam o perfil padrão. Para outro perfil, acrescente `--profile <nome>` logo após `node bin/jev-memory.mjs`.

## Rotina

| Ação | Comando | Resultado esperado |
|---|---|---|
| Iniciar | `node bin/jev-memory.mjs start` | Imprime JSON com `phase: "ready"` |
| Verificar | `node bin/jev-memory.mjs status` | `phase: "ready"` e `services` com `ready` |
| Diagnosticar | `node bin/jev-memory.mjs doctor` | Relatório sem segredos |
| Testar MCP | `node bin/jev-memory.mjs mcp` | `handshake: true` e `status` com o escopo |
| Parar | `node bin/jev-memory.mjs stop` | Serviços encerrados |
| Reiniciar | `node bin/jev-memory.mjs restart` | Parada seguida de início |

`recover` executa a mesma sequência que `restart` na implementação atual. Ele não faz diagnóstico nem reparo adicional. Para diagnosticar, use `doctor`.

## Estados do supervisor

| `phase` | Significado | Ação |
|---|---|---|
| `starting` | Filhos ainda sobem | Aguarde. `start` espera até cerca de 45 s. |
| `ready` | Serviços habilitados saudáveis | Normal |
| `failed` | Um filho falhou | Leia os logs; depois `stop` e `start` |
| `stopping` | Parada em andamento | Aguarde |
| `stopped` (saída de `status`) | Nada escutando na porta de controle | Normal para perfil parado |
| `port-conflict` (saída de `status`, código 1) | Porta de controle ocupada por outro processo ou perfil | Veja [solução de problemas](../guides/troubleshooting.md) |

Estados dos serviços em `services`: `starting`, `ready`, `failed` e `stopped`.

## Portas

| Serviço | Padrão | Chave |
|---|---|---|
| Controle | 18877 | `controlPort` |
| AI Memory | 49375 | `memory.port` |
| Jev Gateway | 18878 | `gateway.port` |

Todas escutam apenas em `127.0.0.1`. Em uma máquina com mais de um perfil, cada perfil precisa de três portas distintas (veja [configuração](../guides/configuration.md)).

## Logs

| Arquivo | Conteúdo | Limite |
|---|---|---|
| `.local/profiles/<p>/logs/supervisor.log` | Saída do supervisor | Sem limite implementado |
| `.local/profiles/<p>/logs/memory.log` | Saída do AI Memory | Cerca de 5 MB por execução |
| `.local/profiles/<p>/logs/gateway.log` | Saída do Gateway | Cerca de 5 MB por execução |
| `.local/evidence/*.log` | Saída de `install` e `update` | Sem limite |

Os logs de filhos têm segredos redigidos. A redação não é exaustiva (veja [credenciais](../security/credentials-and-hook-isolation.md)).

Não há rotação de logs. Se o tamanho crescer demais, pare o perfil e mova o arquivo para fora do workspace, depois inicie de novo.

## Rotina de manutenção

1. Consulte `status` e `doctor` antes de iniciar ou parar.
2. Antes de alterar configuração, pare o perfil e faça um backup (veja [backup e recuperação](backup-and-recovery.md)).
3. Depois de qualquer `install`, reinicie o perfil. Versões novas só entram em uso com o processo reiniciado.
4. Verifique o espaço em `.local/engines/`, porque versões antigas não são apagadas automaticamente.
5. Revise `.local/client-backups/` periodicamente, porque backups de registro também não são apagados.

## Quando não reiniciar

- Se houver dúvida sobre a origem de um erro, não repita `start` em loop. Leia os logs e o `doctor` antes.
- Não use `kill` em PIDs. A parada é sempre feita pelo supervisor autenticado; se ele não responder, investigue o processo antes de encerrá-lo.
