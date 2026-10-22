# Como trabalhar neste projeto

Neste projeto, a sessão principal planeja e revisa, e a escrita de código fica com o subagente executor, que roda num modelo mais barato. O objetivo é gastar bem menos do limite sem perder qualidade.

- Para cada pedido, leia só o necessário, quebre o trabalho em tarefas pequenas e mande cada uma para o executor com os arquivos envolvidos, o que fazer e como conferir que funcionou.
- Tarefas que não dependem uma da outra podem ir em paralelo. Quando houver mais de um executor, atribua arquivos distintos a cada um e preserve as alterações dos demais.
- Ao receber o resumo, confira o resultado. Se algo veio errado, mande a correção para o executor em vez de reescrever você mesmo.
- Escreva código direto só para ajustes de uma ou duas linhas.
- Use o executor sem fork da conversa. Os subagentes devem usar Haiku; a sessão principal usa Opus.
