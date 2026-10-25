import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { executeWorkflows } from "./index.ts";

// Invoke the original workflow, supplying inputs without rewriting its source.
const workspace = resolve(process.env.DISPATCH_WORKSPACE || "/workspace");
const workflow = resolve(
  workspace,
  process.env.DISPATCH_ENTRY_WORKFLOW || ".github/workflows/release.yml",
);
const overrides: Record<string, unknown> = JSON.parse(
  process.env.RELEASE_INPUTS_JSON || "{}",
);
if (!overrides || Array.isArray(overrides) || typeof overrides !== "object")
  throw new Error("Release inputs must be a JSON object");
const inputs = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      `
import json, sys
from ruamel.yaml import YAML
workflow = YAML(typ="safe").load(open(sys.argv[1]))
triggers = workflow.get("on", {})
if isinstance(triggers, str): triggers = {triggers: {}}
if isinstance(triggers, list): triggers = {name: {} for name in triggers}
if "workflow_dispatch" not in triggers: raise SystemExit("Entry workflow must declare workflow_dispatch")
spec = (triggers["workflow_dispatch"] or {}).get("inputs", {})
values = {name: field["default"] for name, field in spec.items() if "default" in field}
overrides = json.loads(sys.argv[2])
for name in overrides:
    if name not in spec: raise SystemExit("Unknown workflow input: " + name)
values.update(overrides)
for name, field in spec.items():
    if field.get("required") and (name not in values or values[name] is None or values[name] == ""):
        raise SystemExit("Missing workflow input: " + name)
    if name in values and field.get("type") == "boolean" and not isinstance(values[name], bool):
        raise SystemExit("Expected boolean input: " + name)
print(json.dumps(values))
`,
      workflow,
      JSON.stringify(overrides),
    ],
    { encoding: "utf8" },
  ),
);
const token = process.env.TOKEN || "local-test-token";
const repo = process.env.REPO;
const upstream = process.env.DISPATCH_UPSTREAM || "http://github-emulator:4001";
const response = await fetch(`${upstream}/repos/${repo}`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Mock repository: ${response.status}`);
const repository = await response.json();
await executeWorkflows(
  {
    name: "workflow_dispatch",
    payload: {
      inputs,
      repository,
      ref: `refs/heads/${repository.default_branch}`,
      sender: { login: repository.owner.login },
    },
  },
  [workflow],
  workspace,
  token,
);
