# Modelo de ameaças

Propósito: identificar ativos, atores, fronteiras e ameaças da suíte, com as mitigações implementadas e o risco que permanece. Público: mantenedores e revisores de segurança. Data: 2026-10-21.

## Escopo

Máquina de um único usuário, com Windows como plataforma validada. Inclui os processos da suíte, os arquivos em `.local/`, os arquivos de cliente no workspace e os dois motores. Não inclui a segurança dos clientes nativos (Claude, Codex), dos provedores externos nem do sistema operacional.

## Ativos

| Ativo | Localização | Sensibilidade |
|---|---|---|
| Token de controle do perfil | `.local/profiles/<p>/control-token` | Alta: autoriza operar o supervisor (parar serviços, consultar estado) |
| Chave de roteador do perfil | `.local/profiles/<p>/router-token` | Alta: é a chave que os clientes nativos recebem para usar o Gateway |
| Credencial do AI Memory | `.local/profiles/<p>/memory/auth-tokens/` | Alta: autoriza leitura e escrita na memória |
| Chaves de provedor | Variáveis de ambiente, nunca em disco | Alta |
| Memória (wiki, SQLite, observações) | `.local/profiles/<p>/memory/` | Alta: pode conter dados pessoais e de projeto |
| Logs de serviços | `.local/profiles/<p>/logs/` | Média: podem conter conteúdo operacional |
| Configurações de cliente | `.mcp.json`, `.codex/*`, `.claude/settings.local.json` | Média: definem o que o cliente executa |
| Código dos motores | `upstream/` e `.local/engines/` | Média: integridade da cadeia de build |

## Atores

- **Usuário legítimo**, operando a CLI.
- **Cliente nativo** (Claude Code, Codex), que chama hooks e MCP com dados que podem ser maliciosos.
- **Processo local da mesma conta**, que pode tentar conectar às portas de loopback.
- **Conteúdo recuperado da memória**, que pode conter instruções disfarçadas.
- **Provedores externos**, quando o Gateway está habilitado.
- **Mantenedor de upstream** e **registries de pacotes**, na cadeia de suprimento.

## Ameaças e mitigações

| ID | Ameaça | Mitigação implementada | Risco residual |
|---|---|---|---|
| T1 | Processo local acessa o supervisor e para os serviços | Bearer por perfil com comparação em tempo constante; verificação de `Host`; escuta apenas em `127.0.0.1` | Processo da mesma conta lê o arquivo de token. Limite do modelo de usuário único. |
| T2 | Processo local acessa o AI Memory ou o Gateway diretamente | Bearer no AI Memory; o Gateway aceita a chave de roteador (`router-token`), não o `control-token`; loopback apenas | Mesma limitação de T1 |
| T3 | Payload de hook malicioso (caminho, profundidade, tamanho, evento falso) | Allowlists; schemas por evento; profundidade ≤ 32; stdin ≤ 1 MB; validação antes da leitura de configuração | Campos extras são repassados ao AI Memory (`looseObject`). Validação de conteúdo fica com o AI Memory. |
| T4 | `cwd` apontando para fora do workspace ou para links | `realpath` e recusa de links e junctions | Diferenças de caixa no Windows são tratadas por comparação em minúsculas; não há teste de todos os casos |
| T5 | Captura de dados de outro projeto | Captura só com marcador `.ai-memory.toml` e `--capture-mode allowlist` | Marcador pode ser criado indevidamente pelo próprio usuário; hooks globais do AI Memory podem interagir (veja [ADR 0004](../architecture/adr/0004-hook-boundary-and-capture-allowlist.md)) |
| T6 | Memória contém instruções que o modelo executa (injeção indireta) | Conteúdo recuperado é tratado como dado; a suíte não executa nada a partir da memória | Mitigação depende do cliente e do modelo. Risco permanece. |
| T7 | Segredo vaza para log | Redação de chaves conhecidas, `Bearer …` e `sk-…`; logs limitados a ~5 MB por execução | Redação por padrão não é exaustiva. Segredos fora desses formatos podem aparecer. |
| T8 | Dados saem da máquina pelo Gateway | Gateway desabilitado por padrão; hosts em allowlist; HTTPS obrigatório (exceto loopback) | Quando habilitado, o conteúdo das requisições vai aos provedores configurados |
| T9 | Configuração de cliente adulterada ou sobrescrita | Manifesto com digest; `check` detecta alteração; escrita atômica; backup; rollback | Janela TOCTOU entre preflight e escrita |
| T10 | Entrada de outro MCP ou hook removida por engano | `remove` apaga só entradas próprias; testes de preservação | Depende da correção dos testes de cada cliente |
| T11 | Versão de motor incompleta ou modificada é servida | Marcador `.jev-suite-complete`; tree verificado; fonte com alterações é recusada | Build depende de toolchain local; não há verificação de assinatura além do commit |
| T12 | Substituição de executável em uso | Versões imutáveis por árvore; ponteiro atômico | Espaço em disco crescente |
| T13 | Cadeia de suprimento (npm, cargo, pnpm, upstream) | Lockfiles; `--frozen-lockfile --ignore-scripts` no Gateway; `--locked` no cargo; subtrees fixados | Auditorias incompletas (veja [dependências](dependencies.md)) |
| T14 | Perda ou corrupção de dados | Backup online documentado; restore com confirmação | Não há backup automático. Ver [backup e recuperação](../runbooks/backup-and-recovery.md). |
| T15 | Exclusão acidental de memória | Comandos destrutivos do AI Memory exigem confirmação; a suíte não os chama | Operador pode executá-los manualmente |
| T16 | Conflito com instalação global do AI Memory | Documentado; hooks são escopados por marcador | Não resolvido automaticamente |
| T17 | Porta ocupada por processo estranho faz a suíte agir sobre ele | Supervisor só para filhos que criou; `stop` nunca mata PIDs; porta ocupada vira `port-conflict` | Nenhum conhecido |
| T18 | Retenção indefinida de dados pessoais | Decaimento e exclusão automática desligados por padrão (explícito, não oculto) | Política de retenção é responsabilidade do operador ([LGPD](lgpd.md)) |
| T19 | Confusão de ferramentas: o modelo escolhe uma ferramenta homônima de outro servidor MCP (por exemplo, um `ai-memory` global do usuário) | Procedimentos e prompts nomeiam o servidor `jev_memory_suite` explicitamente; solução de problemas documenta o caso | Não há controle da suíte sobre outros servidores MCP do cliente. Risco residual: o modelo pode escolher a ferramenta errada, inclusive em leitura. Os hooks globais do AI Memory do usuário também leem `.ai-memory.toml`. |

## Achados corrigidos

### Chave do roteador igual ao token de controle (corrigido)

- **Achado:** a chave dada aos clientes nativos e a chave de controle do supervisor eram o mesmo segredo. Um cliente que recebesse a chave do roteador também poderia controlar o perfil.
- **Correção:** implementada neste conjunto de alterações, com dois segredos separados. O `router-token` (64 hexadecimais) é o único entregue aos clientes nativos e ao Gateway como chave de roteador. O `control-token` fica restrito ao supervisor. O Gateway recusa o `control-token`, e o supervisor recusa o `router-token`.
- **Verificação:** `npm run test:e2e` (4/4) confirma que o Gateway responde 401 ao `control-token` e o supervisor responde 401 ao `router-token`; teste unitário cobre a allowlist de arquivos de token (53/53).
- Os arquivos estão descritos em [arquivos gerenciados](../api/managed-files.md) e o inventário de segredos em [credenciais](credentials-and-hook-isolation.md).

## Riscos residuais principais

1. Proteção de arquivos depende das ACLs do Windows, porque os modos POSIX são ignorados.
2. Caminho Claude → Gateway → Anthropic não validado, pela diferença de cabeçalho de autenticação.
3. Injeção indireta a partir da memória.
4. Retenção indefinida e ausência de cifragem em repouso.
5. TOCTOU no registro de clientes.
6. Validação nativa dos clientes ainda pendente (ADR 0005).
7. Confusão de ferramentas com servidores MCP globais de mesmo nome (T19).
