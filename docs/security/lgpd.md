# LGPD

Propósito: avaliar, sob a Lei Geral de Proteção de Dados (Lei 13.709/2018), o tratamento de dados pessoais feito pela suíte, sua finalidade, minimização, retenção, direitos do titular, transferência e segurança. Público: operadores e responsáveis pela conformidade. Data: 2026-10-21.

Este documento é uma avaliação técnica do comportamento do software. Não é aconselhamento jurídico. Quem usa a suíte com dados de terceiros deve avaliar sua própria base legal e seus compromissos.

## Quais dados são tratados

| Dado | Origem | Onde fica |
|---|---|---|
| Prompts do usuário (`prompt`) | Hook `UserPromptSubmit` | Memória do perfil, se o diretório tiver marcador |
| Entradas e saídas de ferramentas (`tool_input`, `tool_response`) | Hooks de ferramenta | Memória do perfil |
| Identificadores de sessão e de ferramenta | Hooks | Memória do perfil |
| Caminhos do workspace (`cwd`) | Hooks e marcador | Memória e arquivos do perfil |
| Páginas escritas explicitamente pelo usuário | Ferramenta `memory_write_page` | Wiki do perfil |
| Requisições de modelo | Gateway, se habilitado | Não são gravadas pela suíte; são encaminhadas ao provedor |
| Logs de serviços | Supervisor e filhos | `.local/profiles/<p>/logs/` |

Os hooks podem capturar conteúdo de conversas e de ferramentas. Esse conteúdo pode incluir dados pessoais de quem usa o computador ou de terceiros citados no trabalho.

## Finalidade

A finalidade declarada é a memória de contexto de um projeto para o próprio usuário, com registro local. A suíte não usa os dados para outra finalidade, não treina modelos e não faz perfilamento.

## Necessidade e minimização

- A captura só ocorre em diretórios com marcador `.ai-memory.toml` (`--capture-mode allowlist`).
- A suíte não lê transcrições; `transcript_path` é descartado.
- Embeddings estão desligados. Nenhum dado é enviado a um serviço de embeddings por padrão.
- O Gateway está desligado por padrão.
- Auto-melhoria exige aprovação (`require_approval = true`) e o agendador está desligado.

Os payloads de ferramenta são capturados como recebidos, dentro dos limites de tamanho. A suíte não remove dados pessoais de seu conteúdo. Isso é uma lacuna de minimização: o operador deve escolher quais diretórios marcar.

## Retenção

- Por padrão, o decaimento e a exclusão automática estão desligados (`lambda = 0`, `cold_threshold = 0`, `hard_delete_after_days = 4294967295`).
- Sem política definida, os dados são mantidos por tempo indefinido. **Essa é a principal lacuna de conformidade.**
- Logs de serviços têm limite de cerca de 5 MB por execução de filho, mas `supervisor.log` não tem limite.
- Backups contêm a memória e devem seguir a mesma política (veja [backup e recuperação](../runbooks/backup-and-recovery.md)).

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

## Transferência a terceiros

- **Por padrão, nenhum dado sai da máquina.** Embeddings e LLMs estão desligados e o Gateway está desligado.
- **Com o Gateway habilitado**, as requisições de modelo, incluindo prompts e respostas, são encaminhadas ao `upstreamUrl` e, quando o roteamento Jev está ativo, ao `jevUrl`. Os endereços padrão são de terceiros. Verifique os termos e a localização de tratamento desses provedores antes de habilitar.
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
