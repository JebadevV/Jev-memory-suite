# ADR 0007 — memória semântica local

Propósito: registrar a reativação dos embeddings locais nativos do AI Memory e as regras de provisionamento e verificação do modelo. Público: mantenedores e revisores de segurança. Data: 2026-10-22. Estado: aceito.

## Contexto

A instalação original do AI Memory faz busca híbrida com vetores locais. A suíte gravava `embedding_provider = "none"` em todo perfil novo, o que desligava a busca vetorial: as consultas dependiam só do léxico. O motor 3.1.2 já inclui embeddings locais (candle, modelo all-MiniLM-L6-v2, 384 dimensões), com sha256 fixados em `upstream/ai-memory/crates/ai-memory-llm/src/local.rs`. O motor só usa esse caminho quando o provedor é `local` explicitamente.

## Decisão

- **Perfis novos** recebem `embedding_provider = "local"`. A linha é gravada por `initMemory` em `src/install.ts`.
- **Perfis existentes.** A cada `start`, `syncEmbeddingProvider` ajusta somente a primeira linha gerida pela suíte (`none` ou `local`). Qualquer outro provedor é configuração do usuário e não é tocado.
- **Opt-out.** `memory.semanticSearch = false` em `suite.json` (padrão `true`) grava `none`. A busca volta a ser só léxica.
- **Provedor `local` sem fallback.** Se o modelo não estiver disponível ou não passar na verificação, o motor falha em vez de trocar de provedor. A suíte não configura nenhum provedor externo de embeddings.
- **Provisionamento verificado.** `ensureLocalModel` (`src/models.ts`) confere os três arquivos (`model.safetensors`, `tokenizer.json`, `config.json`) contra os sha256 fixados. Um cache compartilhado e regenerável fica em `.local/models/all-MiniLM-L6-v2/`. Cada perfil recebe `<perfil>/memory/models/all-MiniLM-L6-v2/`, com arquivos por hardlink ao cache; se o hardlink falhar, a cópia é feita e verificada.
- **Fontes, nesta ordem.** (1) Cópia verificada da instalação original, em `%LOCALAPPDATA%\ai-memory\models\all-MiniLM-L6-v2`, somente leitura. (2) Sem fonte válida, o próprio motor baixa o modelo do Hugging Face oficial e confere o checksum fixado; se não bater, falha.
- **Arquivo divergente não é sobrescrito.** Se um arquivo do perfil existir e não bater o sha256, o provisionamento para com a mensagem `refusing to overwrite`. O operador move o arquivo para fora e tenta de novo.
- **Backfill.** `backfill_on_start = false` continua. A decisão 4 do projeto trata da importação de sessões antigas, que é distinta do backfill de embeddings de páginas. Esse backfill roda no `start` e indexa as páginas `latest` que ainda não têm vetor.

## Alternativas rejeitadas

- **Provedor remoto de embeddings** (serviço de API de terceiros). Enviaria memórias e consultas para fora da máquina, o que contraria a premissa de dados locais descrita em [LGPD](../../security/lgpd.md).
- **Ollama ou endpoint compatível com OpenAI em loopback.** Exigiria um serviço adicional a instalar, configurar e manter, com um processo a mais de que o motor passaria a depender. Não foi validado.
- **Manter `none`.** Mantém a consulta sem vetores e a suíte fora da paridade com a instalação original.

## Consequências

- **Custo de execução.** A inferência roda dentro do processo do motor de cada perfil em execução. Os três arquivos do modelo ocupam cerca de 92 MB em disco. O consumo de RAM e CPU não foi medido na validação.
- **Primeira execução sem fonte local.** Se a instalação original não estiver disponível e não houver cópia verificada em `.local/models/`, o motor precisa de rede para baixar o modelo.
- **Perfis de projetos externos** recebem o modelo no próximo `start` depois desta mudança.
- **Dados derivados.** Os vetores ficam no SQLite do perfil e seguem a mesma retenção e eliminação das páginas. Ver [LGPD](../../security/lgpd.md).

## Validação

- `test/models.test.ts` cobre a verificação, o provisionamento e a recusa de sobrescrita. `test/install.test.ts` e `test/config.test.ts` cobrem a linha gerida e o padrão de `semanticSearch`.
- `npm run test:semantic` executa o motor real em perfil descartável: uma consulta com termo ausente de todas as páginas retorna a página correta pelo vetor, e o resultado se repete após reinício.
- Registro: `.local/evidence/semantic-e2e.json` e o histórico de [progress.md](../../../progress.md), Fase 2.
- Limitações registradas: o caminho de cópia do `linkOrCopy` não tem teste próprio; a verificação de localidade foi feita só no Windows.
