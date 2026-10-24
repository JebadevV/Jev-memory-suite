# API e contratos

Propósito: índice dos contratos do gerenciador: CLI, schema de configuração, endpoint de controle do supervisor, painel local, hooks e bridge MCP, e arquivos gerenciados. Público: integradores e mantenedores. Data: 2026-10-22.

O gerenciador não expõe API pública de rede. Os endpoints do supervisor são de loopback e protegidos por bearer. O painel local também escuta apenas em loopback, mas não usa bearer: sua proteção é o cabeçalho `Host` exato e a CSP (veja [T30](../security/threat-model.md)).

| Documento | Conteúdo |
|---|---|
| [cli.md](cli.md) | Comandos, opções globais, saídas e códigos de erro |
| [configuration-schema.md](configuration-schema.md) | Campos do `suite.json`, limites e regras de validação |
| [supervisor-http.md](supervisor-http.md) | `GET /status` e `POST /stop` do supervisor; rotas do painel local, incluindo `GET /gateways/status` |
| [hooks-and-bridge.md](hooks-and-bridge.md) | Comando dos hooks, payloads aceitos, limites e bridge MCP |
| [managed-files.md](managed-files.md) | Formatos de `suite.json`, ponteiros, manifestos, `backup.json` e arquivos de cliente |

Decisões relacionadas: [ADR 0002](../architecture/adr/0002-versioned-engine-installs.md), [ADR 0003](../architecture/adr/0003-transactional-client-registration.md) e [ADR 0004](../architecture/adr/0004-hook-boundary-and-capture-allowlist.md).
