# API e contratos

Propósito: índice dos contratos do gerenciador: CLI, schema de configuração, endpoint de controle do supervisor, hooks e bridge MCP, e arquivos gerenciados. Público: integradores e mantenedores. Data: 2026-10-21.

O gerenciador não expõe API pública de rede. Os endpoints HTTP são de loopback, protegidos por bearer, e servem apenas ao próprio gerenciador e aos clientes.

| Documento | Conteúdo |
|---|---|
| [cli.md](cli.md) | Comandos, opções globais, saídas e códigos de erro |
| [configuration-schema.md](configuration-schema.md) | Campos do `suite.json`, limites e regras de validação |
| [supervisor-http.md](supervisor-http.md) | `GET /status` e `POST /stop` do supervisor |
| [hooks-and-bridge.md](hooks-and-bridge.md) | Comando dos hooks, payloads aceitos, limites e bridge MCP |
| [managed-files.md](managed-files.md) | Formatos de `suite.json`, ponteiros, manifestos, `backup.json` e arquivos de cliente |

Decisões relacionadas: [ADR 0002](../architecture/adr/0002-versioned-engine-installs.md), [ADR 0003](../architecture/adr/0003-transactional-client-registration.md) e [ADR 0004](../architecture/adr/0004-hook-boundary-and-capture-allowlist.md).
