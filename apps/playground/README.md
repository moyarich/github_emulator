# GitHub emulator documentation app

This application renders the GitHub emulator's own documentation and examples. It uses MoyaForge as its MDX compiler and UI toolkit; it is not a component catalog.

From the monorepo root:

```sh
npm ci
npm run dev
npm run build:playground
```

## Content registry

`registry.config.ts` owns the emulator's two content sources:

| Source        | Repository directory   | Routes           |
| ------------- | ---------------------- | ---------------- |
| Documentation | `docs/**/page.mdx`     | `#/docs/...`     |
| Examples      | `examples/**/page.mdx` | `#/examples/...` |

Add a `page.mdx` file under either directory with `title`, `label`, and optional `description` frontmatter. Numeric directory prefixes control order and disappear from routes. The app discovers pages and navigation from registry metadata and lazy-loads their MDX components. No hardcoded page imports or navigation entries are needed. Existing reference Markdown files without the `page.mdx` convention do not become routes.

Current guides cover startup, API access, configuration, HTTPS, and the local CLI. Examples cover gh queries and the release pull-request scenario, including GitHub Actions usage.

## Rendering and contributor tooling

`vite.config.ts` uses `@moyarich/moyaforge-mdx`, the registry plugin, and Shiki for build-time syntax highlighting. `src/main.tsx` provides hash routing and registers the source-installed CodeBlock, CodeGroup, CodeTab, and CopyButton components. Their CSS stays colocated; `src/styles.css` owns the app layout.

The MDX compiler and CLI are built from the GitHub revision in `moyaforge.sources.json`. Small package artifacts in `vendor/` allow clean installs without unpublished npm packages or GitHub credentials. The component registry revision is pinned in `moyaforge.components.json`.

Maintainers can rebuild the package artifacts or update the UI source with:

```sh
npm run moyaforge:update --workspace=@moyarich/playground
npm install
npm run components:add --workspace=@moyarich/playground -- copy-button --dry-run --diff
```

The source-build helper works in a temporary directory. Review upstream changes before updating the pinned revision or using `--overwrite` for copied components. These are contributor commands, not documentation content for emulator users.

## Browser checks

```sh
npx playwright test apps/playground/tests/docs.spec.ts
```

Tests cover registry-driven navigation, direct links and reloads, keyboard navigation in command tabs, and copying emulator commands.
