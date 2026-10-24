import { lazy, Suspense, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { navigation, routes } from "virtual:moyaforge-mdx/metadata";
import { sources } from "virtual:moyaforge-mdx/lazy-registry";
import registry from "../registry.config";
import { CodeBlock } from "./components/ui/CodeBlock/CodeBlock";
import { CodeGroup, CodeTab } from "./components/ui/CodeGroup/CodeGroup";
import { CopyButton } from "./components/ui/CopyButton/CopyButton";
import "./styles.css";

const components = { pre: CodeBlock, CodeGroup, CodeTab, CopyButton };
const pages = new Map(
  routes.map((page) => [
    page.path,
    { ...page, Content: lazy(sources[page.source].lazyPages[page.file]) },
  ]),
);
const defaultPath = "/docs/getting-started";
function currentPath() {
  const hash = window.location.hash.slice(1);
  return hash.startsWith("/") ? hash : defaultPath;
}
function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
function App() {
  const path = useSyncExternalStore(subscribe, currentPath, () => defaultPath);
  const page = pages.get(path);
  return (
    <>
      <a
        className="skip-link"
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("content")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="site-header">
        <a className="brand" href={`#${defaultPath}`}>
          GitHub emulator <span>Docs & examples</span>
        </a>
        <a href="https://github.com/moyarich/github_emulator">View source ↗</a>
      </header>
      <div className="docs-layout">
        <nav aria-label="GitHub emulator documentation">
          {Object.entries(registry.sources).map(([source, config]) => (
            <section key={source} aria-label={config.navigation.label}>
              <p>{config.navigation.label}</p>
              {navigation
                .filter((item) => item.source === source)
                .map((item) => (
                  <a
                    key={item.path}
                    href={`#${item.path}`}
                    aria-current={path === item.path ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                ))}
            </section>
          ))}
        </nav>
        <main
          id="content"
          tabIndex={-1}
          aria-label={page?.title ?? "Page not found"}
        >
          <p className="eyebrow">
            GITHUB EMULATOR ·{" "}
            {page?.source === "examples" ? "EXAMPLES" : "DOCUMENTATION"}
          </p>
          {page ? (
            <Suspense
              key={path}
              fallback={<p role="status">Loading documentation…</p>}
            >
              <page.Content components={components} />
            </Suspense>
          ) : (
            <>
              <h1>Page not found.</h1>
              <a href={`#${defaultPath}`}>Return to getting started</a>
            </>
          )}
        </main>
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing playground root element");
createRoot(root).render(<App />);
