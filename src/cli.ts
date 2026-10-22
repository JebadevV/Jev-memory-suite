import { parseArgs } from 'node:util';
import { init, start, stop, doctor, configure, control, supervisorState } from './lifecycle.js';
import { install } from './install.js';
import { update } from './update.js';
import { profileName, readConfig } from './config.js';
import { clients } from './clients.js';
import { checkMcp } from './mcp.js';
import { launch, jevLaunch, openDashboard } from './launch.js';
import { delegatedCommand } from './cli-args.js';
import { projectContext } from './projects.js';

async function printStatus(name: string): Promise<void> {
  const state = await supervisorState(name);
  if (state === 'running') { console.log(JSON.stringify(await control(name, 'status'), null, 2)); return; }
  if (state === 'stopped') { console.log('{"phase":"stopped"}'); return; }
  const { controlPort } = await readConfig(name);
  console.log(JSON.stringify({ phase: 'port-conflict', controlPort }));
  process.exitCode = 1;
}

async function main() {
  const raw = process.argv.slice(2), delegated = delegatedCommand(raw);
  if (delegated) {
    const { values } = parseArgs({ args: delegated.head, allowPositionals: true, options: { profile: { type: 'string', default: 'default' }, dir: { type: 'string', default: '.' } } });
    const context = await projectContext(profileName.parse(values.profile), values.dir);
    await jevLaunch(delegated.client, context.name, delegated.rest, context.cwd);
    return;
  }
  const separator = raw.indexOf('--');
  const nativeArgs = separator < 0 ? [] : raw.slice(separator + 1);
  const { values, positionals: args } = parseArgs({ args: separator < 0 ? raw : raw.slice(0, separator), allowPositionals: true, options: { profile: { type: 'string', default: 'default' }, dir: { type: 'string', default: '.' } } });
  let name = profileName.parse(values.profile);
  const [cmd, a, b] = args;
  let cwd = values.dir;
  if (cmd && ['start', 'stop', 'restart', 'recover', 'status', 'doctor', 'mcp', 'dashboard', 'launch', 'clients'].includes(cmd)) {
    const { resolve } = await import('node:path');
    const target = cmd === 'clients' ? resolve(values.dir, args[3] ?? '.') : values.dir;
    const context = await projectContext(name, target);
    name = context.name; cwd = context.cwd;
  }
  switch (cmd) {
    case 'init': await init(name); break;
    case 'install': await install(a ?? 'all'); break;
    case 'start': console.log(JSON.stringify(await start(name), null, 2)); break;
    case 'stop': await stop(name); break;
    case 'restart': case 'recover': await stop(name); console.log(JSON.stringify(await start(name), null, 2)); break;
    case 'status': await printStatus(name); break;
    case 'doctor': console.log(JSON.stringify(await doctor(name), null, 2)); break;
    case 'config': if (!a) throw new Error('config requires a workspace JSON file'); await configure(name, a); break;
    case 'update': if (!a || !b) throw new Error('update requires engine and commit SHA'); await update(a, b); break;
    case 'mcp': console.log(JSON.stringify(await checkMcp(name), null, 2)); break;
    case 'dashboard': console.log(await openDashboard(name)); break;
    case 'clients': if (!a || !b) throw new Error('clients install|remove|check claude|codex|desktop [project-directory]'); console.log(JSON.stringify(await clients(a, b, name, cwd), null, 2)); break;
    case 'launch': if (!a) throw new Error('launch claude|codex [--dir <project-directory>] -- <native arguments>'); await launch(a, name, nativeArgs, cwd); break;
    default: console.log('jev-memory [--profile name] [--dir project-directory] init|install [all|gateway|memory]|start|stop|restart|status|doctor|recover|config <file>|update <engine> <sha>|mcp|dashboard|clients install|remove|check claude|codex|desktop [dir]|launch claude|codex -- <args>|codex|claude [args|--dashboard|--status|--stop|--setup]  (uses current project; reuses upstream jev-codex/jev-claude + AI Memory)');
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Command failed'); process.exitCode = 1; });
