# Endpoint de controle do supervisor

Propósito: documentar as rotas HTTP do supervisor de um perfil, a autenticação e os estados retornados. Público: integradores e mantenedores. Data: 2026-10-21.

O supervisor escuta em `127.0.0.1:<controlPort>`. Não é uma API pública: serve apenas à CLI do próprio perfil.

## Autenticação

- Cabeçalho `Authorization: Bearer <token>`, em que o token é o `control-token` do perfil (64 caracteres hexadecimais).
- O cabeçalho `Host` precisa ser exatamente `127.0.0.1:<controlPort>`.
- A comparação do token usa `timingSafeEqual`.
- Falha em qualquer uma das duas verificações responde `401` sem corpo.
- O token nunca é impresso pela CLI. `doctor` informa apenas se o arquivo existe.

## Rotas

| Método e caminho | Resposta de sucesso | Efeito |
|---|---|---|
| `GET /status` | `200` com JSON de estado | Nenhum |
| `POST /stop` | `200` com `{"stopping":true}` | Encerra os filhos e o supervisor |
| Qualquer outra | `404` | Nenhum |

## Formato de `/status`

```json
{
  "phase": "ready",
  "services": { "memory": "ready", "gateway": "ready" },
  "pid": 12345
}
```

Este exemplo mostra a forma; os valores reais dependem do perfil.

- `phase`: `starting`, `ready`, `failed` ou `stopping`.
- `services`: contém apenas os serviços habilitados. Valores: `starting`, `ready`, `failed` ou `stopped`.
- `pid`: PID do próprio supervisor.

## Interpretação pela CLI

`supervisorState` em `src/lifecycle.ts` classifica a resposta:

- `running`: resposta 2xx.
- `foreign`: `401` ou `403`. A porta responde, mas não com o token do perfil; outro processo ou outro perfil a ocupa.
- `stopped`: conexão recusada.
- Qualquer outro código lança erro.

Cada requisição tem timeout de 2 s.

## Sinais e encerramento

`SIGINT` e `SIGTERM` disparam o mesmo encerramento de `POST /stop`. Cada filho recebe `SIGTERM` e, se não sair em 6 s, `SIGKILL`. O supervisor só termina filhos que ele mesmo criou.
