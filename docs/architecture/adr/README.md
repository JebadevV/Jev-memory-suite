# Decisões arquiteturais

Propósito: índice das decisões arquiteturais, com estado e link para cada registro. Público: mantenedores. Data: 2026-10-23.

| ADR | Título | Estado |
|---|---|---|
| [0001](0001-engines-and-boundaries.md) | Motores preservados e coordenação local | aceito |
| [0002](0002-versioned-engine-installs.md) | Instalações versionadas dos motores | aceito |
| [0003](0003-transactional-client-registration.md) | Registro transacional nos clientes | aceito |
| [0004](0004-hook-boundary-and-capture-allowlist.md) | Fronteira de hooks e captura por allowlist | aceito |
| [0005](0005-validation-evidence-policy.md) | Política de evidência de validação | aceito |
| [0006](0006-external-projects.md) | Instalação independente dos projetos e memória isolada | aceito |
| [0007](0007-local-semantic-memory.md) | Memória semântica local com modelo verificado | aceito |
| [0008](0008-history-migration.md) | Migração do histórico da instalação original | aceito |
| [0009](0009-gateway-ownership-and-recovery.md) | Dono duplo do Gateway, sonda de portas upstream e reinício limitado | aceito |
| [0010](0010-unified-dashboard.md) | Painel unificado do Jev Gateway, sondagem somente leitura e painel de gateways | aceito (complementado pela ADR 0011) |
| [0011](0011-native-dashboard-and-token-observability.md) | Observabilidade de tokens complementar ao painel incorporado | aceito |
| [0012](0012-antigravity-cli-integration.md) | Integração com o Antigravity CLI (agy): hooks de workspace, MCP global e finalização pelo launcher | aceito |
| [0013](0013-headroom-context-compression.md) | Headroom: compressão de contexto opcional para o Claude, antes do Jev Gateway | aceito (fase 1, somente Claude; estendida pela ADR 0014) |
| [0014](0014-headroom-codex-routing.md) | Headroom para o Codex: roteamento pelo gateway Jev codex, com shim de runtime versionado | aceito (fase 2, Codex) |

Decisões aceitas não são reescritas. Uma mudança de direção exige um novo ADR com número seguinte, que cite o anterior.
