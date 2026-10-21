# Atualização de upstream

Propósito: descrever como trazer um novo commit de Jev Gateway ou AI Memory, cada motor separadamente, com instalação, reinício e testes. Público: mantenedores. Data: 2026-10-21.

Os motores são importados com `git subtree --squash`. Cada um tem origem e commit fixados em [upstream.sources.json](../../upstream.sources.json). Uma atualização altera o código-fonte compilado e precisa ser verificada.

## Procedimento

Faça uma atualização por motor, em commits separados.

1. **Árvore limpa.** Confirme que `git status` está vazio. `update` recusa se houver alterações.
2. **Escolha o commit.** Use o SHA completo de 40 caracteres minúsculos do repositório oficial. Tags não são aceitas.
3. **Revise a mudança.** Leia o diff entre o commit atual e o novo no repositório oficial, especialmente em `package.json`, lockfiles, código de rede e de autenticação.
4. **Atualize a subtree:**

   ```bash
   node bin/jev-memory.mjs update gateway <sha40>
   # ou
   node bin/jev-memory.mjs update memory <sha40>
   ```

   O comando executa `git subtree pull --prefix=<prefixo> <url> <sha> --squash` e acrescenta um registro em `upstream.updates.json`.

5. **Atualize o manifesto.** O `update` **não** altera `upstream.sources.json`. Se o novo commit for adotado, atualize `commit` e `version` nesse arquivo e em `THIRD_PARTY_NOTICES.md` quando a licença ou o autor mudar.
6. **Instale o motor atualizado:** `node bin/jev-memory.mjs install gateway` ou `install memory`. A versão nova ganha um diretório próprio; a anterior permanece (veja [ADR 0002](../architecture/adr/0002-versioned-engine-installs.md)).
7. **Reinicie:** `node bin/jev-memory.mjs --profile <nome> restart`. O `current.json` só troca a versão no install; o processo em execução continua com a anterior até reiniciar.
8. **Rode os testes da suíte:** `npm run build`, `npm run lint`, `npm test` e `npm run test:e2e`.
9. **Rode os checks do upstream.** Para o Jev Gateway: `tsc --noEmit` e `vitest`. Para o AI Memory: `cargo fmt --check` e os testes dos crates `ai-memory-core` e `ai-memory-hooks`. Execute-os nos próprios diretórios `upstream/`, sem alterá-los.
10. **Registre o resultado** em `tests.json` com a saída dos comandos em `.local/evidence/`. Falhas são registradas, não corrigidas dentro do subtree.
11. **Revise a documentação.** Se o contrato mudou (por exemplo, rotas, flags ou formato de hook), atualize [API](../api/README.md) e este guia.

## Cuidados

- O `git subtree pull` pode gerar conflitos. Não há evidência de resolução automática; se houver conflito, aborte com `git` e revise antes de tentar de novo.
- Um commit novo pode alterar as dependências do motor. Rode `pnpm audit` no Gateway e `npm audit` na suíte (veja [dependências](../security/dependencies.md)).
- Não atualize os dois motores no mesmo commit, para que uma regressão seja atribuída corretamente.
- Os diretórios em `upstream/` não devem ser modificados diretamente. O `install` recusa fontes com alterações não commitadas.
