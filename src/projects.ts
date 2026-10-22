import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assertLocal, configSchema, prepare, profileDir, profileName, projectDirectory, readConfig, root, workspaceDir } from './config.js';

export interface ProjectContext { name: string; cwd: string }

// Git roots keep launches from subdirectories attached to the same project. Plain folders also work.
async function projectRoot(cwd: string): Promise<string> {
  for (let current = cwd; ; current = dirname(current)) {
    if (await access(resolve(current, '.git')).then(() => true, () => false)) return current;
    if (dirname(current) === current) return cwd;
  }
}
async function availablePorts(): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    // Exclude persisted profiles too: a stopped project must retain its ports on the next launch.
    const reserved = new Set<number>();
    const profiles = resolve(root, '.local/profiles');
    for (const name of await readdir(profiles).catch(() => [] as string[])) {
      if (!profileName.safeParse(name).success) continue;
      const c = await readConfig(name).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (!c) continue; // Another process may be exclusively creating its suite.json.
      for (const port of [c.controlPort, c.memory.port, c.gateway.port, c.dashboard.port]) reserved.add(port);
    }
    const ports: number[] = [];
    for (let attempt = 0; ports.length < 4 && attempt < 100; attempt++) {
      const server = createServer(); servers.push(server);
      await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
      const address = server.address();
      if (address && typeof address !== 'string' && !reserved.has(address.port)) ports.push(address.port);
    }
    if (ports.length !== 4) throw new Error('Could not allocate distinct local project ports');
    return ports;
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
  }
}
async function isolatedProfile(template: string, target: string): Promise<string> {
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const hash = createHash('sha256').update(`${template}\0${key}`).digest('hex').slice(0, 20);
  const name = `project-${hash}`, dir = profileDir(name), file = resolve(dir, 'suite.json');
  await assertLocal(file);
  const existing = await readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (existing !== undefined) {
    const c = configSchema.parse(JSON.parse(existing));
    if (c.projectRoot !== target) throw new Error('Project profile belongs to another directory');
    return name;
  }
  const base = await readConfig(template);
  const [controlPort, memoryPort, gatewayPort, dashboardPort] = await availablePorts();
  const slug = basename(target).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 16);
  const project = `p-${slug || 'folder'}-${hash}`;
  const c = configSchema.parse({ ...base, projectRoot: target, project, controlPort,
    memory: { ...base.memory, port: memoryPort }, gateway: { ...base.gateway, port: gatewayPort }, dashboard: { port: dashboardPort } });
  await prepare(dir);
  try { await writeFile(file, `${JSON.stringify(c, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await readConfig(name); }
  return name;
}

// Serialize first-time port/profile allocation across clients. No project files are written here.
export async function projectContext(template: string, dir = '.', from = process.cwd()): Promise<ProjectContext> {
  profileName.parse(template);
  const cwd = await projectDirectory(resolve(from, dir)), suite = await projectDirectory(root);
  const rel = relative(suite, cwd);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return { name: template, cwd: await workspaceDir(cwd) };
  }
  const config = await readConfig(template);
  if (config.projectRoot) return { name: template, cwd: await workspaceDir(cwd, config.projectRoot) };
  const target = await projectRoot(cwd);
  const lock = resolve(root, '.local/project-allocation.lock');
  await prepare(resolve(root, '.local'));
  // A leftover lock is reported explicitly rather than deleting a possibly active lock.
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt >= 100) throw new Error('Project allocation is busy; retry after the other suite command finishes');
      await new Promise(done => setTimeout(done, 50));
    }
  }
  try { return { name: await isolatedProfile(template, target), cwd }; }
  finally { const { rmdir } = await import('node:fs/promises'); await rmdir(lock); }
}
