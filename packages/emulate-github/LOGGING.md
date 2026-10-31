# Docker logging

The default `compose.yaml` keeps Docker's local logging behavior. To follow
logs on the Docker host:

```bash
npm run docker:logs
# or
docker compose logs --follow --timestamps --tail=100
```

## Browser-based log viewer (Dozzle)

The optional `log-viewer` service provides a live web interface for the logs
of Docker containers on the same Docker host, including containers launched
by `act` on that host.

```bash
docker compose --profile logs up -d
# Open http://localhost:8080
```

Set `LOG_VIEWER_PORT` to change the local port. The viewer is bound to
`127.0.0.1` by default. For remote access, use a private SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 user@docker-host
```

Dozzle reads through the Docker API. **Even a read-only mount of
`/var/run/docker.sock` grants high-trust access to Docker; it is not a
read-only authorization boundary.** Do not expose the viewer to the public
internet. Use a dedicated Docker socket proxy for stronger isolation.

Docker must retain readable logs for a container to display them in Dozzle.
The optional `compose.logging.yaml` changes the logging driver to
`syslog` and may prevent Dozzle from seeing those logs if Docker does not
retain a local cache. Use the default local Docker logging configuration for
the web viewer; use the syslog override when you need external collection.

## Forward logs to an external collector

`compose.logging.yaml` is an optional override that forwards stdout/stderr
from `github-emulator`, `github-proxy`, and `smoke-test` to a remote
**syslog** collector. It does not publish a log endpoint or grant access to
the Docker daemon.

Configure a reachable syslog server and then start the stack:

```bash
export SYSLOG_ADDRESS="tcp+tls://logs.example.com:6514"
docker compose -f compose.yaml -f compose.logging.yaml up --build -d --wait
```

The collector must support RFC 5424 over your configured transport. The
`SYSLOG_ADDRESS` is resolved and accessed **by the Docker daemon**, so
`localhost` means the Docker host, not a service container. Docker Desktop
may run its daemon in a VM; use a reachable host/IP accordingly.

To run an externally logged smoke-test container:

```bash
docker compose -f compose.yaml -f compose.logging.yaml \
  --profile test run --build --rm smoke-test
```

The syslog tag includes the Compose container name. View the forwarded records
using the collector's dashboard or query tools; this repository does not deploy
or expose a log-viewing dashboard. Configure destination authentication and
TLS at the collector/network layer, and avoid writing API tokens, request
credentials, or generated secrets to logs.

**Important:** A remote Docker logging driver can change the behavior of
`docker compose logs` depending on the Docker Engine's local cache settings.
To return to local-only logging, recreate containers without the override:

```bash
docker compose -f compose.yaml up --force-recreate -d
```
