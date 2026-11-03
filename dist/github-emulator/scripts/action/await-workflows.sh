#!/usr/bin/env bash
set -euo pipefail
docker compose exec -T github-dispatcher node --input-type=module <<'JAVASCRIPT'
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  const response = await fetch('http://127.0.0.1:4002/_dispatcher/status', {
    headers: { Authorization: `Bearer ${process.env.TOKEN}` },
  });
  if (!response.ok) throw Error(`Dispatcher returned ${response.status}`);
  const status = await response.json();
  if (status.accepted && status.pending === 0) {
    console.log(JSON.stringify(status));
    if (status.failed || !status.workflows) throw Error('Dispatched workflows failed or none matched');
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
throw Error('Timed out awaiting dispatched workflows');
JAVASCRIPT
