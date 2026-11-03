#!/usr/bin/env bash
set -euo pipefail
docker compose exec -T github-dispatcher node --input-type=module <<'JAVASCRIPT'
const { REPO, TOKEN } = process.env;
const base = 'http://github-emulator:4001';
const gateway = 'http://127.0.0.1:4002';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) throw Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json();
};
const prs = await fetchJson(`${base}/repos/${REPO}/pulls`);
const pr = prs.at(-1);
if (!pr) throw Error('Mock PR was not seeded');
await fetchJson(`${gateway}/repos/${REPO}/pulls/${pr.number}/merge`, {
  method: 'PUT', body: JSON.stringify({ merge_method: 'merge' }),
});
JAVASCRIPT
