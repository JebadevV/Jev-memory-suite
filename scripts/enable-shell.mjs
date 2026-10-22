// Purpose: activate repository-local Windows launchers. Audience: users. Date: 2026-10-21.
import { enableShell } from '../dist/src/shell.js';
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && !['--check', '--persist'].includes(args[0]))) {
  console.error('Usage: node scripts/enable-shell.mjs [--check|--persist]'); process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await enableShell(args[0] === '--persist'), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Shell activation failed'); process.exitCode = 1; }
}
