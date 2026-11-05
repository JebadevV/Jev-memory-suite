import { parseArgs } from 'node:util';
import { init, start, stop, doctor, configure, control, supervisorState } from './lifecycle.js';
import { install, listGatewayVersions, rollbackGateway } from './install.js';
import { update } from './update.js';
import { profileName, readConfig } from './config.js';
import { clients } from './clients.js';
import { checkMcp } from './mcp.js';
import { launch, jevLaunch, openDashboard, agyLaunch, agyDelegation, finalizeAgySession, ensureServicesReady, recoverAgyLaunches, ensureCentralDashboard } from './launch.js';
import { delegatedCommand } from './cli-args.js';
import { projectContext } from './projects.js';
import { runMigrateHistory } from './migrate.js';
import { autostartStatus, installAutostart, uninstallAutostart } from './autostart.js';

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
    const template = profileName.parse(values.profile);
    const context = await projectContext(template, values.dir);
    if (delegated.rest[0] !== '--stop') void ensureCentralDashboard(template, context.name);
    await jevLaunch(delegated.client, context.name, delegated.rest, context.cwd);
    return;
  }
  // Checked before parseArgs: Antigravity flags such as -p are not declared options and must reach agy unchanged.
  const agy = agyDelegation(raw);
  if (agy) {
    const { values } = parseArgs({ args: agy.head, allowPositionals: true, options: { profile: { type: 'string', default: 'default' }, dir: { type: 'string', default: '.' } } });
    const template = profileName.parse(values.profile);
    const context = await projectContext(template, values.dir);
    void ensureCentralDashboard(template, context.name);
    process.exitCode = await agyLaunch(context.name, agy.rest, context.cwd);
    return;
  }
  const separator = raw.indexOf('--');
  const nativeArgs = separator < 0 ? [] : raw.slice(separator + 1);
  const { values, positionals: args } = parseArgs({ args: separator < 0 ? raw : raw.slice(0, separator), allowPositionals: true, options: { profile: { type: 'string', default: 'default' }, dir: { type: 'string', default: '.' }, from: { type: 'string' }, project: { type: 'string' }, as: { type: 'string' }, apply: { type: 'boolean', default: false }, session: { type: 'string' }, recover: { type: 'boolean', default: false }, legacy: { type: 'boolean', default: false } } });
  let name = profileName.parse(values.profile);
  const [cmd, a, b] = args;
  let cwd = values.dir;
  if (cmd && ['start', 'stop', 'restart', 'recover', 'status', 'doctor', 'mcp', 'dashboard', 'launch', 'clients', 'agy-finalize'].includes(cmd)) {
    const { resolve } = await import('node:path');
    const target = cmd === 'clients' ? resolve(values.dir, args[3] ?? '.') : values.dir;
    const context = await projectContext(name, target);
    name = context.name; cwd = context.cwd;
  }
  switch (cmd) {
    case 'init': await init(name); break;
    // Prints the gateway version before and after, so the operator knows the target of a later gateway-rollback.
    case 'install': { const gateway = await install(a ?? 'all'); if (gateway) console.log(JSON.stringify(gateway, null, 2)); break; }
    case 'gateway-versions': console.log(JSON.stringify(await listGatewayVersions(), null, 2)); break;
    case 'gateway-rollback': if (!a) throw new Error('gateway-rollback requires a version id; list them with gateway-versions'); console.log(JSON.stringify(await rollbackGateway(a), null, 2)); break;
    case 'start': console.log(JSON.stringify(await start(name), null, 2)); break;
    case 'stop': await stop(name); break;
    case 'restart': case 'recover': await stop(name); console.log(JSON.stringify(await start(name), null, 2)); break;
    case 'status': await printStatus(name); break;
    case 'doctor': console.log(JSON.stringify(await doctor(name), null, 2)); break;
    case 'config': if (!a) throw new Error('config requires a workspace JSON file'); await configure(name, a); break;
    case 'update': if (!a || !b) throw new Error('update requires engine and commit SHA'); await update(a, b); break;
    case 'mcp': console.log(JSON.stringify(await checkMcp(name), null, 2)); break;
    case 'dashboard': console.log(await openDashboard(name)); break;
    case 'clients': if (!a || !b) throw new Error('clients install|remove|check claude|codex|antigravity|desktop [project-directory]'); console.log(JSON.stringify(await clients(a, b, name, cwd), null, 2)); break;
    case 'launch': if (!a) throw new Error('launch claude|codex [--dir <project-directory>] -- <native arguments>'); await launch(a, name, nativeArgs, cwd); break;
    case 'agy-finalize': {
      await ensureServicesReady(name, ['memory']);
      // --recover finalizes launches whose process died; --legacy also covers records written before owners existed (check that no agy is running first).
      if (values.recover) {
        if (values.session !== undefined) throw new Error('agy-finalize --recover takes no --session');
        console.log(JSON.stringify(await recoverAgyLaunches(name, { config: await readConfig(name), cwd, legacy: values.legacy, recordedScope: true }), null, 2));
        break;
      }
      if (values.legacy) throw new Error('agy-finalize --legacy requires --recover');
      console.log(await finalizeAgySession(name, await readConfig(name), values.session, cwd));
      break;
    }
    case 'migrate-history': await runMigrateHistory(name, values.from, values.apply, values.project, values.as); break;
    // Global, not per project: the Run entry starts scripts/autostart.ps1 at logon for every profile.
    case 'autostart':
      if (a === 'install') console.log(JSON.stringify(await installAutostart(), null, 2));
      else if (a === 'uninstall') console.log(JSON.stringify(await uninstallAutostart(), null, 2));
      else if (a === 'status') console.log(JSON.stringify(await autostartStatus(), null, 2));
      else throw new Error('autostart requires install, uninstall or status');
      break;
    default: console.log('jev-memory [--profile name] [--dir project-directory] init|install [all|gateway|memory]|gateway-versions|gateway-rollback <id>|start|stop|restart|status|doctor|recover|config <file>|update <engine> <sha>|mcp|dashboard|clients install|remove|check claude|codex|antigravity|desktop [dir]|launch claude|codex -- <args>|codex|claude [args|--dashboard|--status|--stop|--setup]|agy [args]|agy-finalize [--session <id>]|agy-finalize --recover [--legacy]|autostart install|uninstall|status|migrate-history --from <data-dir> [--project <ws>/<projeto>] [--as <ws>/<projeto>] [--apply]  (uses current project; reuses upstream jev-codex/jev-claude + AI Memory)');
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Command failed'); process.exitCode = 1; });
