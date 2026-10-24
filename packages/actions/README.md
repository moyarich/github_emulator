# Marketplace action source and distribution

This follows the source/distribution pattern used by `moyarich/reusable-workflows`, with one root action for Marketplace discovery.

| Purpose                                    | Authoritative source                                       | Generated runtime                   |
| ------------------------------------------ | ---------------------------------------------------------- | ----------------------------------- |
| Action metadata                            | `actions/setup-github-emulator/action.yml` in this package | Root `action.yml`                   |
| Node setup and post-cleanup implementation | `src/` in this package                                     | Root `dist/github-emulator/*.mjs`   |
| Docker server and smoke test               | `packages/emulate-github/docker/`                          | Root `dist/github-emulator/docker/` |
| Distribution generator                     | `scripts/build.mjs` in this package                        | —                                   |

Root `action.yml` and `dist/github-emulator/` are generated, tracked distribution files. Edit their package sources and regenerate; do not hand-edit the root copies. The published runtime uses only its generated directory and does not reach into the caller's checkout or workspace packages. The local shell scripts remain separate.

```sh
npm run build:actions
npm run check:actions
```

The check compares generated content without rewriting files, including missing and unexpected distribution files. CI runs this check before exercising the root action. Commit generated files with their source changes so `uses: moyarich/github_emulator@<ref>` works without a consumer build.

## Workflow setup

The default is `mode: server`. It starts a container, seeds a local repository (defaulting to the caller's repository name), waits for readiness, and publishes `api-url`, `token`, `repository`, and `container-id`. A Node action post step removes that invocation's container, including when later workflow steps fail. Default seeding creates a test manifest; it does not clone real repository content.

`seed-file` accepts caller-owned emulator YAML or JSON. It must define the selected repository and local token. The file is mounted read-only; the default manifest bootstrap is skipped. Use later workflow steps to seed file contents, branches, PRs, or other fixtures through the local API.

`export-env: true` exports `GH_EMULATOR_API_URL` and `GH_EMULATOR_TOKEN`. These are convenience variables; they do not change a client's default API address or GitHub's contexts. Configure each client explicitly with `api-url` and `token`, and never pass a production GitHub token to the emulator.

## Marketplace

GitHub Marketplace discovers the root metadata, rather than package subdirectory metadata. See `docs/04-github-action/page.mdx` and `.github/workflows/action-release.yml` for preparation and release instructions. A generated valid action is not automatically listed: publish a versioned GitHub release with the Marketplace option and accept GitHub's terms in the GitHub UI.
