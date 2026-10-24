import { z } from 'zod';
import { readFile, mkdir, realpath, lstat, stat } from 'node:fs/promises';
import { resolve, relative, sep, dirname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const root = existsSync(resolve(moduleDir, '../package.json'))
  ? resolve(moduleDir, '..') : resolve(moduleDir, '../..');
export const profileName = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const port = z.number().int().min(1024).max(65535);
const envName = z.string().regex(/^JMS_[A-Z0-9_]{1,60}$/);
const experimentMode = z.enum(['default', 'shadow', 'metering']).default('default');
const perMTok = z.number().finite().min(0).max(10000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const priceMeta = { currency: z.literal('USD'), source: z.string().min(1).max(200), verifiedAt: isoDate };
// Only verified prices are defaults (see defaultModelPrices). Any other model stays unknown until configured, so the dashboard
// shows "not configured" instead of invented numbers.
export const llmPriceSchema = z.strictObject({
  inputPerMTok: perMTok, cacheReadPerMTok: perMTok, cacheWritePerMTok: perMTok, outputPerMTok: perMTok, ...priceMeta,
  // Last UTC day the rates apply, inclusive. After it no cost is estimated and the model reports llm-price-expired.
  validUntil: isoDate.optional(),
});
const GEMINI_PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const GEMINI_PRICES_VERIFIED_AT = '2026-10-24';
// Verified defaults: Gemini API paid tier, Standard, USD per 1M tokens; output includes thinking tokens.
// cacheWritePerMTok is 0 because the API bills context-cache storage per hour, not per token written; the estimate ignores storage.
export const defaultModelPrices: Record<string, z.infer<typeof llmPriceSchema>> = {
  'gemini-3.5-flash-lite': {
    currency: 'USD', source: GEMINI_PRICING_SOURCE, verifiedAt: GEMINI_PRICES_VERIFIED_AT,
    inputPerMTok: 0.3, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0, outputPerMTok: 2.5,
  },
  // The same page announces input 1.50, cache read 0.15 and output 7.50 from 2027-01-01. This estimate stops at the end of
  // 2026 rather than silently applying those rates.
  'gemini-3.8-flash': {
    currency: 'USD', source: GEMINI_PRICING_SOURCE, verifiedAt: GEMINI_PRICES_VERIFIED_AT,
    inputPerMTok: 0.75, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0, outputPerMTok: 3.75, validUntil: '2026-12-31',
  },
};
// How a client's tokens are paid for. api: per-token billing, so the estimate is what is charged. subscription: a flat plan, so
// the per-token estimate is not a charge. unknown: not stated by the operator.
export const billingMode = z.enum(['api', 'subscription', 'unknown']);
export type BillingMode = z.infer<typeof billingMode>;
export const defaultBilling: { claude: BillingMode; codex: BillingMode; agy: BillingMode } = { claude: 'unknown', codex: 'unknown', agy: 'subscription' };
const billingSchema = z.strictObject({
  claude: billingMode.default('unknown'),
  codex: billingMode.default('unknown'),
  // The agy launcher only reaches Code Assist with the Google account, so its tokens are covered by that subscription.
  agy: billingMode.default('subscription'),
});
export const jevPriceSchema = z.strictObject({ inputPerMTok: perMTok, outputPerMTok: perMTok, ...priceMeta });
export const modelName = z.string().regex(/^[A-Za-z0-9._:\/@-]{1,80}$/);
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspace: profileName, project: profileName, controlPort: port,
  projectRoot: z.string().min(1).max(4096).refine(isAbsolute, 'Project root must be absolute').optional(),
  memory: z.strictObject({ enabled: z.boolean(), port, semanticSearch: z.boolean().default(true) }),
  // Profiles that predate these keys parse with the defaults below, so existing suite.json files stay valid.
  dashboard: z.strictObject({ port }).default({ port: 18879 }),
  gatewayExperiment: z.strictObject({ claude: experimentMode, codex: experimentMode }).default({ claude: 'default', codex: 'default' }),
  observability: z.strictObject({
    pricing: z.strictObject({
      // Merged, not replaced: the verified defaults stay, and a configured price for the same model id overrides its default.
      // The 100 limit counts only the configured entries.
      models: z.record(modelName, llmPriceSchema).default({}).refine(m => Object.keys(m).length <= 100, 'At most 100 priced models')
        .transform(configured => ({ ...defaultModelPrices, ...configured })),
      // Observed model id -> priced model id, assumed equivalent. Empty by default; the operator sets it. For example,
      // gemini-3.8-flash-high -> gemini-3.8-flash is an assumed equivalence that no price page verifies. It applies only when the
      // observed model has no price of its own and the target has one, and the estimate then says so.
      aliases: z.record(modelName, modelName).default({}).refine(a => Object.keys(a).length <= 100, 'At most 100 aliases'),
      jev: jevPriceSchema.optional(),
    }).default({ models: defaultModelPrices, aliases: {} }),
    billing: billingSchema.default(defaultBilling),
  }).default({ pricing: { models: defaultModelPrices, aliases: {} }, billing: defaultBilling }),
  gateway: z.strictObject({
    enabled: z.boolean(), port,
    upstreamUrl: z.string().url(), jevUrl: z.string().url(),
    allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1).max(16),
    upstreamKeyEnv: envName, jevKeyEnv: envName
  }),
  // Optional Headroom proxy; the pinned version keeps detection from accepting an unvalidated release.
  headroom: z.strictObject({
    enabled: z.boolean().default(false),
    port: port.default(18880),
    version: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.41.0'),
    executable: z.string().min(1).max(4096).refine(isAbsolute, 'Headroom executable must be absolute').optional(),
    // Routes Codex ChatGPT-login traffic through the Jev codex gateway; needs the patched Headroom shim for the pinned version.
    codex: z.boolean().default(false),
    python: z.string().min(1).max(4096).refine(isAbsolute, 'Headroom python must be absolute').optional(),
  }).default({ enabled: false, port: 18880, version: '0.41.0', codex: false }),
}).superRefine((c, ctx) => {
  if (new Set([c.controlPort, c.memory.port, c.gateway.port, c.dashboard.port, c.headroom.port]).size !== 5)
    ctx.addIssue({ code: 'custom', message: 'Ports must be distinct' });
  for (const value of [c.gateway.upstreamUrl, c.gateway.jevUrl]) {
    const u = new URL(value);
    if (!c.gateway.allowedHosts.includes(u.hostname) || u.username || u.password || u.search || u.hash ||
        !(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')))
      ctx.addIssue({ code: 'custom', message: 'Endpoint must use HTTPS or numeric loopback, be allowlisted and contain no credentials/query/fragment' });
  }
});
export type Config = z.infer<typeof configSchema>;
export async function json(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
}
export function inside(base: string, path: string): string {
  const target = resolve(base, path), rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base) === target || /^[A-Za-z]:/.test(rel))
    throw new Error('Path escapes its workspace boundary');
  return target;
}
export function profileDir(name: string): string {
  return inside(root, `.local/profiles/${profileName.parse(name)}`);
}
const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
const escapes = (rel: string): boolean => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || /^[A-Za-z]:/.test(rel);
async function assertNoLinks(base: string, target: string): Promise<void> {
  let current = base;
  for (const part of relative(base, target).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return undefined;
    });
    if (info?.isSymbolicLink()) throw new Error('Symlink/junction not allowed in managed paths');
  }
}
export async function assertLocal(path: string): Promise<void> {
  const target = resolve(path), base = await realpath(root);
  inside(base, target);
  await assertNoLinks(base, target);
}
// Client files are confined to the explicitly selected project, not to the suite installation.
export async function assertWithin(basePath: string, path: string): Promise<void> {
  const base = await realpath(basePath), target = resolve(path);
  inside(base, target);
  await assertNoLinks(base, target);
}
export async function projectDirectory(path: string): Promise<string> {
  const target = resolve(path);
  if (!(await stat(target)).isDirectory()) throw new Error('Workspace path must be a directory');
  // Reject aliases/junctions even when their real target happens to be an allowed directory.
  const { parse } = await import('node:path');
  await assertNoLinks(parse(target).root, target);
  return realpath(target);
}
export async function workspaceDir(path: string, boundary = root): Promise<string> {
  const target = resolve(path);
  if (!(await stat(target)).isDirectory()) throw new Error('Workspace path must be a directory');
  const base = await realpath(boundary), canonical = await realpath(target);
  const rel = relative(fold(base), fold(canonical));
  if (rel === '') return canonical;
  if (escapes(rel)) throw new Error('Path escapes its workspace boundary');
  if (escapes(relative(base, target))) throw new Error('Path escapes its workspace boundary');
  await assertNoLinks(base, target);
  return canonical;
}
export async function readConfig(name: string): Promise<Config> {
  const dir = profileDir(name);
  await assertLocal(dir);
  return configSchema.parse(await json(resolve(dir, 'suite.json')));
}
export async function prepare(path: string): Promise<void> {
  await assertLocal(path);
  await mkdir(path, { recursive: true });
}
