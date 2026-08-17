import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("../fixtures/WORKFLOW-TEST-MIB.mib", import.meta.url),
);

async function uploadTestMib(page) {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(fixturePath);
  await expect(page.locator("#user-module-list [data-module]")).toContainText(
    "WORKFLOW-TEST-MIB",
  );
}

test("provided MIB rows show description previews", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-server-module='1']").click();
  await expect(page.locator(".tree-row .row-description")).toContainText(
    "Synthetic description returned by the provided-MIB list API.",
  );
});

test("uploaded MIB is private, persistent, removable, and fully expanded", async ({ page }) => {
  const apiRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) {
      apiRequests.push({
        method: request.method(),
        postData: request.postData(),
        url: request.url(),
      });
    }
  });

  await uploadTestMib(page);
  await expect(page.locator("#scope-title")).toHaveText("Search or select a MIB");
  await expect(page.locator(".empty-search")).toBeVisible();
  await expect(page.locator("[data-server-module='1']")).toContainText("PROVIDED-TEST-MIB");
  expect(apiRequests.some((request) => request.url.includes("/api/search.php"))).toBe(false);
  await page.locator("#user-module-list [data-module]").click();

  const rows = page.locator(".tree-row");
  await expect(rows).toHaveCount(7);
  await expect(page.locator("#expand-button")).toHaveText("Collapse all");
  await expect(page.getByText("iso", { exact: true })).toHaveCount(0);
  await expect(page.getByText("enterprises", { exact: true })).toHaveCount(0);
  await expect(page.getByText("workflowHighTemperature", { exact: true })).toBeVisible();
  await expect(
    page.locator(".tree-row", { hasText: "workflowTemperature" }).locator(".row-description"),
  ).toContainText("Current synthetic chassis temperature.");

  const expandedCount = await rows.evaluateAll((items) =>
    items.filter((item) => item.classList.contains("expanded")).length,
  );
  expect(expandedCount).toBe(7);

  await page.reload();
  await expect(page.locator("#user-module-list [data-module]")).toContainText(
    "WORKFLOW-TEST-MIB",
  );
  expect(apiRequests.every((request) => request.method === "GET" && !request.postData)).toBe(true);
  expect(apiRequests.some((request) => request.url.includes("WORKFLOW-TEST-MIB"))).toBe(false);

  await page.locator("#clear-button").click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog [value='confirm']").click();
  await expect(page.locator("#user-module-list [data-module]")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#user-module-list [data-module]")).toHaveCount(0);

  await page.locator("#file-input").setInputFiles(fixturePath);
  await expect(page.locator("#user-module-list [data-module]")).toHaveCount(1);
  await page.locator("[data-remove-file='WORKFLOW-TEST-MIB.mib']").click();
  await expect(page.locator("#user-module-list [data-module]")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#user-module-list [data-module]")).toHaveCount(0);
});

test("tree OIDs align and hover information stays anchored", async ({ page }) => {
  await uploadTestMib(page);
  await page.locator("#user-module-list [data-module]").click();

  const oidLefts = await page.locator(".tree-row .node-oid").evaluateAll((items) =>
    items.map((item) => Math.round(item.getBoundingClientRect().left)),
  );
  expect(new Set(oidLefts).size).toBe(1);

  const row = page.locator(".tree-row", { hasText: "workflowTemperature" });
  await row.hover({ position: { x: 20, y: 8 } });
  const tooltip = page.locator("#row-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Current synthetic chassis temperature.");
  const initialBox = await tooltip.boundingBox();

  await row.hover({ position: { x: 180, y: 25 } });
  const movedBox = await tooltip.boundingBox();
  expect(movedBox).toEqual(initialBox);
});

test("global search identifies the MIB and Show in tree expands only the target path", async ({
  page,
}) => {
  await uploadTestMib(page);
  await page.locator("#search-input").fill("workflowTemperature");

  const result = page.locator(".search-result-shell", { hasText: "workflowTemperature" });
  await expect(result).toContainText("WORKFLOW-TEST-MIB");
  await expect(result).toContainText("1.3.6.1.4.1.424242.1.1.7");
  await expect(result.locator(".row-description")).toContainText(
    "Current synthetic chassis temperature.",
  );
  await result.locator("[data-row-tree]").click();

  await expect(page.locator("#scope-title")).toHaveText("WORKFLOW-TEST-MIB");
  await expect(page.locator(".tree-row.selected .node-name")).toHaveText(
    "workflowTemperature",
  );
  await expect(page.locator(".tree-row", { hasText: "workflowHighTemperature" })).toHaveCount(0);

  const expandedNames = await page.locator(".tree-row.expanded .node-name").allTextContents();
  expect(expandedNames).toEqual(["workflowTest", "workflowDevices", "workflowSensors"]);

  await expect(page.locator(".description-section")).toContainText(
    "Current synthetic chassis temperature.",
  );
  await expect(page.locator(".source-section")).toBeVisible();
  await expect(page.locator(".source-section")).toContainText("Source declaration");
});
