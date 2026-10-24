# LGPD

Propósito: avaliar, sob a Lei Geral de Proteção de Dados (Lei 13.709/2018), o tratamento de dados pessoais feito pela suíte, sua finalidade, minimização, retenção, direitos do titular, transferência e segurança. Público: operadores e responsáveis pela conformidade. Data: 2026-10-22.

Este documento é uma avaliação técnica do comportamento do software. Não é aconselhamento jurídico. Quem usa a suíte com dados de terceiros deve avaliar sua própria base legal e seus compromissos.

## Quais dados são tratados

| Dado | Origem | Onde fica |
|---|---|---|
| Prompts do usuário (`prompt`) | Hook `UserPromptSubmit` | Memória do perfil, se o diretório tiver marcador |
| Entradas e saídas de ferramentas (`tool_input`, `tool_response`) | Hooks de ferramenta | Memória do perfil |
| Identificadores de sessão e de ferramenta | Hooks | Memória do perfil |
| Caminhos do workspace (`cwd`) | Hooks e marcador | Memória e arquivos do perfil |
| Páginas escritas explicitamente pelo usuário | Ferramenta `memory_write_page` | Wiki do perfil |
| Vetores de embedding das páginas | Motor, a partir do texto das páginas | SQLite do perfil, com a mesma retenção e eliminação das páginas de origem |
| Histórico da instalação original do AI Memory | Migração `migrate-history` | Store do perfil `default`, e cópias em `.local/` (backups e staging) |
| Requisições de modelo | Gateway, se habilitado | Não são gravadas pela suíte; são encaminhadas ao provedor |
| Logs de serviços | Supervisor e filhos | `.local/profiles/<p>/logs/` |

Os hooks podem capturar conteúdo de conversas e de ferramentas. Esse conteúdo pode incluir dados pessoais de quem usa o computador ou de terceiros citados no trabalho.

## Finalidade

A finalidade declarada é a memória de contexto de um projeto para o próprio usuário, com registro local. A suíte não usa os dados para outra finalidade, não treina modelos e não faz perfilamento.

## Necessidade e minimização

- A captura só ocorre em diretórios com marcador `.ai-memory.toml` (`--capture-mode allowlist`).
- A suíte não lê transcrições; `transcript_path` e `agent_transcript_path` são descartados.
- O texto final do assistente não é capturado: `last_assistant_message` é removido antes de chegar ao motor, nos eventos `Stop` e `SubagentStop`.
- Embeddings são locais. O modelo all-MiniLM-L6-v2 roda no próprio processo do motor de memória do perfil. Nenhum texto, prompt, memória ou vetor é enviado a serviço externo de embeddings, e a suíte não configura nenhum provedor remoto de embeddings. O modelo é verificado por sha256 antes do uso. A única conexão de rede possível é o download inicial do modelo pelo motor, quando não há cópia local verificada, e ela vai ao Hugging Face oficial com checksum fixado. Essa conexão pode ser evitada com a cópia da instalação original.
- Conexões: o motor de memória só abre conexões em loopback. A verificação foi feita com `Get-NetTCPConnection` na validação de 2026-10-22.
- Busca semântica pode ser desligada com `memory.semanticSearch = false`, que deixa só a busca léxica.
- O Gateway está desligado por padrão.
- Auto-melhoria exige aprovação (`require_approval = true`) e o agendador está desligado.

Os payloads de ferramenta são capturados como recebidos, dentro dos limites de tamanho. A suíte não remove dados pessoais de seu conteúdo. Isso é uma lacuna de minimização: o operador deve escolher quais diretórios marcar.

## Retenção

- Por padrão, o decaimento e a exclusão automática estão desligados (`lambda = 0`, `cold_threshold = 0`, `hard_delete_after_days = 4294967295`).
- Sem política definida, os dados são mantidos por tempo indefinido. **Essa é a principal lacuna de conformidade.**
- Logs de serviços têm limite de cerca de 5 MB por execução de filho, mas `supervisor.log` não tem limite.
- Backups contêm a memória e devem seguir a mesma política (veja [backup e recuperação](../runbooks/backup-and-recovery.md)).
- Os vetores de embedding derivados ficam no SQLite do perfil e precisam seguir a eliminação das páginas a que pertencem. A suíte não verificou se cada operação de exclusão do AI Memory remove os vetores correspondentes. O operador deve confirmar esse efeito antes de depender dele.
- Os backups da migração (`.local/backups/migration-<ts>/`) e o staging (`.local/tmp/migration-staging`) são cópias completas de dados pessoais e de tokens locais. Entram na mesma política de retenção.

O operador deve definir por escrito um prazo, e aplicá-lo com os comandos de exclusão do AI Memory, com confirmação, ou removendo o diretório do perfil com o serviço parado.

## Direitos do titular

Artigo 18 da LGPD. A suíte não oferece interface própria para esses direitos. Os meios disponíveis são os do AI Memory:

| Direito | Meio disponível |
|---|---|
| Confirmação e acesso | Leitura da memória pelas ferramentas (`memory_query`, `memory_read_page`, `memory_recent`) e pelo `backup` |
| Correção | Nova página ou edição pela ferramenta de escrita; versões antigas podem permanecer no histórico |
| Eliminação | `purge-project --confirm` ou `purge-session`, conforme o upstream; ambos são destrutivos e precisam de confirmação. Veja [operação e recuperação](../runbooks/README.md). |
| Portabilidade | Exportação pelo `backup` (tarball com wiki, SQLite e configuração) |

Dados que já estão em backups precisam ser eliminados também dos backups, ou o operador deve documentar a limitação.

## Migração do histórico

O comando `migrate-history` copia dados pessoais da instalação original do AI Memory para o perfil da suíte, na mesma máquina. A finalidade é a mesma da memória do perfil: contexto de trabalho do próprio usuário. A instalação original não é alterada: a fonte é lida por cópia, com sha256 antes e depois, e a migração falha se ela mudar.

Consequências para o operador:

- Na eliminação, considere **os dois stores** (a instalação original e o perfil da suíte), além dos backups em `.local/backups/` e do staging em `.local/tmp/`.
- Usuários, credenciais e sessões web da origem não são copiados. A lista está no relatório, no campo `notMigrated`.
- Sessões capturadas nas duas bases mantêm a versão da suíte. A versão da origem fica na fonte e no backup, e não é apagada pela migração.

Procedimento e relatório em [migração do histórico](../guides/migration.md).

## Transferência a terceiros

- **Por padrão, nenhum dado sai da máquina.** Os embeddings são locais e o Gateway está desligado. A suíte não configura nenhum provedor externo de embeddings.
- **Com o Gateway habilitado**, as requisições de modelo, incluindo prompts e respostas, são encaminhadas ao `upstreamUrl` e, quando o roteamento Jev está ativo, ao `jevUrl`. Os endereços padrão são de terceiros. Verifique os termos e a localização de tratamento desses provedores antes de habilitar.
- **Provedor do Jev.** Com `JEV_ROUTING=true`, o Gateway envia a cada requisição ao `jevUrl` (padrão de terceiros) o prompt de sistema, que inclui instruções de projeto (como `CLAUDE.md` e `AGENTS.md`) e a memória injetada, além de até 60.000 caracteres do estado da conversa e até 48.000 caracteres de descrições de ferramentas. Vale para o gateway da suíte e para os gateways iniciados pelo launcher. O modo `metering` define `JEV_ROUTING=false`. Esse envio é transferência de código e de dados de projeto a terceiros: verifique os termos e a localização de tratamento do provedor antes de manter o roteamento ligado.
- **Transferência internacional** (artigo 33) depende do provedor escolhido pelo operador. A suíte não determina o país de tratamento.

## Segurança

Medidas técnicas (artigo 46): autenticação local por token, escuta em loopback, validação de entrada, redação de logs e isolamento de hooks. Lacunas: dados em repouso não são cifrados, a proteção de arquivos no Windows depende de ACLs, e não há notificação automática de incidente.

## Princípios e responsabilidade

Princípios do artigo 6 avaliados:

- **Finalidade e adequação:** atendidos quando a captura é restrita a projetos marcados.
- **Necessidade:** parcialmente atendido. A captura de payloads de ferramenta não é filtrada por dado pessoal.
- **Livre acesso e transparência:** a documentação descreve o que é capturado e onde fica.
- **Qualidade:** dependente da memória do próprio usuário.
- **Segurança e prevenção:** parcialmente atendidos (veja [revisão OWASP/ASVS](owasp-asvs-review.md)).
- **Responsabilização:** o operador é responsável pela política de retenção, pela escolha de diretórios marcados e pelos provedores configurados.

## Pendências

1. Definir política de retenção e aplicá-la.
2. Decidir se o conteúdo de ferramentas deve ser filtrado antes da captura.
3. Avaliar os provedores habilitados e seus termos antes de usar o Gateway com dados reais.
4. Documentar o procedimento de eliminação, incluindo backups.
