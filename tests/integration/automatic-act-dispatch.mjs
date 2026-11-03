import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const root = await mkdtemp(join(tmpdir(), 'event-dispatch-integration-'));
const repo = 'fixture/event-dispatch';
const token = 'local-test-token';
let dispatcher;
let upstream;
try {
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  await mkdir(join(workspace, '.github', 'workflows'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(workspace, '.github/workflows/merge.yml'), [
    'name: Merge event integration fixture',
    'on:',
    '  pull_request:',
    '    types: [closed]',
    '    branches: [main]',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo merge-event-fixture',
    '',
  ].join('\n'));
  await writeFile(join(workspace, '.github/workflows/ignore.yml'), [
    'name: Must not run',
    'on:',
    '  issues:',
    '    types: [opened]',
    'jobs:',
    '  ignore:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: exit 1',
    '',
  ].join('\n'));
  const calls = join(root, 'act-calls.jsonl');
  const fakeAct = join(bin, 'act');
  await writeFile(fakeAct, '#!/usr/bin/env node\n' +
    'const fs = require("node:fs");\n' +
    'const args = process.argv.slice(2);\n' +
    'const file = args[args.indexOf("--eventpath") + 1];\n' +
    'fs.appendFileSync(process.env.ACT_CALLS, JSON.stringify({args, event: JSON.parse(fs.readFileSync(file, "utf8"))}) + "\\n");\n');
  await chmod(fakeAct, 0o755);
  let pr = { number: 7, state: 'open', merged: false, base: { ref: 'main' }, head: { ref: 'feature/test' } };
  upstream = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === `/repos/${repo}`) return json(200, { full_name: repo, default_branch: 'main' });
    if (path === `/repos/${repo}/pulls/7` && req.method === 'GET') return json(200, pr);
    if (path === `/repos/${repo}/pulls/7/merge` && req.method === 'PUT') {
      pr = { ...pr, merged: true, state: 'closed' };
      return json(200, { merged: true, sha: 'fixture-merge-sha' });
    }
    json(404, { message: 'Not found' });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(() => resolvePort(selected));
    });
  });
  const output = [];
  dispatcher = spawn(process.execPath, ['--experimental-strip-types', resolve('dist/github-emulator/dispatcher/index.ts')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ACT_CALLS: calls,
      DISPATCH_ENABLED: '1', DISPATCH_WORKSPACE: workspace, DISPATCH_WORKFLOWS: '.github/workflows',
      DISPATCH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, DISPATCH_PORT: String(port),
      REPO: repo, TOKEN: token, DISPATCH_SOURCE_SHA: 'fixture-merge-sha' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dispatcher.stdout.on('data', b => output.push(b.toString()));
  dispatcher.stderr.on('data', b => output.push(b.toString()));
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (dispatcher.exitCode !== null) break;
    try { const r = await fetch(`${base}/_dispatcher/health`); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(ready, `Dispatcher did not start: ${output.join('')}`);
  const merge = await fetch(`${base}/repos/${repo}/pulls/7/merge`, {
    method: 'PUT', headers, body: JSON.stringify({ merge_method: 'merge' }),
  });
  assert.equal(merge.status, 200);
  let status;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/_dispatcher/status`, { headers });
    assert.equal(response.status, 200);
    status = await response.json();
    if (status.accepted === 1 && status.pending === 0) break;
    await new Promise(r => setTimeout(r, 150));
  }
  assert.deepEqual({ accepted: status.accepted, completed: status.completed, failed: status.failed, workflows: status.workflows },
    { accepted: 1, completed: 1, failed: 0, workflows: 1 }, output.join(''));
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(recorded.length, 1, 'Exactly one matching workflow should invoke act');
  assert.equal(recorded[0].args[0], 'pull_request');
  assert.equal(recorded[0].event.action, 'closed');
  assert.equal(recorded[0].event.pull_request.merged, true);
  assert.equal(recorded[0].event.pull_request.base.ref, 'main');
  assert.ok(recorded[0].args.includes(join(workspace, '.github/workflows/merge.yml')));
  assert.ok(!recorded[0].args.includes(join(workspace, '.github/workflows/ignore.yml')));
  console.log('PASS: mock PR merge automatically dispatched exactly one matching workflow to act');
} finally {
  if (dispatcher && dispatcher.exitCode === null && dispatcher.signalCode === null) {\n    const exited = once(dispatcher, 'exit');\n    dispatcher.kill('SIGTERM');\n    await exited;\n  }
  if (upstream) await new Promise(r => upstream.close(r));
  await rm(root, { recursive: true, force: true });
}
