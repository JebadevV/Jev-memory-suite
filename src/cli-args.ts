export interface DelegatedCommand { head: string[]; client: 'codex' | 'claude'; rest: string[] }
const valueOptions = new Set(['--profile', '--dir']);
// Finds the first positional token; when it is codex or claude, everything after it belongs to the client.
export function delegatedCommand(raw: string[]): DelegatedCommand | undefined {
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i] ?? '';
    if (valueOptions.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    if (arg !== 'codex' && arg !== 'claude') return undefined;
    return { head: raw.slice(0, i), client: arg, rest: raw.slice(i + 1) };
  }
  return undefined;
}
