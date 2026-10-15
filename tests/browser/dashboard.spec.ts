import { test, expect } from "@playwright/test";
test("real dashboard drills down, preserves filters and opens issue", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "让每一个问题得到回应" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /已超期.*查看 Issue/ }).click();
  await expect(page).toHaveURL(/risk=overdue/);
  await expect(page.getByLabel("期限预警")).toHaveValue("overdue");
  await page.reload();
  await expect(page.getByLabel("期限预警")).toHaveValue("overdue");
  await page.getByRole("button", { name: "重置筛选" }).click();
  await page.locator("table.issues tbody .title").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("mobile navigation and empty combined filter", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/issues?q=impossible-keyword-000000");
  await expect(
    page.getByText("没有符合条件的 Issue。可以重置筛选或等待首次成功同步。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "重置筛选" }).click();
  await expect(page.locator("table.issues tbody tr").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("exports dashboard, all filtered pages, and standalone issue details", async ({
  page,
}, testInfo) => {
  const fs = await import("node:fs/promises");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "让每一个问题得到回应" }),
  ).toBeVisible();
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出大屏 HTML" }).click();
  let download = await downloadPromise;
  let path = testInfo.outputPath("dashboard.html");
  await download.saveAs(path);
  let html = await fs.readFile(path, "utf8");
  expect(html).toContain("<svg");
  expect(html).not.toContain("<script");
  await page.goto("/#/issues?state=all");
  await expect(
    page.getByRole("button", { name: /导出筛选结果/ }),
  ).toBeVisible();
  const count = Number(
    (
      await page.getByRole("button", { name: /导出筛选结果/ }).innerText()
    ).match(/（(\d+) 项）/)![1],
  );
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出筛选结果/ }).click();
  download = await downloadPromise;
  path = testInfo.outputPath("issues.html");
  await download.saveAs(path);
  html = await fs.readFile(path, "utf8");
  expect((html.match(/<tr>/g) || []).length).toBe(count + 1);
  expect(count).toBeGreaterThan(25);
  await page.locator("table.issues tbody .title").first().click();
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出详情 HTML" }).click();
  download = await downloadPromise;
  path = testInfo.outputPath("detail.html");
  await download.saveAs(path);
  html = await fs.readFile(path, "utf8");
  expect(html).toContain("原始描述");
  expect(html).not.toContain("<script");
  await page.goto("file://" + path);
  await expect(page.getByRole("heading", { name: "原始描述" })).toBeVisible();
});
test("internal assignee label drills down and is included in HTML export", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /未分配内部责任人.*查看 Issue/ })
    .click();
  await expect(page.getByLabel("内部责任人", { exact: true })).toHaveValue(
    "missing",
  );
  await expect(
    page
      .locator("table.issues tbody tr")
      .first()
      .getByText("未分配内部责任人", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("内部责任人", { exact: true })).toHaveValue(
    "missing",
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出筛选结果/ }).click();
  const download = await pending;
  const path = testInfo.outputPath("internal.html");
  await download.saveAs(path);
  const fs = await import("node:fs/promises");
  expect(await fs.readFile(path, "utf8")).toContain("未分配内部责任人");
});
