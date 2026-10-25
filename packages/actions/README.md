# Marketplace action source and distribution

This follows the source/distribution pattern used by `moyarich/reusable-workflows`, with one root action for Marketplace discovery.

| Purpose                                    | Authoritative source                                       | Generated runtime                             |
| ------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| Action metadata                            | `actions/setup-github-emulator/action.yml` in this package | Root `action.yml`                             |
| Node setup and post-cleanup implementation | `src/` in this package                                     | Root `dist/github-emulator/*.js`              |
| Docker server and smoke test               | `packages/emulate-github/docker/`                          | Root `dist/github-emulator/{docker,scripts}/` |
| Distribution generator                     | `vite.config.ts` in this package                           | —                                             |

Root `action.yml` and `dist/github-emulator/` are generated, tracked distribution files. Edit their package sources and regenerate; do not hand-edit the root copies. The published runtime uses only its generated directory and does not reach into the caller's checkout or workspace packages. The local shell scripts remain separate.

```sh
npm run build:actions
```

The `githubAction()` Vite plugin copies the Docker and scripts folders and copies the package metadata to root `action.yml`. Commit the generated distribution alongside source changes.

## Workflow setup

The action starts a container, seeds a local repository (defaulting to the caller's repository name), waits for readiness, and publishes `api-url`, `token`, `repository`, and `container-id`. A Node action post step removes that invocation's container, including when later workflow steps fail. Default seeding creates a repository and base branch; it adds no package manifest or release fixtures and does not clone real repository content.

`seed-file` accepts caller-owned emulator YAML or JSON. It must define the selected repository and local token. The file is mounted read-only; the supplied fixture is used unchanged. Use later workflow steps to seed file contents, branches, PRs, or other fixtures through the local API.

`export-env: true` exports `GH_EMULATOR_API_URL` and `GH_EMULATOR_TOKEN`. These are convenience variables; they do not change a client's default API address or GitHub's contexts. Configure each client explicitly with `api-url` and `token`, and never pass a production GitHub token to the emulator.

## Marketplace

GitHub Marketplace discovers the root metadata, rather than package subdirectory metadata. See `docs/04-github-action/page.mdx` and `.github/workflows/action-release.yml` for preparation and release instructions. A generated valid action is not automatically listed: publish a versioned GitHub release with the Marketplace option and accept GitHub's terms in the GitHub UI.

The runtime and Vite configuration are strict TypeScript (`.ts`). Run
`npm run typecheck --workspace=@moyarich/github-emulator-actions` to validate them.
Vite builds the runtime into `dist/github-emulator/` for GitHub Actions.

The action does not execute workflows or release scenarios. Existing reusable workflows
need their own supported API endpoint configuration and per-job service setup.

`prepare-workflow.js` is a separate harness entry point. It imports tracked Git
objects and prepares mock event identities; the generic setup action does not invoke it.
