# Segurança

Propósito: índice da documentação de segurança, com o estado do gate de revisão e as fronteiras que ele cobre. Público: mantenedores e revisores. Data: 2026-10-21.

## Estado do gate

O gate de segurança **não está aprovado**. A revisão feita até agora é documental, de mesa, e não substitui uma auditoria. Os itens de revisão final estão no marco M7, que está em fechamento em [tests.json](../../tests.json).

Regras que valem durante a revisão:

- Validações usam dados sintéticos. Não use credenciais reais nem memórias pessoais em testes.
- Nenhuma instalação global do usuário é modificada pela suíte. Os caminhos de escrita estão em `.local/` e nos arquivos de cliente do workspace, com backup.

## Documentos

| Documento | Conteúdo |
|---|---|
| [Modelo de ameaças](threat-model.md) | Ativos, atores, ameaças, mitigações e risco residual |
| [Revisão OWASP Top 10 e ASVS](owasp-asvs-review.md) | Cada item A01 a A10 e capítulos ASVS 4.0.3 relevantes |
| [Credenciais e isolamento de hooks](credentials-and-hook-isolation.md) | Onde ficam os segredos, quem os lê e como os hooks são isolados |
| [LGPD](lgpd.md) | Tratamento de dados pessoais, retenção, direitos do titular e transferência |
| [Dependências](dependencies.md) | Versões, auditorias executadas e pendências |

## Pontos de atenção

- Windows ignora modos POSIX. A proteção dos arquivos de segredo depende das ACLs do perfil do usuário.
- A suíte não cifra os dados em repouso.
- Retenção é indefinida por padrão. Sem política definida pelo operador, a memória cresce sem limite.
- Exclusão de memória é destrutiva e não é automatizada pela suíte.
- Provedores de LLM e embeddings ficam desligados (`embedding_provider = "none"`). Com o Gateway habilitado, o conteúdo das requisições vai aos provedores configurados.
- A chave de roteador dada aos clientes é separada do token de controle do supervisor (corrigido neste conjunto de alterações; veja [modelo de ameaças](threat-model.md#achados-corrigidos)).
- Ferramentas homônimas de outros servidores MCP globais podem ser escolhidas pelo modelo (T19). Nomeie `jev_memory_suite` nos prompts.
