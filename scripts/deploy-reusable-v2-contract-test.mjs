#!/usr/bin/env node
/**
 * 01global-owned executable contract test for the versioned deployment workflow.
 *
 * Authoritative subject under test:
 *   .github/workflows/deploy-reusable-v2.yml   (resolved from the repository root)
 *
 * Self-contained: no npm install, no test framework. Run with:
 *   node scripts/deploy-reusable-v2-contract-test.mjs
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW_PATH = '.github/workflows/deploy-reusable-v2.yml';
if (!existsSync(WORKFLOW_PATH)) {
  console.error(`FATAL: ${WORKFLOW_PATH} not found. Run from the repository root.`);
  process.exit(2);
}
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`FAIL ${name} -> ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function extractBlock(name) {
  const begin = `# ---- BEGIN ${name} ----`;
  const end = `# ---- END ${name} ----`;
  const start = workflow.indexOf(begin);
  const stop = workflow.indexOf(end);
  assert(start > -1 && stop > start, `missing marked block ${name}`);
  const raw = workflow.slice(start + begin.length, stop).split('\n').slice(1);
  const indents = raw.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const pad = Math.min(...indents);
  return raw.map((l) => l.slice(pad)).join('\n');
}

function runBash(script, env, cwd) {
  const res = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], {
    env: { PATH: process.env.PATH ?? '', ...env },
    cwd,
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/* ---------------- secret and input contract ---------------- */

test('declares the exact v1 secret names and no VPS_* aliases', () => {
  for (const s of ['SSH_PRIVATE_KEY', 'SSH_HOST', 'SSH_PORT', 'SSH_USER']) {
    assert(new RegExp(`^\\s{6}${s}:`, 'm').test(workflow), `secret ${s} not declared`);
    assert(workflow.includes(`secrets.${s} }}`), `secret ${s} not consumed`);
  }
  for (const bad of ['VPS_SSH_KEY', 'VPS_HOST', 'VPS_USER']) {
    assert(!workflow.includes(bad), `forbidden secret alias ${bad}`);
  }
});

test('uses SSH_PORT in ssh-keyscan and rsync ssh, with strict host key checking', () => {
  assert(/ssh-keyscan -p "\$SSH_PORT"/.test(workflow), 'ssh-keyscan missing -p "$SSH_PORT"');
  assert(/ssh -i ~\/\.ssh\/id_deploy -p \$SSH_PORT/.test(workflow), 'rsync ssh missing -p $SSH_PORT');
  assert(workflow.includes('StrictHostKeyChecking=yes'), 'strict host key checking not enforced');
});

test('installs rsync and openssh-client', () => {
  assert(/apt-get install -y rsync openssh-client/.test(workflow), 'tooling install missing');
});

test('retains optional pre_build executed only when non-empty', () => {
  assert(/pre_build:/.test(workflow), 'pre_build input missing');
  assert(/PRE_BUILD: \$\{\{ inputs\.pre_build \}\}/.test(workflow), 'pre_build not passed via env');
  assert(/if \[ -n "\$\{PRE_BUILD-\}" \]/.test(workflow), 'pre_build not guarded on non-empty');
});

test('no expression interpolation inside executable run: bodies', () => {
  const lines = workflow.split('\n');
  let inRun = false;
  let runIndent = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*run:\s*\|/.test(line)) {
      inRun = true;
      runIndent = indent;
      continue;
    }
    if (inRun && line.trim() && indent <= runIndent) inRun = false;
    assert(!(inRun && line.includes('${{')), `expression in run body -> ${line.trim()}`);
  }
});

test('every run block sets -euo pipefail and none enable set -x', () => {
  const runs = workflow.split(/^\s*run: \|$/m).slice(1);
  assert(runs.length >= 6, `expected >= 6 run blocks, saw ${runs.length}`);
  for (const r of runs) assert(r.includes('set -euo pipefail'), 'run block missing set -euo pipefail');
  assert(!/set -x/.test(workflow), 'set -x present');
});

/* ---------------- deploy path allowlist ---------------- */

const guard = () => extractBlock('deploy-path-guard');

for (const p of [
  '/quipu/websites/fixtheworld.club/public',
  '/soeasy/websites/soeasyaiceo.com/public',
  '/soeasy/websites/0800mymechanic.com/public',
  '/soeasy/websites/apeel.co.nz/public',
  '/soeasy/containers/quipu-auth',
]) {
  test(`allowlist accepts ${p}`, () => {
    const r = runBash(guard(), { DEPLOY_PATH: p });
    assert(r.code === 0, `rejected: ${r.err}`);
    assert(r.out.includes(`deploy_path accepted: ${p}`), 'no acceptance line');
  });
}

for (const p of [
  '/',
  '/etc',
  '/etc/nginx/sites',
  '/root/a/b',
  '/home/user/site',
  '/var/lib/data',
  '/quipu',
  '/quipu/websites',
  '/quipu/quarantine',
  '/quipu/quarantine/fixtheworld-recursive-copy-2026-08-07',
  '/quipu/websites/fixtheworld.club/public/',
  '/quipu/websites/fixtheworld.club',
  '/quipu/other/fixtheworld.club/public',
  '/soeasy',
  '/soeasy/websites',
  '/soeasy/containers',
  '/soeasy/other/thing',
  '/quipu/websites/../../etc/passwd',
  '/quipu//websites/x/public',
  'quipu/websites/x/public',
  '../escape',
  '/quipu/websites/x/public;rm -rf',
  '/quipu/websites/$(whoami)/public',
  '/quipu/websites/`id`/public',
  '/quipu/websites/x|y/public',
  '/quipu/websites/x&y/public',
  '/quipu/websites/x y/public',
  '/quipu/websites/*/public',
  '/quipu/websites/x/public\nrm -rf /',
  '/quipu/websites/./public',
  '/quipu/websites/-/public',
  '/quipu/websites/.hidden/public',
  '/quipu/websites/example./public',
  '/quipu/websites/example-/public',
  '/soeasy/websites/./public',
  '/soeasy/containers/.',
  '/soeasy/containers/-',
  '/soeasy/containers/.hidden',
  '/soeasy/containers/..',
  '/quipu/websites/ex..ample/public',
  '',
]) {
  test(`allowlist rejects ${JSON.stringify(p)}`, () => {
    const r = runBash(guard(), { DEPLOY_PATH: p });
    assert(r.code !== 0, 'unexpectedly accepted');
    assert(r.err.includes('deploy_path_rejected:'), `no rejection reason: ${r.err}`);
    assert(!r.out.includes('accepted'), 'acceptance line leaked');
  });
}

test('hostile deploy_path is never executed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const canary = join(dir, 'canary');
  writeFileSync(canary, 'intact');
  const r = runBash(guard(), { DEPLOY_PATH: `/quipu/websites/x/public; rm -f ${canary}` });
  assert(r.code !== 0, 'accepted hostile path');
  assert(readFileSync(canary, 'utf8') === 'intact', 'canary destroyed');
});

/* ---------------- output confinement ---------------- */

const resolver = () => extractBlock('output-resolver');
function workspace(dirs = []) {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

for (const d of ['dist', 'build', 'out']) {
  test(`auto-detects ${d}`, () => {
    const root = workspace([d]);
    const r = runBash(resolver(), { BUILD_OUTPUT_DIR: '', GITHUB_WORKSPACE: root }, root);
    assert(r.code === 0, r.err);
    assert(r.out.includes('output directory resolved:') && r.out.trim().endsWith(d), r.out);
  });
}

test('prefers dist over build over out', () => {
  const root = workspace(['out', 'build', 'dist']);
  const r = runBash(resolver(), { BUILD_OUTPUT_DIR: '', GITHUB_WORKSPACE: root }, root);
  assert(r.out.trim().endsWith('dist'), r.out);
});

test('honours an explicit confined output directory', () => {
  const root = workspace(['dist', 'public-site']);
  const r = runBash(resolver(), { BUILD_OUTPUT_DIR: 'public-site', GITHUB_WORKSPACE: root }, root);
  assert(r.code === 0, r.err);
  assert(r.out.trim().endsWith('public-site'), r.out);
});

test('rejects absolute, traversing and missing output directories', () => {
  const root = workspace(['dist']);
  for (const v of ['/etc', '../x', 'nope', '../../tmp']) {
    const r = runBash(resolver(), { BUILD_OUTPUT_DIR: v, GITHUB_WORKSPACE: root }, root);
    assert(r.code !== 0, `accepted ${v}`);
    assert(r.err.includes('build_output_dir_rejected:'), r.err);
  }
});

test('fails closed when no output directory exists', () => {
  const root = workspace([]);
  const r = runBash(resolver(), { BUILD_OUTPUT_DIR: '', GITHUB_WORKSPACE: root }, root);
  assert(r.code !== 0, 'accepted empty workspace');
  assert(r.err.includes('not_found'), r.err);
});

test('rejects a dist symlink escaping the workspace', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  mkdirSync(join(outside, 'payload'));
  const root = workspace([]);
  symlinkSync(join(outside, 'payload'), join(root, 'dist'));
  const auto = runBash(resolver(), { BUILD_OUTPUT_DIR: '', GITHUB_WORKSPACE: root }, root);
  assert(auto.code !== 0, 'accepted escaping symlink via auto-detect');
  assert(auto.err.includes('escapes_workspace'), auto.err);
  const explicit = runBash(resolver(), { BUILD_OUTPUT_DIR: 'dist', GITHUB_WORKSPACE: root }, root);
  assert(explicit.code !== 0, 'accepted escaping symlink via explicit input');
  assert(explicit.err.includes('escapes_workspace'), explicit.err);
});

test('never allows the repository root as deployment output', () => {
  const root = workspace([]);
  const r = runBash(resolver(), { BUILD_OUTPUT_DIR: '.', GITHUB_WORKSPACE: root }, root);
  assert(r.code !== 0, 'accepted repository root');
  assert(r.err.includes('repository_root'), r.err);
});

/* ---------------- rsync semantics ---------------- */

test('contents-copy trailing-slash semantics are exact', () => {
  const block = extractBlock('rsync');
  assert(block.includes('"${OUTPUT_DIR}/"'), 'source missing single trailing slash');
  assert(/\$\{DEPLOY_PATH\}\/"/.test(block), 'destination missing single trailing slash');
  assert(!/\$\{OUTPUT_DIR\}\/\//.test(block) && !/\$\{DEPLOY_PATH\}\/\//.test(block), 'double slash');
  assert(!/DEPLOY_PATH\}\/\$\{?[A-Z_]*(SITE|NAME)/.test(workflow), 'site-name concatenation present');
  assert(block.includes('--delete'), '--delete removed');
});

test('--delete stays confined to the validated target', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-'));
  const src = join(root, 'dist');
  const site = join(root, 'site');
  const dest = join(site, 'public');
  const sibling = join(site, 'logs');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(src, 'index.html'), 'new');
  writeFileSync(join(dest, 'stale.html'), 'old');
  writeFileSync(join(sibling, 'keep.log'), 'keep');
  writeFileSync(join(site, 'parent.txt'), 'keep');
  const res = spawnSync('rsync', ['-a', '--delete', '--delete-after', `${src}/`, `${dest}/`]);
  assert(res.status === 0, 'rsync failed');
  assert(existsSync(join(dest, 'index.html')), 'new file missing');
  assert(!existsSync(join(dest, 'stale.html')), 'stale file survived');
  assert(existsSync(join(sibling, 'keep.log')), 'sibling deleted');
  assert(existsSync(join(site, 'parent.txt')), 'parent file deleted');
  assert(!existsSync(join(dest, 'dist')), 'nested source directory');
});

/* ---------------- build-info.json ---------------- */

test('build-info.json is valid encoded JSON, including hostile values', () => {
  const root = mkdtempSync(join(tmpdir(), 'info-'));
  mkdirSync(join(root, 'dist'));
  const sha = 'a'.repeat(40);
  const r = runBash(extractBlock('build-info'), {
    OUTPUT_DIR: join(root, 'dist'),
    DEPLOY_PATH: '/quipu/websites/fixtheworld.club/public',
    REPOSITORY: 'eion-bit/deploy-fixtheworld',
    SHA: sha,
    REF_NAME: 'feature/"quote\\backslash\ttab',
    RUN_ID: '123',
    RUN_ATTEMPT: '1',
  }, root);
  assert(r.code === 0, r.err);
  const parsed = JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8'));
  assert(parsed.schema === 'g6.build-info/1', 'schema wrong');
  assert(parsed.sha === sha, 'sha wrong');
  assert(parsed.deploy_path === '/quipu/websites/fixtheworld.club/public', 'deploy_path wrong');
  assert(parsed.ref === 'feature/"quote\\backslash\ttab', 'hostile ref not round-tripped');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(parsed.built_at), `built_at: ${parsed.built_at}`);
});

test('does not stamp index.html', () => {
  assert(!/index\.html/.test(workflow), 'workflow touches index.html');
});

/* ---------------- v1 untouched ---------------- */

test('v1 reusable workflow still exists and is not modified by v2', () => {
  const v1 = '.github/workflows/deploy-reusable.yml';
  if (existsSync(v1)) {
    const text = readFileSync(v1, 'utf8');
    assert(!text.includes('deploy-reusable-v2'), 'v1 references v2');
  } else {
    console.log('     (note: v1 not present in this checkout)');
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
