import { readFile, writeFile } from 'node:fs/promises';
const [id, status, command, observed] = process.argv.slice(2);
if (!/^M[0-7]$/.test(id ?? '') || !['passed', 'pending', 'blocked', 'partial'].includes(status)) throw Error('Invalid milestone');
const data = JSON.parse((await readFile('tests.json', 'utf8')).replace(/^\uFEFF/, ''));
data.updatedAt = new Date().toISOString();
data.milestones[id] = status;
data.checks.push({ id: `${id}-${Date.now()}`, status, command, observed, evidence: '.local/evidence/' });
await writeFile('tests.json', `${JSON.stringify(data, null, 2)}\n`);
const milestones = [
  'Executor, leitura/escrita, Git e propriedade', 'Estrutura e instrucoes',
  'Importacao subtree, documentacao e proveniencia', 'Gerenciador, instalacao, configuracao e ciclo de vida',
  'MCP, hooks e configuracoes reversiveis dos clientes', 'Quatro modos, captura, consulta, persistencia e roteamento',
  'Checks upstream e validacao independente de cada cliente', 'Documentacao e revisao final de seguranca'
];
const heading = 'Proposito: acompanhar marcos verificaveis. Publico: mantenedores. Data: 2026-10-21.\n';
await writeFile('plan.md', '# Plano de implementacao\n\n' + heading + '\n' + milestones.map((m, i) => `- [${data.milestones[`M${i}`] === 'passed' ? 'x' : ' '}] M${i}: ${m}.`).join('\n') + '\n\nUm marco por vez; resultado ausente nunca equivale a aprovado. Fontes originais preservadas; tudo local ao workspace.\n');
await writeFile('progress.md', '# Progresso\n\n' + heading + '\n' + milestones.map((m, i) => `## M${i}: ${data.milestones[`M${i}`]}\n\n${m}.\n`).join('\n') + '\n## Evidencias registradas\n\n' + data.checks.map(c => `- ${c.id}: ${c.status}. ${c.observed}`).join('\n') + '\n\n## Clientes\n\n' + Object.entries(data.clients).map(([k,v]) => `- ${k}: ${v}`).join('\n') + '\n');
