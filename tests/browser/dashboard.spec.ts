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
test("workload cards label outsiders and drill down to unique ownership", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "责任人名下 Issue 数量" }),
  ).toBeVisible();
  await expect(
    page.locator(".owner").filter({ hasText: "外部开发者" }).first(),
  ).toBeVisible();
  const data = await (await page.request.get("/data/dashboard.json")).json();
  const target = data.owners.find((o: any) =>
    o.issues.includes("cann/metadef#125"),
  );
  expect(target).toBeTruthy();
  expect(target.role).not.toBe("external");
  const card = page
    .locator(".owner")
    .filter({ has: page.locator("strong", { hasText: target.person.login }) });
  await card.click();
  await expect(page.getByLabel("工作量归属", { exact: true })).toHaveValue(
    target.person.login,
  );
  await expect(
    page.getByRole("button", {
      name: `导出筛选结果 HTML（${target.stats.open} 项）`,
    }),
  ).toBeVisible();
  await page.getByLabel("搜索标题关键词 / 编号 / 提出人 / 责任人").fill("#125");
  await expect(page.locator("table.issues tbody tr")).toHaveCount(1);
});

test("owner role filtering persists and updates counts and drilldown", async ({
  page,
}) => {
  await page.goto("/");
  const data = await (await page.request.get("/data/dashboard.json")).json();
  for (const role of ["external", "internal"]) {
    await page.getByLabel("责任人类型", { exact: true }).selectOption(role);
    const expected = data.owners.filter((o: any) =>
      Object.values(o.repo_roles).includes(role),
    );
    await expect(page.locator(".owner")).toHaveCount(expected.length);
    const label = role === "external" ? "外部开发者" : "内部责任人";
    await expect(page.locator(".owner .owner-name .tag").first()).toHaveText(
      label,
    );
    await page.reload();
    await expect(page.getByLabel("责任人类型", { exact: true })).toHaveValue(
      role,
    );
  }
  await page.locator(".owner").first().click();
  await expect(page.getByLabel("归属人身份", { exact: true })).toHaveValue(
    "internal",
  );
});
test("unified internal directory shows provenance and exports HTML", async ({
  page,
}, testInfo) => {
  await page.goto("/#/members");
  await expect(
    page.getByRole("heading", { name: "内部责任人总表", exact: true }),
  ).toBeVisible();
  await page.getByLabel("搜索内部人员").fill("Chang-an-HW");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("内部责任人");
  await expect(page.locator("tbody tr")).toContainText("用户确认");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出总表 HTML" }).click();
  const download = await pending;
  const path = testInfo.outputPath("directory.html");
  await download.saveAs(path);
  const fs = await import("node:fs/promises");
  const html = await fs.readFile(path, "utf8");
  expect(html).toContain("Chang-an-HW");
  expect(html).toContain("成员来源仓库");
  await page.goto("/#/dashboard?owner_role=internal");
  await expect(
    page
      .locator(".owner")
      .filter({ has: page.locator("strong", { hasText: "Chang-an-HW" }) }),
  ).toHaveCount(1);
  await page.goto("/#/dashboard?owner_role=external");
  await expect(
    page
      .locator(".owner")
      .filter({ has: page.locator("strong", { hasText: "Chang-an-HW" }) }),
  ).toHaveCount(0);
});
test("official SLA metrics, time range filter, nav order, and submitter filter", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "全局数据概览" }),
  ).toBeVisible();
  await expect(page.getByText(/digital\.hicann\.cn/)).toHaveCount(0);
  const navLinks = await page.locator("header nav a").allInnerTexts();
  expect(navLinks.slice(0, 2)).toEqual(["运行总览", "Issue 工作台"]);
  await expect(page.getByText("📖 统计规则说明")).toBeVisible();
  await expect(page.locator("details.sla-rules-box")).not.toHaveAttribute("open", "");
  for (const title of [
    "Issue 开启和关闭数量",
    "未关闭 Issue 时长",
    "未关闭 Issue 回复状态",
    "Issue 创建与关闭趋势",
    "Issue 闭环率趋势",
  ]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  const trendPills = page.getByRole("group", { name: "趋势统计区间" });
  await trendPills.getByRole("button", { name: "自定义" }).click();
  await expect(page).toHaveURL(/t_range=custom/);
  await page.getByLabel("趋势起始日期").fill("2026-03-01");
  await expect(page).toHaveURL(/t_from=2026-03-01/);
  await page.getByLabel("趋势统计粒度").selectOption("month");
  await expect(page).toHaveURL(/t_gran=month/);
  await expect(page.locator(".trend-range-label")).toContainText("2026-03-01");
  await page.getByRole("button", { name: "近两周" }).click();
  await expect(page).toHaveURL(/range=2w/);
  await page
    .getByRole("button", { name: /首次响应未达标数.*查看明细/ })
    .click();
  await expect(page).toHaveURL(/first_resp=unqualified/);
  await expect(page.getByLabel("首次响应 SLA")).toHaveValue("unqualified");
  await page.getByRole("button", { name: "重置筛选" }).click();
  await expect(page.getByLabel("提出人", { exact: true })).toHaveCount(0);
  const search = page.getByLabel("搜索标题关键词 / 编号 / 提出人 / 责任人");
  await expect(search).toHaveAttribute("placeholder", /提出人\/责任人|提出人 \/ 责任人/);
});
