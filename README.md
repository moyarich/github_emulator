# GitHub emulator monorepo

Official documentation: [GitHub emulator guide](https://emulate.dev/docs/github).

## Start the server

From the project root:

```sh
docker compose up --build -d --wait
```

The API stays available at **http://localhost:4001** until you stop it. The container uses `catthehacker/ubuntu:act-latest`, checks Node.js 24+ and npm, and installs the tools and locked dependencies it needs.

Default seed:

- Repository: `moyarich/release-smoke-test`
- Branch: `main`
- Package: `packages/core/package.json`, version `1.0.0`
- Local test token: `local-test-token`

Query it from your Mac:

```sh
curl -H 'Authorization: Bearer local-test-token' \
  http://localhost:4001/repos/moyarich/release-smoke-test
```

Use `http://host.docker.internal:4001` from other Docker containers on your Mac, including act runners. Containers on this Compose network can use `http://github-emulator:4001`. Configure the client library's API base URL and token accordingly; setting an environment variable alone works only if the client reads it.

This provides the emulated GitHub API, rather than the github.com website.

```sh
docker compose logs -f       # View server output
docker compose down          # Stop the server
```

State is in memory and resets when the server process restarts. To use another host port:

```sh
EMULATOR_PORT=4010 docker compose up -d --wait
```

The `environment` section in `compose.yaml` defines networking, repository, token, base branch, manifest path, initial version, and smoke-test settings. Edit defaults there or override the interpolated values through your shell or a root `.env` file. Leave `RELEASE_BRANCH` empty to generate a fresh name for each test.

## Interactive shell

Start the emulator in the background, then open a shell inside its running container:

```sh
npm run docker:up
npm run docker:shell
```

GitHub CLI is installed in the image, and the shell uses the token configured in Compose. At the container prompt, run:

```sh
gh api "$API/repos/$REPO"
gh api "$API/repos/$REPO/pulls"
```

Type `exit` to leave the shell; the emulator keeps running. Stop it separately with `npm run docker:down`.

## HTTPS proxy

Compose starts a Caddy proxy with a local certificate authority. Inside the interactive container shell, DNS, `GH_HOST`, the test token, and certificate trust are already configured:

```sh
npm run docker:up
npm run docker:shell
```

At the container prompt:

```sh
gh api "repos/$REPO"
gh search repos --owner moyarich --created ">$(date -d '40 days ago' +%Y-%m-%d)" --sort updated --order desc
```

The shell runs Linux, so use `date -d`; macOS uses `date -v-40d`. Use the explicit owner rather than `@me`. These search commands query the emulator's repositories. The proxy translates GitHub Enterprise REST paths (`/api/v3/`) to emulator paths.

The Mac-facing endpoint is `https://github.emulator.test:8443`. Port 8443 avoids Docker Desktop's privileged-port helper requirement. Set `HTTPS_PORT` to change it. To access this name directly on your Mac, add this entry to `/etc/hosts`:

```text
127.0.0.1 github.emulator.test
```

Export the proxy's public CA certificate from the monorepo root:

```sh
npm run docker:cert
```

Then, in a dedicated Mac terminal:

```sh
export GH_HOST=github.emulator.test:8443
export GH_ENTERPRISE_TOKEN=local-test-token
# Run from the monorepo root; this path must be absolute.
export SSL_CERT_FILE="$PWD/.local/emulator-ca.crt"
gh api repos/moyarich/release-smoke-test
```

This scopes certificate trust to clients honoring `SSL_CERT_FILE`; it does not install the CA into your Mac's system or browser trust store. Browser trust needs a separate certificate import. The interactive Docker shell needs no host-file or Mac trust changes. Caddy's CA and configuration persist in named Docker volumes; emulator repository state remains in memory.

## Use GitHub CLI (`gh`)

`gh api` works with the emulator when you pass the full HTTP endpoint URL and the local test token:

```sh
GH_TOKEN=local-test-token \
gh api http://localhost:4001/repos/moyarich/release-smoke-test
```

List pull requests:

```sh
GH_TOKEN=local-test-token \
gh api http://localhost:4001/repos/moyarich/release-smoke-test/pulls
```

Replace the port, repository, and token if you changed them in Compose. Full HTTP URLs continue to work. Through the HTTPS proxy, relative `gh api` paths and `gh search repos` also work in the interactive shell. `gh repo view` still fails because the GitHub emulator does not expose its required GraphQL endpoint. See the [GitHub CLI API reference](https://cli.github.com/manual/gh_api).

### Reproduce the shell script with `gh api`

Start the persistent server with `npm run docker:up`, then run the following in Bash with `gh`, `jq`, and `base64` installed. It performs the same API activities as `scripts/github_emulator.sh`, including the optional description update and event-file creation. It creates a branch and PR and changes the package version in the running emulator. Adjust the configuration at the top to match Compose; the release metadata below assumes the default `@example/core` package.

````bash
#!/usr/bin/env bash
set -euo pipefail

API="${API:-http://localhost:4001}"
REPO="${REPO:-moyarich/release-smoke-test}"
TOKEN="${TOKEN:-local-test-token}"
BASE_BRANCH="${BASE_BRANCH:-main}"
RELEASE_BRANCH="${RELEASE_BRANCH:-release/gh-example-$(date +%s)-$$}"
MANIFEST_PATH="${MANIFEST_PATH:-packages/core/package.json}"
NEW_VERSION="${NEW_VERSION:-1.1.0}"

# Always use the full local URL and explicit local authorization.
gh_api() {
  GH_TOKEN="$TOKEN" GH_ENTERPRISE_TOKEN="$TOKEN" gh api "$API/$1" \
    -H "Authorization: Bearer $TOKEN" "${@:2}"
}

# 1. Check the seeded repository (start Docker separately).
gh_api "repos/$REPO" --jq '.full_name'

# 2. Resolve the base commit and create a release branch.
BASE_SHA=$(gh_api "repos/$REPO/git/ref/heads/$BASE_BRANCH" --jq '.object.sha')
gh_api "repos/$REPO/git/refs" --method POST \
  -f ref="refs/heads/$RELEASE_BRANCH" -f sha="$BASE_SHA"

# 3. Read and update the package on the release branch.
CURRENT=$(gh_api "repos/$REPO/contents/$MANIFEST_PATH" \
  --method GET -f ref="$RELEASE_BRANCH")
BLOB_SHA=$(jq -r '.sha' <<< "$CURRENT")
CONTENT=$(jq -r '.content' <<< "$CURRENT" | tr -d '\n' | base64 --decode)
UPDATED=$(jq --arg version "$NEW_VERSION" '.version = $version' <<< "$CONTENT")
ENCODED=$(printf '%s\n' "$UPDATED" | base64 | tr -d '\n')
gh_api "repos/$REPO/contents/$MANIFEST_PATH" --method PUT \
  -f message="chore(release): bump @example/core to $NEW_VERSION" \
  -f content="$ENCODED" -f sha="$BLOB_SHA" -f branch="$RELEASE_BRANCH"

# 4. Open the PR after committing (required by this emulator version).
BODY=$(cat <<'BODY_EOF'
<!-- release-preparation:start -->
```json
{"schemaVersion":1,"packages":[{"name":"@example/core","directory":"packages/core"}]}
```
<!-- release-preparation:end -->
BODY_EOF
)
PR_NUMBER=$(gh_api "repos/$REPO/pulls" --method POST \
  -f title='release: prepare core' -f head="$RELEASE_BRANCH" \
  -f base="$BASE_BRANCH" -f body="$BODY" --jq '.number')

# 5. Update the PR description (optional).
EXISTING=$(gh_api "repos/$REPO/pulls/$PR_NUMBER" --jq '.body')
UPDATED_BODY=$(printf '%s\n\nBumps @example/core to %s.' "$EXISTING" "$NEW_VERSION")
gh_api "repos/$REPO/pulls/$PR_NUMBER" --method PATCH -f body="$UPDATED_BODY"

# 6. Merge the PR and check the result.
gh_api "repos/$REPO/pulls/$PR_NUMBER/merge" --method PUT \
  -f merge_method=merge | jq -e '.merged == true'
PR_JSON=$(gh_api "repos/$REPO/pulls/$PR_NUMBER")
jq -e '.merged == true' <<< "$PR_JSON"
MANIFEST=$(gh_api "repos/$REPO/contents/$MANIFEST_PATH" \
  --method GET -f ref="$BASE_BRANCH" --jq '.content' | tr -d '\n' | base64 --decode)
jq -e --arg version "$NEW_VERSION" '.version == $version' <<< "$MANIFEST"

# 7. Save a merged-PR event for optional replay through act.
REPO_JSON=$(gh_api "repos/$REPO")
EVENT_FILE="${EVENT_FILE:-/tmp/gh-merged-pr-event.json}"
jq -n --argjson pr "$PR_JSON" --argjson repo "$REPO_JSON" \
  '{action:"closed",number:$pr.number,pull_request:$pr,repository:$repo}' > "$EVENT_FILE"
printf 'Merged PR #%s; event saved to %s\n' "$PR_NUMBER" "$EVENT_FILE"
# From the checkout containing the workflow, optionally run:
# act pull_request -W .github/workflows/release-approved-pr.yml -e "$EVENT_FILE"
````

Starting the server and replaying a workflow are Docker/act operations, rather than GitHub API calls. Creating the event JSON does not trigger a workflow automatically. The optional `act` command requires act on the host and runs the workflow against its checkout; configuring clients to use the emulator is separate.

## Run the release smoke test

This starts a separate disposable emulator, updates a package, opens and merges a PR, verifies the merged version, and exits. It can run while the server is up:

```sh
npm run docker:test
```

To exercise PR description updates and a different version:

```sh
UPDATE_PR_BODY=1 NEW_VERSION=2.0.0 docker compose run --rm smoke-test
```

The pinned emulator snapshots the PR head when it opens, so the test commits the version bump before creating the PR.

## Run directly

Requires Node.js 24+, bash, curl, jq, and base64:

```sh
npm ci
npm start  # Persistent API server
# In another terminal, from the monorepo root:
npm test   # Smoke test (uses an existing local server if available)
```

The smoke-test script supports `API`, `REPO`, `TOKEN`, `BASE_BRANCH`, `RELEASE_BRANCH`, `MANIFEST_PATH`, `OLD_VERSION`, `NEW_VERSION`, `UPDATE_PR_BODY`, and `EMU_PORT`. An existing server must contain the requested repository and manifest.

Its optional `RUN_ACT=1` step requires act installed on the host and `WORKFLOW_FILE` pointing at a workflow, with the target checkout as the working directory. The Docker image does not install act.

## GitHub Actions

`.github/workflows/release-approved-pr.yml` runs the disposable Docker smoke test after a PR merges or when started manually. It does not publish packages or create real releases.

## Project layout

```text
package.json
package-lock.json
compose.yaml
.github/workflows/release-approved-pr.yml
docker/
  Dockerfile                    # Docker server and smoke-test runtimes
  proxy/                        # HTTPS proxy image and Caddy config
scripts/                        # Local shell code only; excluded from Docker
  start-emulator.sh
  github_emulator.sh
  cli-common.sh
docs/cli.md
packages/emulate-github/package.json
```


## Workspace commands

Treat this directory as the monorepo root. Install dependencies here with `npm ci`; the shared lockfile covers every package in `packages/*`. The emulator lives in the private `@moya/emulate-github` workspace.

| Command from the root | Purpose |
| --- | --- |
| `npm start` | Start the local emulator without Docker |
| `npm test` | Run workspace tests |
| `npm run docker:up` | Build and start the Docker emulator |
| `npm run docker:down` | Stop Docker services |
| `npm run docker:logs` | Follow Docker logs |
| `npm run docker:shell` | Open an interactive container shell with gh authentication |
| `npm run docker:test` | Run disposable smoke tests in Docker |

For a specific package, use `npm run test --workspace=@moya/emulate-github`. Add future packages under `packages/` with their own private package manifests; keep shared Docker and GitHub Actions configuration at the root.

## Docker build stages

`docker/Dockerfile` separates shared tools (`tools`), locked workspace dependencies (`dependencies`), disposable tests (`smoke-test`), and the persistent API (`server`). Compose selects the server target by default; `npm run docker:test` selects the separate test service.

The server's startup, seed creation, readiness checks, logs, and shutdown handling are defined in the Dockerfile and generated into `/usr/local/bin/start-github-emulator` at build time. The server image does not copy or invoke the local `.sh` files. Those remain in `scripts/` for `npm start` / `npm test` on the host, and are excluded from the Docker build context. The smoke-test target also defines its own implementation in the Dockerfile. Keep the local and Docker startup behavior aligned when changing seed or logging behavior.

## Local script help and menus

Both local entry points support `--help`, `docs`, `config`, and an optional `fzf` menu. See [the CLI guide](docs/cli.md) for settings and examples.

```sh
bash scripts/start-emulator.sh --help
bash scripts/github_emulator.sh docs
bash scripts/start-emulator.sh menu
```

No arguments opens the fzf menu in an interactive terminal when available; otherwise it shows help. Use explicit `start` or `test` actions for automation. Help and configuration commands do not start the emulator. Options accept multiple flag/value pairs, such as `start --port 4010 --repo moya/demo`; see the CLI guide. Sourcing these files only defines entry functions, whose execution is scoped to a subshell.

## Use as a GitHub Action

The root `action.yml` packages the Docker image as a reusable composite action. It builds the selected Dockerfile target and runs it on a Linux runner with Docker. No host Node/npm, act, GitHub credentials, or HTTPS proxy is needed for these tests. It uses only the local test token and a disposable seeded repository.

In this repository, after checkout:

```yaml
steps:
  - uses: actions/checkout@v4
  - name: Run the Docker release test
    uses: ./
    with:
      mode: smoke-test
      new-version: 2.0.0
      update-pr-body: '1'
```

To keep the API running for subsequent steps:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Start local GitHub API
        id: emulator
        uses: ./
        with:
          mode: server
      - name: Query emulator
        env:
          API: ${{ steps.emulator.outputs.api-url }}
          GH_TOKEN: local-test-token
        run: gh api "$API/repos/moyarich/release-smoke-test"
      - name: Clean up
        if: always() && steps.emulator.outputs.container-id != ''
        env:
          CONTAINER_ID: ${{ steps.emulator.outputs.container-id }}
        run: docker rm --force "$CONTAINER_ID"
```

Server mode binds a randomly assigned loopback port to avoid collisions. The `api-url` output is reachable from runner-host steps in the same job; it is not a public URL or automatically reachable from another container/job. The action seeds package version `old-version` and leaves the server running until your cleanup step. Smoke-test mode runs and exits, removing its container automatically. Failed server startup also removes its container.

| Input | Default | Purpose |
| --- | --- | --- |
| `mode` | `smoke-test` | `smoke-test` or `server` |
| `repository` | `moyarich/release-smoke-test` | Emulated owner/repository |
| `base-branch` | `main` | Seeded branch |
| `manifest-path` | `packages/core/package.json` | Package manifest |
| `old-version` | `1.0.0` | Seeded version |
| `new-version` | `1.1.0` | Smoke-test target version |
| `update-pr-body` | `'1'` | Append the version note (`'0'` disables it) |

The workflow `.github/workflows/emulator.yml` tests both modes on pushes, PRs, and manual runs. The merged-PR workflow also uses the action. To call it from another repository after publishing this repository to GitHub, replace `uses: ./` with `uses: moyarich/github_emulator@main` (pin a commit SHA for reproducible runs). This works because the build context is the action's own directory, independent of the caller's checkout. For self-hosted Linux runners, Docker and curl must be available; querying with gh requires gh there too.

## Tools used

| Tool | Purpose | Where it is needed |
| --- | --- | --- |
| Docker / Docker Desktop | Builds and runs the emulator and HTTPS proxy containers | Host, for Docker-based runs |
| Docker Compose v2 | Starts services, publishes ports, and manages networks and certificate volumes | Host; invoked with `docker compose` |
| `catthehacker/ubuntu:act-latest` | Ubuntu base image with a Node runtime for the emulator and workflow environment | Docker build; using this image does not install act |
| Node.js 24+ | Runs the emulator | Included in the base image; install locally for direct runs |
| npm workspaces | Manages monorepo dependencies, the shared lockfile, and root commands | Included in the image; needed on the host for `npm run` commands |
| `emulate` 0.12.3 | Provides the local GitHub API and seeded repository state | Installed through the workspace lockfile |
| Caddy 2 | Proxies HTTPS to the API and generates local CA/server certificates | Separate Compose service using `caddy:2-alpine` |
| GitHub CLI (`gh`) | Queries and modifies the emulator API; supports tested repository searches through HTTPS | Installed in the emulator image; optional on the host |
| `act` | Replays GitHub Actions workflows locally in Docker | Optional host installation; not installed in our images |
| `fzf` | Provides interactive menus for the local shell scripts | Optional local installation; not installed in our images |
| Bash | Runs local scripts, CLI dispatch, and Docker startup | Installed in the emulator image; required for local scripts |
| curl | Makes API requests and checks readiness | Installed in the emulator image; required for local scripts |
| jq | Builds, reads, and validates JSON API payloads | Installed in the emulator image; required for local scripts |
| coreutils / base64 | Encodes and decodes package contents and provides shell utilities | Installed in the emulator image; local scripts need base64 |
| Git, OpenSSH client, unzip | Supports repository checkout, SSH, and archive operations | Installed in the emulator image |
| CA certificates | Provides the standard certificate trust bundle | Installed in the emulator image; the proxy CA is configured separately |
| GitHub Actions | Runs the release smoke-test workflow after a PR merges or on manual dispatch | GitHub-hosted CI; workflow under `.github/workflows/` |

For a Docker-only setup, install Docker Desktop with Compose. Node/npm on the host are needed only for local scripts or the convenient `npm run docker:*` wrappers; equivalent `docker compose` commands work without host Node. Install act or fzf only if you use those optional features.
