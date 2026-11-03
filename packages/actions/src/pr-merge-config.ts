import { input } from "./shared.js";

/** Validated inputs for an isolated PR-merge emulation run. */
export interface PrMergeConfig {
  repository: string;
  prNumber: number;
  baseBranch: string;
  workflow?: string;
  token: string;
  githubToken: string;
}

/** Parses and validates action inputs without performing I/O. */
export function prMergeConfiguration(env: NodeJS.ProcessEnv = process.env): PrMergeConfig {
  const repository = input("repository", env.GITHUB_REPOSITORY ?? "", env);
  const rawNumber = input("pr-number", "", env);
  const workflow = input("workflow", "", env);
  const githubToken = input("github-token", "", env);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  if (!/^[1-9]\d*$/.test(rawNumber)) throw new Error("pr-number must be a positive integer");
  if (workflow && !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow))
    throw new Error("workflow must be a .github/workflows YAML path");
  if (!githubToken) throw new Error("github-token is required for PR emulation");
  return {
    repository, prNumber: Number(rawNumber),
    baseBranch: input("base-branch", "main", env),
    workflow: workflow || undefined,
    token: input("token", "local-test-token", env),
    githubToken,
  };
}
