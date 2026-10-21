#!/usr/bin/env node
// Runs jev-memory claude: upstream jev-claude plus AI Memory. Every argument is passed to the client.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [resolve(repo, 'dist/src/cli.js'), 'claude', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
child.once('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
