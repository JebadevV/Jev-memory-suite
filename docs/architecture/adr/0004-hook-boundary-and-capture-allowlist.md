# ADR 0004 — fronteira de hooks e captura por allowlist

Propósito: registrar como o hook nativo valida a entrada e restringe a captura a diretórios marcados. Público: mantenedores e revisores de segurança. Data: 2026-10-21. Estado: aceito.

## Contexto

Os clientes nativos chamam o hook com JSON no stdin. Esse conteúdo não é confiável: pode trazer `cwd` apontando para fora do workspace, caminhos de transcrição ou profundidade excessiva. Se a captura não for restrita, dados de outros projetos entram na memória. Além disso, um AI Memory global instalado pelo usuário pode ter hooks próprios que leem `.ai-memory.toml`.

## Decisão

- **Ordem de validação:** agente e evento em allowlist; profundidade do payload até 32; stdin até 1 MB; schema zod por evento. Tudo isso acontece antes de a configuração ser lida.
- **Schemas.** `session_id` aceita `[A-Za-z0-9._:-]` com até 200 caracteres. `cwd` tem até 2048 caracteres. `prompt` tem até 200000. `tool_name` tem até 200. `hook_event_name`, quando presente, deve corresponder ao evento.
- **Caminho canônico.** `cwd` deve ser a raiz do workspace ou um descendente, verificado com `realpath`. Links simbólicos e junctions são recusados.
- **Transcrições.** `transcript_path` é descartado. O hook não lê transcrições.
- **Allowlist.** O AI Memory é chamado com `--capture-mode allowlist`. Sem `.ai-memory.toml` nos ancestrais do `cwd`, nada é capturado.
- **Limites de saída e tempo.** stdout até 256 KiB, com falha fechada. O hook tem timeout de 20 s, e o cliente recebe timeout declarado de 25 s.
- **Escopo do marcador.** O marcador declara `workspace` e `project`. No lançamento, o marcador é conferido contra o perfil; divergência interrompe a execução.

## Consequências

- A captura só ocorre em diretórios com marcador. Sem marcador, a ausência de captura é silenciosa no hook; o lançamento emite um aviso.
- Eventos com `hook_event_name` divergente são rejeitados.
- A validação aceita IDs de sessão que não são UUID, mas as leituras de sessão do AI Memory esperam UUID. Claude Code e Codex enviam UUID; outros formatos devem ser tratados como risco de compatibilidade.
- Um AI Memory global com hooks que leem `.ai-memory.toml` pode atribuir o diretório marcado ao workspace declarado no servidor do usuário. Esse conflito é responsabilidade do operador: desabilitar os hooks globais ou usar outro escopo.
- Hooks do Codex precisam de revisão de confiança no próprio Codex.
