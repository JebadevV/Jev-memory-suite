# Uso em qualquer projeto

Propósito: iniciar Codex e Claude em projetos independentes da pasta de instalação da suíte. Público: usuários e mantenedores. Data: 2026-10-21.

## Iniciar na pasta atual

### Comandos curtos no Windows

Após compilar a suíte, execute uma vez:

```powershell
node C:\caminho\para\jev-memory-suite\scripts\enable-shell.mjs --persist
```

Isso acrescenta apenas `C:\caminho\para\jev-memory-suite\bin` ao PATH do usuário, preservando os valores anteriores e o tipo de registro. O backup fica em `.local/shell/user-path-before-<id>.json`. Não há pacote global, alteração do perfil PowerShell ou mudança da política de execução. O ativador recusa nomes de comando já usados por outra instalação. Sem `--persist` (ou com `--check`), apenas verifica.

Abra um terminal novo. Em terminais já abertos, use `$env:Path += ';C:\caminho\para\jev-memory-suite\bin'` para ativar a sessão atual.

```powershell
cd C:\caminho\para\seu-projeto
jev-memory clients install codex .
jev-memory-codex

# Claude Code:
jev-memory clients install claude .
jev-memory-claude
```

O registro continua sendo uma etapa por cliente/projeto. Os comandos curtos usam os mesmos launchers e o mesmo diretório atual; todos os argumentos são encaminhados ao cliente, por exemplo `jev-memory-codex exec "tarefa"` e `jev-memory-claude --dashboard`.

### Caminho absoluto, sem ativação

Depois de instalar e compilar a suíte conforme o [README](../../README.md), abra um terminal na pasta do projeto. Use o caminho absoluto do launcher; `node bin/jev-memory.mjs` procura o arquivo dentro da pasta atual e só funciona quando ela é a instalação da suíte.

```powershell
cd C:\caminho\para\seu-projeto

# Registro explícito uma vez por cliente/projeto:
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs clients install codex .
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs clients install claude .

# Escolha o cliente para cada sessão:
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs codex
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs claude
```

Sem registro, o launcher conecta o MCP, mas avisa que a captura por hooks precisa do marcador de escopo e do registro. Os comandos `codex` e `claude` sobem a memória quando necessário e reutilizam os launchers oficiais do Jev Gateway. A configuração do Gateway continua seguindo o [guia de clientes](clients.md#uso-no-estilo-jev-codex--jev-claude-recomendado).

No Codex, confie no projeto e revise os hooks em `/hooks`. No Claude, aprove `jev_memory_suite` quando solicitado. A suíte não concede confiança pelo usuário.

## Selecionar uma pasta explicitamente

`--dir` fica antes do comando `codex` ou `claude`; argumentos depois do nome do cliente pertencem ao cliente.

```powershell
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs --dir "C:\caminho\para\meu-projeto" clients install codex .
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs --dir "C:\caminho\para\meu-projeto" codex
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs --dir "C:\caminho\para\meu-projeto" status
node C:\caminho\para\jev-memory-suite\bin\jev-memory.mjs --dir "C:\caminho\para\meu-projeto" stop
```

O diretório deve existir. Caminhos relativos partem da pasta atual do terminal. Links simbólicos e junctions no caminho são recusados.

## Isolamento e arquivos

- A raiz Git identifica o projeto, inclusive quando o terminal está em uma subpasta. Sem Git, a pasta selecionada identifica o projeto.
- O caminho canônico e o nome do perfil base geram um perfil estável `project-<hash>`. Pastas homônimas em caminhos diferentes recebem perfis diferentes. Renomear ou mover um projeto gera outro perfil; os dados anteriores permanecem preservados.
- Configuração, banco de memória, tokens, logs e arquivos de lançamento ficam em `.local/profiles/<perfil>` dentro da instalação. Novos perfis copiam a configuração do perfil base e recebem quatro portas locais distintas. Alterações futuras no perfil base não reescrevem os perfis já criados.
- A seleção do projeto não altera arquivos dele. Somente `clients install` registra os [arquivos de cliente](../api/managed-files.md#arquivos-de-cliente-no-workspace), com preflight, backup e preservação de entradas alheias. `clients remove` remove apenas o registro próprio; não apaga a memória.
- Hooks só aceitam eventos da raiz registrada e seus descendentes, com marcador correspondente ao workspace/projeto. Um marcador conflitante, escape ou junction é recusado. As gravações internas da suíte continuam restritas à instalação.
- Comandos operacionais (`start`, `stop`, `restart`, `status`, `doctor`, `mcp`, `dashboard`) usam a mesma seleção por pasta atual/`--dir`. `init`, `install`, `config` e `update` continuam operações da instalação/perfil informado.

Os Gateways dos launchers upstream continuam compartilhados por cliente; o isolamento aqui é da memória. Os motores upstream permanecem sem alterações.

## Validação realizada

`npm run test:projects` usa duas pastas temporárias externas, uma com espaços, duas instâncias reais do AI Memory e os CLIs instalados. Valida registro, MCP, captura por hooks nativos acionados pelo teste, isolamento entre projetos e persistência após reinício. Também executa `--version` pelos launchers direto e upstream de ambos os clientes, com resposta sintética de saúde do Gateway e sem chamadas a provedores de modelos. Evidência: `.local/evidence/external-projects-e2e.json`.

No Windows, o mesmo teste resolve `jev-memory-codex` e `jev-memory-claude` pelo PATH em processos PowerShell e executa `--version` em cada CLI real. Essa validação usa PATH apenas nesses processos e não exige persistir o PATH do usuário. A ativação persistente é uma operação separada, registrada em `tests.json` quando executada.

Isso não certifica captura interativa do Codex nem integração com Codex Desktop. A confiança dos hooks e a validação no app continuam sendo gates separados em [tests.json](../../tests.json).
