import { expect, test } from "@playwright/test";

test("discovers emulator docs and examples and routes to them", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Run GitHub locally.",
  );
  const nav = page.getByRole("navigation", {
    name: "GitHub emulator documentation",
  });
  await expect(
    nav.getByRole("region", { name: "Documentation" }),
  ).toBeVisible();
  await expect(nav.getByRole("region", { name: "Examples" })).toBeVisible();
  await expect(nav.getByText("Components", { exact: true })).toHaveCount(0);
  await nav.getByRole("link", { name: "Configuration", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Configure the emulator.",
  );
  await nav.getByRole("link", { name: "Query with gh", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Query the local API.",
  );
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Query the local API.",
  );
  await nav
    .getByRole("link", { name: "Release pull request", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Test a release pull request.",
  );
  expect(errors).toEqual([]);
});

test("startup tabs support keyboard navigation", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "Start the emulator" });
  const root = tabs.getByRole("tab", { name: "Monorepo root" });
  const standalone = tabs.getByRole("tab", { name: "Package directory" });
  await standalone.click();
  await expect(page.getByRole("tabpanel")).toContainText(
    "cd packages/emulate-github",
  );
  await standalone.press("Home");
  await expect(root).toBeFocused();
  await expect(page.getByRole("tabpanel")).toContainText("npm run docker:up");
});

test("copies the emulator query", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const copy = page.getByRole("button", {
    name: /Copy repository query|Copied!/,
  });
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('gh api "repos/$REPO"');
});
