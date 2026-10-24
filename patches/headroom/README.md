# Patches do Headroom

## O que o shim faz

`0.41.0/jms_headroom_shim.py` roda dentro do interpretador do próprio Headroom, com `python -I`. Ele aponta as URLs do Codex com login ChatGPT para o gateway Codex do Jev (`HEADROOM_CHATGPT_CODEX_BASE_URL=http://127.0.0.1:<porta>/v1`). A mudança é feita só em atributos de módulo na memória do processo: nenhum arquivo do pacote instalado é editado. Antes de entregar o controle ao CLI do Headroom, o shim executa um autoteste e bloqueia conexões que não sejam de loopback.

## Por que existe

No Headroom 0.41.0, o destino do tráfego Codex com login ChatGPT é fixo em `https://chatgpt.com/backend-api/codex`. Essas requisições passam direto e ignoram o gateway do Jev, que assim não as vê nem as contabiliza.

## Versionamento

Há uma pasta por versão do Headroom (`patches/headroom/<versão>/`). O shim define `SUPPORTED_VERSION` e recusa qualquer outra versão, com código de saída 3. Para suportar uma nova versão, crie a pasta, revise os alvos do patch e revalide tudo.

## Como verificar

Com `HEADROOM_CHATGPT_CODEX_BASE_URL` definida, rode o interpretador do Headroom:

```
%APPDATA%\uv\tools\headroom-ai\Scripts\python.exe -I patches\headroom\0.41.0\jms_headroom_shim.py --check
```

A saída é uma linha JSON com `ok`, as URLs resultantes e o estado do guard. Códigos de saída:

- `2`: base inválida. Precisa ser exatamente `http://127.0.0.1:<porta>/v1`, com porta de 1024 a 65535.
- `3`: versão do Headroom diferente de `SUPPORTED_VERSION`.
- `4`: algum alvo está ausente ou tem valor diferente do esperado, ou seja, o código do Headroom não é o da versão suportada.
- `5`: o autoteste falhou (URL fora do gateway, constante `chatgpt.com` inesperada ou guard que não se comporta como esperado).

## Guard de egress

- Só são alcançáveis endereços de loopback (`127.0.0.0/8`, `::1` e o nome `localhost`).
- Nomes que não são loopback são recusados antes de qualquer resolução DNS, então a consulta não sai da máquina.
- O guard vale para `socket.getaddrinfo`, `socket.connect`, `socket.connect_ex` e `sock_connect` dos loops asyncio selector e proactor.
- Uma recusa gera `ConnectionRefusedError` e uma linha `jms-egress-blocked host=<host>` no stderr. Só o host é registrado, nunca caminho, cabeçalho ou corpo.
- É uma proteção dentro do processo, não um sandbox. Código que chame a API do SO diretamente, sem passar pelo módulo `socket`, não é filtrado.

## Como aposentar o shim

Quando o upstream publicar a variável `HEADROOM_CHATGPT_CODEX_BASE_URL`, o shim deixa de ser necessário: basta usar a versão que já traz a funcionalidade e remover esta pasta.

`0.41.0/chatgpt-codex-base-url.patch` é a contribuição proposta ao upstream. Ele implementa a mesma variável no código do Headroom 0.41.0 e usa o gateway também no passthrough de login ChatGPT. Para aplicá-lo, rode `patch -p1` a partir da pasta que contém o pacote `headroom`.
