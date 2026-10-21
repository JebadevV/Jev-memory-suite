# Revisão OWASP Top 10 2021 e OWASP ASVS 4.0.3

Propósito: registrar, item a item, a mitigação real ou o risco residual de cada categoria OWASP Top 10 2021 e de cada capítulo ASVS 4.0.3 relevante. Público: mantenedores e revisores. Data: 2026-10-21.

## Natureza da revisão

Esta é uma revisão de mesa, feita sobre o código e os testes do repositório. Não é uma verificação formal ASVS nem uma auditoria externa. Nenhum nível (L1, L2 ou L3) é declarado como atendido. Quando não há evidência, o item aparece como não avaliado.

## OWASP Top 10 2021

| Item | Mitigação real | Risco residual |
|---|---|---|
| **A01 Controle de acesso quebrado** | Supervisor, Gateway e MCP exigem bearer do perfil. Verificação de `Host` no supervisor. Hooks só capturam dentro do workspace e com marcador. Ações de parada só pelo supervisor autenticado. Testes e2e confirmaram `401` sem token para os serviços ativos em cada modo (evidência M5). | Não há autorização por usuário, porque o modelo é de usuário único. Processos da mesma conta podem ler o token. |
| **A02 Falhas criptográficas** | Tokens gerados com 32 bytes aleatórios (`randomBytes`). Comparação em tempo constante no supervisor. Chaves de provedor não são gravadas em disco. | Tráfego em loopback é HTTP, sem TLS. Tokens ficam em arquivo local. Dados da memória não são cifrados em repouso. Modos `0600` não valem no Windows. |
| **A03 Injeção** | Processos são iniciados com `shell: false` e arrays de argumentos. Entradas são validadas com zod em modo estrito. Nomes de perfil, workspace e projeto têm regex. Payloads de hook têm schema. | Conteúdo da memória pode conter instruções (injeção indireta). Responsabilidade é do cliente e do modelo. |
| **A04 Design inseguro** | Fronteiras documentadas ([arquitetura](../architecture/README.md)). Decisões registradas em ADR. Registro de clientes transacional. Captura por allowlist. | TOCTOU no registro. Dependência da confiança nativa dos clientes. |
| **A05 Configuração insegura** | Padrões conservadores: Gateway desligado, embeddings desligados, decaimento e agendador desligados. Portas distintas exigidas. Ambiente dos filhos por allowlist. `AI_MEMORY_BACKFILL_ON_START=false` e `AI_MEMORY_MAINTENANCE__ENABLED=false` forçados. | Operador pode habilitar o Gateway com provedores externos. Windows e AI Memory Windows são suporte experimental no upstream. |
| **A06 Componentes vulneráveis e desatualizados** | Auditorias executadas e correções aplicadas (smol-toml 1.9.1 e pnpm 10.34.6). Veja [dependências](dependencies.md). | Alerta moderado no `hono` do Gateway, em `serveStatic`, que o código do Gateway não usa. Alerta baixo no `esbuild`, dependência de desenvolvimento. `cargo audit` e `cargo deny` não foram executados. |
| **A07 Falhas de identificação e autenticação** | Autenticação por bearer em todos os pontos de entrada locais. Recusa de token ausente, errado ou de outro perfil. | Não há autenticação de usuário nem expiração ou rotação automática de token. O caminho Claude → Gateway → Anthropic não está validado (cabeçalho `Authorization` substituído). |
| **A08 Falhas de integridade de software e dados** | Árvores fixadas por commit; build recusa fontes modificadas; versões imutáveis; ponteiro atômico; Gateway com lockfile congelado e sem scripts de instalação; cargo com `--locked`. | Não há verificação de assinatura de commits além do SHA. Não há SBOM gerado. |
| **A09 Falhas de registro e monitoramento** | Logs de filhos com redação de segredos conhecidos, `Bearer` e `sk-`. Limite de cerca de 5 MB por execução de filho. Estado de serviço exposto por `status` e `doctor`. | Redação não é exaustiva. `supervisor.log` não tem o limite de tamanho. Não há alertas nem rotação de logs. |
| **A10 SSRF** | Endpoints do Gateway validados: host em allowlist, HTTPS ou loopback numérico, sem credenciais, query ou fragmento. `redirect: 'error'` em todas as chamadas `fetch` do gerenciador. Cliente de diagnóstico só acessa loopback. | Hosts da allowlist são definidos pelo operador. Um host malicioso adicionado à allowlist seria aceito. |

## ASVS 4.0.3

| Capítulo | Situação | Evidência e lacunas |
|---|---|---|
| **V1 Arquitetura, design e modelagem de ameaças** | Parcialmente atendido | Componentes, fronteiras e fluxos documentados ([arquitetura](../architecture/README.md), [modelo de ameaças](threat-model.md)). Não há análise formal de todos os fluxos. |
| **V2 Autenticação** | Parcialmente atendido | Bearer por perfil em supervisor, Gateway e MCP. Sem expiração, rotação nem autenticação de usuário. |
| **V4 Controle de acesso** | Parcialmente atendido | Controle por token e por escopo de workspace. Sem autorização por papel, porque não há múltiplos usuários. Isolamento de memória por projeto depende do AI Memory. |
| **V5 Validação, sanitização e codificação** | Parcialmente atendido | zod estrito em configuração, payloads de hook e manifestos; limites de tamanho; `shell: false`. Conteúdo da memória não é validado semanticamente. |
| **V7 Tratamento de erros e registro** | Parcialmente atendido | Erros do hook não expõem detalhes. Logs redigidos e limitados. Não há log estruturado nem trilha de auditoria de comandos da CLI. |
| **V8 Proteção de dados** | Parcialmente atendido | Chaves de provedor só em memória de processo. Tokens e memória em disco, sem cifragem. Retenção indefinida por padrão. |
| **V10 Código malicioso** | Parcialmente atendido | Builds a partir de commits fixados com lockfiles congelados. Sem varredura de malware nem revisão independente dos upstreams além dos testes. |
| **V12 Arquivos e recursos** | Parcialmente atendido | Caminhos validados dentro do perímetro; links e junctions recusados; resposta MCP limitada a 4 MB; logs limitados. TOCTOU no registro. Modos POSIX não aplicados no Windows. |
| **V13 API e serviços web** | Parcialmente atendido | Escuta só em loopback; verificação de `Host`; métodos e ferramentas em allowlist; timeouts nas chamadas de rede e nos hooks. Sem TLS em loopback. |
| **V14 Configuração** | Parcialmente atendido | Padrões conservadores; env do filho por allowlist; configuração validada e estrita. Operador pode alterar padrões de risco (Gateway, endpoints). |

## Itens não avaliados

- Gestão de sessão (V3): não aplicável como sessão web; a suíte não tem sessão de usuário.
- Criptografia (V6): não avaliada em profundidade; a suíte não implementa criptografia própria e não cifra dados em repouso.
- Segurança de API de terceiros (V13, parte de terceiros): depende dos provedores.
- Segurança de código de terceiros (V10): depende dos upstreams.

## Pendências para o gate M7

- Executar `cargo audit` ou `cargo deny`.
- Validar o caminho Claude → Gateway → Anthropic com cabeçalho adequado, ou documentar a limitação como bloqueio.
- Revisar os logs com dados sintéticos para confirmar a redação.
- Validar as ACLs de `.local/` no Windows de forma reproduzível.
