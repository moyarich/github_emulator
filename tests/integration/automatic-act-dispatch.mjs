import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const root = await mkdtemp(join(tmpdir(), 'event-dispatch-integration-'));
const repo = 'fixture/event-dispatch';
const token = 'local-test-token';
const realAct = process.env.REAL_ACT === '1';
let dispatcher;
let upstream;
let result = 'Failed';
let failure = '';
let status;
const started = Date.now();
const output = [];
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
    ...(realAct ? [
      '  release:',
      '    needs: verify',
      '    uses: ./.github/workflows/reusable-release.yml',
    ] : []),
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
  if (realAct) await writeFile(join(workspace, '.github/workflows/reusable-release.yml'), [
    'name: Local reusable release draft',
    'on: workflow_call',
    'jobs:',
    '  draft:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Create isolated draft release',
    '        run: |',
    '          node -e "fetch(\u0027__MOCK_API_URL__/repos/fixture/event-dispatch/releases\u0027, { method: \u0027POST\u0027, headers: { \u0027Content-Type\u0027: \u0027application/json\u0027 }, body: JSON.stringify({ tag_name: \u0027v0.2.0\u0027, name: \u0027Mock release\u0027, draft: true }) }).then(r => { if (!r.ok) process.exit(1); console.log(\u0027draft-release-created\u0027); }).catch(e => { console.error(e); process.exit(1); })"',
    '',
  ].join('\n'));
  const releases = [];
  const calls = join(root, 'act-calls.jsonl');
  const fakeAct = join(bin, 'act');
  if (!realAct) await writeFile(fakeAct, '#!/usr/bin/env node\n' +
    'const fs = require("node:fs");\n' +
    'const args = process.argv.slice(2);\n' +
    'const file = args[args.indexOf("--eventpath") + 1];\n' +
    'fs.appendFileSync(process.env.ACT_CALLS, JSON.stringify({args, event: JSON.parse(fs.readFileSync(file, "utf8"))}) + "\\n");\n');
  if (!realAct) await chmod(fakeAct, 0o755);
  if (realAct) {
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'ci@example.invalid']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'CI']);
    execFileSync('git', ['-C', workspace, 'add', '.']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'fixture']);
    execFileSync('git', ['-C', workspace, 'branch', '-M', 'main']);
    execFileSync('git', ['-C', workspace, 'checkout', '-qb', 'release/prepare-test']);
    await writeFile(join(workspace, 'CHANGELOG.md'), '## v0.2.0 release preparation\n');
    execFileSync('git', ['-C', workspace, 'add', 'CHANGELOG.md']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'Prepare release']);
    execFileSync('git', ['-C', workspace, 'checkout', '-q', 'main']);
  }
  let pr = { number: 7, state: 'open', merged: false, base: { ref: 'main' }, head: { ref: realAct ? 'release/prepare-test' : 'feature/test' } };
  upstream = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === `/repos/${repo}`) return json(200, { full_name: repo, default_branch: 'main' });
    if (path === `/repos/${repo}/pulls/7` && req.method === 'GET') return json(200, pr);
    if (path === `/repos/${repo}/releases` && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const release = JSON.parse(Buffer.concat(chunks).toString());
      if (!release.draft) return json(422, { message: 'Only draft releases allowed' });
      releases.push(release);
      return json(201, { id: releases.length, ...release });
    }
    if (path === `/repos/${repo}/pulls/7/merge` && req.method === 'PUT') {
      let sha = 'fixture-merge-sha';
      if (realAct) {
        execFileSync('git', ['-C', workspace, 'merge', '--no-ff', '-m', 'Merge release preparation PR', 'release/prepare-test']);
        sha = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      }
      pr = { ...pr, merged: true, state: 'closed' };
      return json(200, { merged: true, sha });
    }
    json(404, { message: 'Not found' });
  });
  upstream.listen(0, '0.0.0.0');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  if (realAct) {
    // A Linux act container on the bridge network can reach the host gateway,
    // whereas host.docker.internal is not guaranteed to resolve on Linux.
    const gateway = execFileSync('docker', [
      'network', 'inspect', process.env.DISPATCH_NETWORK || 'bridge',
      '--format', '{{(index .IPAM.Config 0).Gateway}}',
    ], { encoding: 'utf8' }).trim();
    assert.match(gateway, /^\d{1,3}(?:\.\d{1,3}){3}$/, 'Expected IPv4 Docker gateway');
    const reusablePath = join(workspace, '.github/workflows/reusable-release.yml');
    const fixture = await readFile(reusablePath, 'utf8');
    await writeFile(reusablePath, fixture.replace('__MOCK_API_URL__', `http://${gateway}:${upstreamPort}`));
    execFileSync('git', ['-C', workspace, 'add', reusablePath]);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'Configure isolated release API']);
  }
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(() => resolvePort(selected));
    });
  });
  dispatcher = spawn(process.execPath, ['--experimental-strip-types', resolve('dist/github-emulator/dispatcher/index.ts')], {
    env: { ...process.env, PATH: realAct ? process.env.PATH : `${bin}:${process.env.PATH}`, ACT_CALLS: calls,
      DISPATCH_ENABLED: '1', DISPATCH_WORKSPACE: workspace, DISPATCH_WORKFLOWS: '.github/workflows',
      DISPATCH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, DISPATCH_PORT: String(port),
      REPO: repo, TOKEN: token, ...(realAct ? {} : { DISPATCH_SOURCE_SHA: 'fixture-merge-sha' }),
      ...(realAct ? { DISPATCH_NETWORK: process.env.DISPATCH_NETWORK || 'bridge', DISPATCH_IMAGE: 'node:24-bookworm', DISPATCH_TEST_API_URL: `http://host.docker.internal:${upstreamPort}` } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dispatcher.stdout.on('data', b => {
    const line = b.toString();
    output.push(line);
    if (realAct) process.stdout.write(line);
  });
  dispatcher.stderr.on('data', b => {
    const line = b.toString();
    output.push(line);
    if (realAct) process.stderr.write(line);
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const deadline = Date.now() + (realAct ? 240000 : 30000);
  let ready = false;
  while (Date.now() < deadline) {
    if (dispatcher.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/_dispatcher/health`);
      if (response.ok) { ready = true; break; }
    } catch {
      // Dispatcher may not have started listening yet; retry until deadline.
    }
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(ready, `Dispatcher did not start: ${output.join('')}`);
  const merge = await fetch(`${base}/repos/${repo}/pulls/7/merge`, {
    method: 'PUT', headers, body: JSON.stringify({ merge_method: 'merge' }),
  });
  assert.equal(merge.status, 200);
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/_dispatcher/status`, { headers });
    assert.equal(response.status, 200);
    status = await response.json();
    if (status.accepted === 1 && status.pending === 0) break;
    await new Promise(r => setTimeout(r, 150));
  }
  assert.deepEqual({ accepted: status.accepted, completed: status.completed, failed: status.failed, workflows: status.workflows },
    { accepted: 1, completed: 1, failed: 0, workflows: 1 }, output.join(''));
  if (realAct) {
    assert.match(output.join(''), /merge-event-fixture/, 'Real act must execute the expected workflow step');
    assert.match(output.join(''), /\[dispatcher\] act exit code: 0/, 'Real act must exit successfully');
    assert.match(output.join(''), /draft-release-created/, 'Reusable workflow must create a draft release');
    assert.equal(releases.length, 1, 'Exactly one draft release must be created');
    assert.equal(releases[0].tag_name, 'v0.2.0');
    assert.equal(releases[0].draft, true);
    assert.match(execFileSync('git', ['-C', workspace, 'show', 'HEAD:CHANGELOG.md'], { encoding: 'utf8' }), /v0\.2\.0/);
  } else {
    const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(recorded.length, 1, 'Exactly one matching workflow should invoke act');
    assert.equal(recorded[0].args[0], 'pull_request');
    assert.equal(recorded[0].event.action, 'closed');
    assert.equal(recorded[0].event.pull_request.merged, true);
    assert.equal(recorded[0].event.pull_request.base.ref, 'main');
    assert.ok(recorded[0].args.includes(join(workspace, '.github/workflows/merge.yml')));
    assert.ok(!recorded[0].args.includes(join(workspace, '.github/workflows/ignore.yml')));
  }
  result = 'Passed';
  console.log(realAct ? 'PASS: real act executed the automatically dispatched workflow' : 'PASS: mock PR merge automatically dispatched exactly one matching workflow to act');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (realAct && process.env.GITHUB_STEP_SUMMARY) {
    const log = output.join('');
    const jobLines = [...log.matchAll(/\[([^\]\n]+)\]\s+🏁\s+Job succeeded/g)].map(match => match[1]);
    const failedJobs = [...log.matchAll(/\[([^\]\n]+)\].*Job failed/g)].map(match => match[1]);
    const exitCodes = [...log.matchAll(/\[dispatcher\] act exit code: (\S+)/g)].map(match => match[1]);
    const duration = ((Date.now() - started) / 1000).toFixed(1);
    const actVersion = (() => {
      try { return execFileSync('act', ['--version'], { encoding: 'utf8' }).trim(); }
      catch { return 'Unavailable'; }
    })();
    const jobUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';
    const summary = [
      '## Real `act` merge-event integration',
      '',
      `**Result:** ${result === 'Passed' ? '✅ Passed' : '❌ Failed'}`,
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Event | `pull_request.closed` |',
      '| Fixture workflow | `merge.yml` |',
      `| Execution engine | ${actVersion.replaceAll('|', '\\|')} |`,
      '| Runner image | `node:24-bookworm` |',
      `| Workflows executed | ${status?.workflows ?? 'Unknown'} |`,
      `| Dispatch failures | ${status?.failed ?? 'Unknown'} |`,
      `| act exit codes | ${exitCodes.length ? exitCodes.map(code => `\`${code}\``).join(', ') : 'Not observed'} |`,
      `| Duration | ${duration}s |`,
      '',
      '### Executed jobs',
      '',
      '| Job | Result |',
      '| --- | --- |',
      ...jobLines.map(name => `| ${name.replaceAll('|', '\\|')} | ✅ Passed |`),
      ...failedJobs.map(name => `| ${name.replaceAll('|', '\\|')} | ❌ Failed |`),
      ...(!jobLines.length && !failedJobs.length ? ['| No completed job recorded | ⚠️ Unknown |'] : []),
      '',
      ...(failure ? ['### Failure', '', `\`${failure.replaceAll('`', "'").slice(0, 1500)}\``, ''] : []),
      ...(jobUrl ? [`[View complete execution logs](${jobUrl})`, ''] : []),
    ].join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (dispatcher && dispatcher.exitCode === null && dispatcher.signalCode === null) {
    const exited = once(dispatcher, 'exit');
    dispatcher.kill('SIGTERM');
    await exited;
  }
  if (upstream) await new Promise(r => upstream.close(r));
  await rm(root, { recursive: true, force: true });
}
