# GitHub emulator monorepo

Official documentation: [GitHub emulator guide](https://emulate.dev/docs/github).

## Emulate the merge flow of an existing pull request

Run **Actions → Emulate PR merge flow → Run workflow** in this repository. Supply:

- **repository:** `moyarich/console`
- **pr-number:** `225`
- **workflow:** `.github/workflows/release-approved-pr.yml`

The workflow reads the source PR and checks out its exact head commit, then imports the source into a disposable mock GitHub API, synthesizes the PR merge event, and replays the selected workflow using `act`. Its output includes a GitHub Actions summary, mock GitHub Releases, and service-log artifacts. It fails if any observed mock releases are not drafts.

This is a **simulation**: it never merges the source PR or writes to the real repository. It passes only local test credentials to the emulated workflow and does not provide an npm publishing token. The workflow currently supports same-repository `release/prepare-*` pull requests targeting `main`, such as Console #225; forked PRs are rejected. It depends on the source workflow being compatible with the emulator's GitHub API surface.

## Start the server

From the project root:

```sh
npm run docker:up
```

The API stays available at **http://localhost:4001** until you stop it. The container uses `catthehacker/ubuntu:act-latest`, installs the tools and pinned runtime packages it needs.

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
npm run docker:logs          # View server output
npm run docker:down          # Stop the server
```

State is in memory and resets when the server process restarts. To use another host port:

```sh
EMULATOR_PORT=4010 npm run docker:up
```

The `environment` section in `packages/emulate-github/compose.yaml` defines networking, repository, token, base branch, manifest path, initial version, and smoke-test settings. Edit defaults there or override the interpolated values through your shell or a `packages/emulate-github/.env` file. Leave `RELEASE_BRANCH` empty to generate a fresh name for each test.

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
export SSL_CERT_FILE="$PWD/packages/emulate-github/.local/emulator-ca.crt"
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

### GitHub CLI smoke test

The image includes `smoke-test-github-cli.sh`, sourced from
`packages/emulate-github/scripts/smoke-test-github-cli.sh`. Run it against the
Compose emulator after rebuilding:

```sh
npm run docker:up
docker compose -f packages/emulate-github/compose.yaml exec github-emulator smoke-test-github-cli.sh
```

It uses `gh api` to create a release branch, update the package, create and merge
a pull request, and verify the result. It changes emulator state. Set `OLD_VERSION`
and `NEW_VERSION` when repeating the test against an existing emulator. CLI
preferences and credentials are scoped to the test's temporary configuration.
See [gh config](https://cli.github.com/manual/gh_config).

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
UPDATE_PR_BODY=1 NEW_VERSION=2.0.0 npm run docker:test
```

The pinned emulator snapshots the PR head when it opens, so the test commits the version bump before creating the PR.

## Run directly

Requires Node.js 24+, bash, curl, jq, and base64:

```sh
npm ci
npm start  # Persistent API server
# In another terminal, from the monorepo root:
npm run test:emulator   # Smoke test (uses an existing local server if available)
```

The smoke-test script supports `API`, `REPO`, `TOKEN`, `BASE_BRANCH`, `RELEASE_BRANCH`, `MANIFEST_PATH`, `OLD_VERSION`, `NEW_VERSION`, `UPDATE_PR_BODY`, and `EMULATE_PORT`. An existing server must contain the requested repository and manifest.

Its optional `RUN_ACT=1` step requires act installed on the host and `WORKFLOW_FILE` pointing at a workflow, with the target checkout as the working directory. The Docker image does not install act.

## GitHub Actions

`.github/workflows/smoke-test_release-approved-pr.yml` runs the disposable Docker smoke test after a PR merges or when started manually. It does not publish packages or create real releases.

## Project layout

```text
package.json
package-lock.json
action.yml                      # Generated Marketplace metadata
dist/github-emulator/           # Generated, tracked action runtime
.github/workflows/
apps/playground/
scripts/                        # Local wrappers delegating into the package
docs/cli.md                     # Link to package CLI guide
packages/actions/               # Canonical action metadata, runtime, generator
packages/emulate-github/
  package.json
  compose.yaml
  docker/                       # Self-contained image dependencies and runtimes
    Dockerfile
    start.sh
    smoke-test.sh
    proxy/
  scripts/                      # Server and smoke-test scripts
  docs/cli.md
```

## Workspace commands

Treat this directory as the monorepo root. Install dependencies here with `npm ci`; the shared lockfile covers every package in `packages/*`. The emulator lives in the private `@moya/emulate-github` workspace.

| Command from the root   | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `npm start`             | Start the local emulator without Docker                    |
| `npm test`              | Run template unit tests                                    |
| `npm run test:emulator` | Run the local emulator smoke test                          |
| `npm run docker:up`     | Build and start the Docker emulator                        |
| `npm run docker:down`   | Stop Docker services                                       |
| `npm run docker:logs`   | Follow Docker logs                                         |
| `npm run docker:shell`  | Open an interactive container shell with gh authentication |
| `npm run docker:test`   | Run disposable smoke tests in Docker                       |

For a specific package, use `npm run test --workspace=@moya/emulate-github`. Add future packages under `packages/` with their own private package manifests; keep emulator resources inside its package and shared GitHub Actions at the root.

## Docker build stages

Root `npm run docker:*` commands delegate to the package. From `packages/emulate-github`, the same commands work directly. Without host Node/npm, use `docker compose -f packages/emulate-github/compose.yaml up --build -d --wait` from the monorepo root, or run `docker compose up --build -d --wait` inside the package.

`packages/emulate-github/docker/Dockerfile` separates shared tools (`tools`), Docker runtime dependencies (`dependencies`), disposable tests (`smoke-test`), and the persistent API (`server`). Compose selects the server target by default; `npm run docker:test` selects the separate test service.

Startup and smoke-test scripts live in `packages/emulate-github/scripts/` and are copied into the image. The Dockerfile installs pinned runtime packages; startup generates and edits the config using runtime environment values.

Docker builds install `emulate@0.12.3` and `portless@0.15.11` directly with npm. Compose builds from `packages/emulate-github/` with an allowlisted context. The GitHub Action uses its generated Docker context, including the same scripts. No dependency manifests or workspace dependencies are copied into the image.

Build either target directly:

```sh
docker build -f packages/emulate-github/docker/Dockerfile --target mock-github -t github-emulator ./packages/emulate-github
docker build --target smoke-test -t github-emulator-test ./packages/emulate-github/docker
```

## Local script help and menus

The implementation and CLI guide are owned by `packages/emulate-github`; root `scripts/` files are local convenience wrappers that delegate into the package. The package resolves its declared dependencies through Node and does not reference root scripts, docs, or `node_modules` paths.

Both local entry points support `--help`, `docs`, `config`, and an optional `fzf` menu. See [the CLI guide](packages/emulate-github/docs/cli.md) for settings and examples.

```sh
bash scripts/start-emulator.sh --help
bash scripts/github_emulator.sh docs
bash scripts/start-emulator.sh menu
```

No arguments opens the fzf menu in an interactive terminal when available; otherwise it shows help. Use explicit `start` or `test` actions for automation. Help and configuration commands do not start the emulator. Options accept multiple flag/value pairs, such as `start --port 4010 --repo moya/demo`; see the CLI guide. Sourcing these files only defines entry functions, whose execution is scoped to a subshell.

## Use as a GitHub Action

The default action starts a local GitHub API for later workflow steps and automatically removes its container in a post-job step. Configure your workflow clients to use its outputs instead of real GitHub endpoints:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: moyarich/github_emulator@main
        id: emulator
      - name: Exercise GitHub-dependent workflow logic
        env:
          API: ${{ steps.emulator.outputs.api-url }}
          GH_TOKEN: ${{ steps.emulator.outputs.token }}
          REPO: ${{ steps.emulator.outputs.repository }}
        run: gh api "$API/repos/$REPO"
```

Pin a released version or commit SHA when consuming the action. The default `repository` input seeds a fixture using the caller repository's name; it does not clone or modify real repository state. `seed-file` can supply a caller-owned YAML/JSON fixture. Server outputs are `api-url`, `token`, `repository`, and `container-id`. Optional exported variables are `GH_EMULATOR_API_URL` and `GH_EMULATOR_TOKEN`; they are not automatic redirects. `github.api_url` and hardcoded github.com requests remain unchanged, so client API configuration is required. The endpoint is for runner-host steps in the same Linux job with Docker.

The action only starts the GitHub service; it does not run a release scenario or workflow. Standalone smoke tests remain available through `npm run docker:test`. For local action testing after checkout, use `uses: ./`. Read [the GitHub Action guide](docs/04-github-action/page.mdx) for inputs, custom seeds, networking, and cleanup.

### Select an existing workflow to test

Run **Test a workflow against mock GitHub** manually. Choose a workflow path,
including `.github/workflows/release-approved-pr.yml`, and provide its event JSON
and optional seed fixture paths. The harness runs the selected file unchanged
through `act`, with GitHub contexts and `gh` pointed at the mock HTTPS service.
The original workflow's conditions and dry-run settings still apply. See the
[GitHub Action guide](docs/04-github-action/page.mdx) for fixture and routing details.

The **Mock GitHub - via Docker** v2 workflow also imports the checked-out commit
and prepares a replay event using the fixed local token `mock-token`. PR events use a synthetic mock PR by default. A PR number or event-file can override it. Only explicit PR-number overrides read real PR metadata;
nested workflows receive the mock token. Imported snapshots use mock commit IDs
and preserve the original SHA/ref as event provenance.

### Package sources and Marketplace distribution

Following `moyarich/reusable-workflows`, canonical metadata and runtime live under `packages/actions/`. This repo generates one root `action.yml` for Marketplace discovery and a minimal `dist/github-emulator/` runtime. The action uses the generated runtime directly, without npm installation or imports from the caller's checkout.

```sh
npm run build:actions
```

Commit generated files with their source changes. The **Prepare Marketplace action release** workflow builds the distribution, verifies service setup, and prepares a versioned draft release. Review and publish the draft with GitHub's **Publish this Action to GitHub Marketplace** option. GitHub validates the name and requires acceptance of its terms. Metadata and a draft release alone do not create a Marketplace listing. See [GitHub's Marketplace publishing instructions](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

### Test the action with act

```sh
act workflow_dispatch -W .github/workflows/emulator.yml \
  -P ubuntu-latest=catthehacker/ubuntu:act-latest \
  --container-architecture linux/arm64 --pull=false
```

Use `linux/amd64` on an Intel host. The action tries `host.docker.internal` under
`act` when runner loopback cannot reach Docker Desktop's published emulator port.
Use the returned `api-url` output for subsequent steps.

## Native Portless HTTPS

The local emulator package supports upstream emulate's native Portless integration:

```sh
npm run portless:proxy --workspace=@moya/emulate-github
npm run start:portless --workspace=@moya/emulate-github
```

Portless handles the local proxy and certificates and registers `https://github.emulate.localhost`. First-time trust and port setup can require an interactive sudo prompt. The local package supplies a pinned Portless dependency, so no global npm installation is needed. Native `start --portless` also works when Portless is on PATH. This option is separate from Docker's configured Caddy route and does not change the action's runner-local HTTP endpoint. See [emulate's integration](https://github.com/vercel-labs/emulate#https-with-portless).

### Reload configuration from a shared file

Compose mounts `packages/emulate-github/.local/config/` at `/config` read-only.
The directory mount also supports replacing files atomically on the host.
Start the rebuilt image, edit `mock.env`, then reload:

```sh
mkdir -p packages/emulate-github/.local/config
npm run docker:up
cat > packages/emulate-github/.local/config/mock.env <<'ENV'
REPO=fixture/workflow-tests
TOKEN=another-local-token
BASE_BRANCH=develop
OLD_VERSION=2.0.0
ENV
npm run docker:reload
```

The supervisor rereads the file, validates a new seed, and restarts only the
emulator process. The container ID stays the same. **In-memory repositories,
issues, PRs, imported snapshots, and other mutations reset to the seed.** Invalid
settings are rejected before stopping the active emulator. Removed settings return
to the original container environment.

The file accepts literal `KEY=value` lines, optional `export`, comments, and quoted
values. Shell commands and variable expansion are not evaluated. Supported keys:
`REPO`, `TOKEN`, `BASE_BRANCH`, `CONFIG_FILE`, `SEED_FILE`, `MANIFEST_PATH`,
`OLD_VERSION`, `EMULATE_BASE_URL`, `PUBLIC_API`, `BOOTSTRAP_REPOSITORY`,
`EMULATE_PORT`, `EMU_HOST`, `USE_PORTLESS`, and `GENERATED_SECRETS_FILE`.
Changing the listener port, host, or Portless mode requires recreating the container.
An explicitly configured secrets destination must be a new path on every restart.

For a shared YAML seed, put it in the same directory and set
`CONFIG_FILE=/config/emulate.config.yaml` in `mock.env`. Edit either file and run
`npm run docker:reload`. Clients must use the updated token/repository; `docker exec`
still inherits the original Docker environment. The Compose health check uses the
supervisor's active settings.

Native startup supports `EMULATOR_ENV_FILE=/absolute/path/mock.env`. From another
terminal, use `bash packages/emulate-github/scripts/start-emulator.sh reload` with
the same `EMULATE_PORT` (default 4001). Docker's equivalent is:

```sh
docker compose -f packages/emulate-github/compose.yaml exec -T github-emulator start-emulator.sh reload
```

### Docker configuration and Portless

Startup generates `emulate.config.yaml` with `emulate init --service github` and applies runtime `REPO`, `TOKEN`, and `BASE_BRANCH` values before emulate reads it.
To edit a copy on your host:

```sh
docker compose -f packages/emulate-github/compose.yaml run --rm --no-deps github-emulator bash -c 'emulate init --service github >&2; cat emulate.config.yaml' > emulate.config.yaml
```

Mount that file and select it with `CONFIG_FILE`. The server writes private generated
secrets to a fresh temporary `.emulate-secrets.json`; set `GENERATED_SECRETS_FILE`
to a new path on a private writable mount if you need to retain it.

```sh
docker compose -f packages/emulate-github/compose.yaml run --rm --no-deps \
  -p 4001:4001 -p 443:443 \
  -v "$PWD/emulate.config.yaml:/config/emulate.config.yaml:ro" \
  -e CONFIG_FILE=/config/emulate.config.yaml -e USE_PORTLESS=1 \
  github-emulator
```

Use a repository and token from your config via `REPO` and `TOKEN` for readiness.
Portless registers `https://github.emulate.localhost` inside the container. Publishing
port 443 exposes that proxy on the host; its generated CA must also be trusted by
host clients. Container trust does not install trust on your host. Do not run the
existing Caddy proxy on the same host port. The regular Compose startup keeps Caddy
and the existing HTTP endpoint unless `USE_PORTLESS=1` is selected.

`EMULATE_PORT` controls the listener; `EMULATE_BASE_URL` overrides advertised API URLs.
`PORTLESS_URL` is supplied when Portless launches a command; with `emulate --portless`,
emulate registers its own named alias. These settings do not redirect requests to real GitHub.

## Template integration

The original template is retained alongside the emulator: `apps/playground/`, `.storybook/`, TypeScript/Vite/Vitest/Playwright/ESLint/Prettier configuration, and the original CI/release/maintenance workflows. Its original guide is preserved in [docs/template.md](docs/template.md). Shared dependencies use the root workspace lockfile; Docker has a separate manifest and lockfile in `packages/emulate-github/docker/` and does not read workspace manifests or implementation files.

Use `npm run dev` for the playground, `npm test` for unit tests, `npm run checks` for template quality checks, and `npm run test:emulator` for the local API smoke test. Existing `docker:*` commands and the reusable `action.yml` continue to operate independently of the playground.

## Documentation and examples

`apps/playground` is the GitHub emulator documentation site. Its registry discovers project-owned MDX pages from `docs/**/page.mdx` and `examples/**/page.mdx`; navigation and lazy-loaded routes are generated from their metadata.

```sh
npm run dev
npm run build:playground
```

The guides cover running and configuring the emulator. Examples cover gh commands and release pull-request testing. MoyaForge supplies the underlying MDX tooling and copied UI components; the site does not publish component documentation. See [the documentation app guide](apps/playground/README.md) for content authoring and contributor tooling. The emulator Docker image remains independent of this UI.

## Dispatch mock API activity to workflows

The optional dispatcher forwards API requests to the emulator and queues matching
workflows through `act`. Start it with an absolute path to a local Git repository:

```sh
export DISPATCH_WORKSPACE="$PWD"
docker compose -f packages/emulate-github/compose.yaml \
  -f packages/emulate-github/compose.dispatcher.yaml up --build -d --wait
```

Send requests through the HTTPS proxy at `github.emulator.test` (port 8443 on the
host). Direct requests to port 4001 bypass dispatching, which is useful for seeding
repositories and branches before a test. Keep using the configured local `TOKEN`.
The proxy certificate setup described above applies here too.

Supported activities are PR creation, editing, closing, reopening and merging;
issue creation; published release creation; and `POST /repos/{owner}/{repo}/dispatches`
with `event_type` and optional `client_payload`. Failed API requests and reads do
not trigger workflows. This is a supported subset of GitHub events, not a full
GitHub event implementation; pushes and other mutations do not yet emit events.

The dispatcher reads `on:` and matches event names, activity types, and PR base
branch patterns before invoking `act`. PR path filters are rejected because these
API mutations do not supply a changed-file comparison. Set `DISPATCH_WORKFLOWS` to a
specific workflow path to restrict execution without editing that workflow.
Only the configured repository and token can enqueue jobs. Jobs run serially;
failures appear in `docker compose ... logs github-dispatcher`. The queue is
in memory, and each dispatcher process accepts at most 50 events to bound
workflow-triggered loops. Restarting the service clears the queue and limit.
The Docker socket allows these local workflows to run containers on your machine.

V2 still uses explicit event replay. The manual workflow
`.github/workflows/test-github-workflow-v3.yml` uses the dispatcher: select a
workflow, and V3 imports the checkout, performs a matching mock API activity,
and waits for the dispatched workflows to finish. A failed workflow or an
activity that matches no workflow fails the V3 job. V3 supports the activities
listed above and leaves the selected workflow unchanged. Stop the dispatcher with the same two
Compose files and `down --volumes`.

## V4: run release.yml and dispatch downstream events

Run `.github/workflows/test-github-workflow-v4.yml` manually. It starts the mock
services, imports the checkout, then invokes the existing `release.yml` with
`act workflow_dispatch`. The release workflow file is never rewritten.
`release-inputs` is a JSON object overlaid on that workflow's declared defaults;
the V4 default disables dry-run and draft mode so the mock release can emit a
published event. Only the local mock token is supplied to workflow runners.

The dispatcher scans all `.github/workflows` files, starts each matching
workflow, and continues processing activity from those workflows. V4 waits for
the queue to drain and reports downstream failures. It fails if the release
workflow emits no supported API events. Events with no matching workflows are
reported without inventing a downstream run. The repository currently has no
`on: release` subscriber, so add one to exercise a release-published chain.

Public reusable workflow source is fetched from GitHub and mapped into `act`
with `--local-repository`; its API operations still target the mock. The current
upstream `reusable_workspace-package-release.yml` contains unresolved `$/...`
workflow references, which `act` rejects. V4 exposes that upstream failure;
it does not rewrite the release workflow or its dependencies to hide it.
The dispatcher chain has been verified with release and downstream fixtures.

## Tools used

| Tool                             | Purpose                                                                                  | Where it is needed                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Docker / Docker Desktop          | Builds and runs the emulator and HTTPS proxy containers                                  | Host, for Docker-based runs                                                              |
| Docker Compose v2                | Starts services, publishes ports, and manages networks and certificate volumes           | Host; invoked with `docker compose`                                                      |
| `catthehacker/ubuntu:act-latest` | Ubuntu base image with a Node runtime for the emulator and workflow environment          | Docker build; using this image does not install act                                      |
| Node.js 24+                      | Runs the emulator                                                                        | Included in the base image; install locally for direct runs                              |
| npm workspaces                   | Manages monorepo dependencies, the shared lockfile, and root commands                    | Included in the image; needed on the host for `npm run` commands                         |
| `emulate` 0.12.3                 | Provides the local GitHub API and seeded repository state                                | Installed through the workspace lockfile locally and Docker’s own lockfile in containers |
| Caddy 2                          | Proxies HTTPS to the API and generates local CA/server certificates                      | Separate Compose service using `caddy:2-alpine`                                          |
| GitHub CLI (`gh`)                | Queries and modifies the emulator API; supports tested repository searches through HTTPS | Installed in the emulator image; optional on the host                                    |
| MoyaForge MDX and CLI            | GitHub-sourced MDX compilation and component installation                                | Playground; pinned artifacts and provenance under `apps/playground/`                     |
| MoyaForge registry components    | Editable CopyButton, CodeBlock, and CodeGroup with colocated CSS                         | Source-installed in the playground                                                       |
| Vite, React, and Shiki           | Playground server, UI rendering, and build-time code highlighting                        | Playground dependencies                                                                  |
| Portless                         | Native emulate HTTPS aliases for local CLI use                                           | Pinned local development dependency; proxy/trust setup is interactive                    |
| `act`                            | Replays GitHub Actions workflows locally in Docker                                       | Optional host installation; not installed in our images                                  |
| `fzf`                            | Provides interactive menus for the local shell scripts                                   | Optional local installation; not installed in our images                                 |
| Bash                             | Runs local scripts, CLI dispatch, and Docker startup                                     | Installed in the emulator image; required for local scripts                              |
| curl                             | Makes API requests and checks readiness                                                  | Installed in the emulator image; required for local scripts                              |
| jq                               | Builds, reads, and validates JSON API payloads                                           | Installed in the emulator image; required for local scripts                              |
| coreutils / base64               | Encodes and decodes package contents and provides shell utilities                        | Installed in the emulator image; local scripts need base64                               |
| Git, OpenSSH client, unzip       | Supports repository checkout, SSH, and archive operations                                | Installed in the emulator image                                                          |
| CA certificates                  | Provides the standard certificate trust bundle                                           | Installed in the emulator image; the proxy CA is configured separately                   |
| GitHub Actions                   | Runs the release smoke-test workflow after a PR merges or on manual dispatch             | GitHub-hosted CI; workflow under `.github/workflows/`                                    |

For a Docker-only setup, install Docker Desktop with Compose. Node/npm on the host are needed only for local scripts or the convenient `npm run docker:*` wrappers; equivalent `docker compose` commands work without host Node. Install act or fzf only if you use those optional features.
