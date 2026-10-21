import { test, expect } from "@playwright/test";

// Synthetic identities only: private ownership data must never enter this repo.
const fixture = {
  fields: [
    {
      module: "GE",
      sub_field: "执行",
      paths: [{ repo: "ge", prefix: "runtime/v2", whole_repo: false }],
      owner: { name: "测试田主甲" },
      committer: { name: "测试提交人甲" },
    },
    {
      module: "GE",
      sub_field: "内存",
      paths: [
        { repo: "ge", prefix: "runtime/v2/kernel/memory", whole_repo: false },
      ],
      owner: { name: "测试田主乙" },
      committer: { name: "测试提交人乙" },
    },
  ],
  repo_fallbacks: {
    ge: {
      sub_field: "其他",
      owner: { name: "测试兜底" },
      committer: { name: "测试兜底提交人" },
    },
  },
  files: [
    "runtime/v2/kernel/memory/allocator.cc",
    "runtime/v2/allocator.cc",
    "base/common/allocator.cc",
    "api/acl_c/test.cc",
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/data/duty.json", (route) =>
    route.fulfill({ json: fixture }),
  );
});

test("automatic duty table, precise paths and multiple fuzzy candidates", async ({
  page,
}) => {
  await page.goto("/#/duty");
  await expect(
    page.getByRole("heading", { name: "责任田查询" }),
  ).toBeVisible();
  await expect(
    page.locator('input[type="password"], input[type="file"]'),
  ).toHaveCount(0);
  await expect(page.locator(".duty-table tbody tr")).toHaveCount(2);
  const query = page.getByLabel("GE 仓库链接、文件路径或关键词");
  await query.fill(
    "https://gitcode.com/cann/ge/blob/master/runtime/v2/kernel/memory/allocator.cc#L2",
  );
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(1);
  await expect(page.locator(".duty-results")).toContainText("测试田主乙");
  await expect(page.locator(".duty-results")).not.toContainText("测试田主甲");
  await query.fill("allocator.cc");
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(3);
  await expect(page.locator(".duty-results")).toContainText("测试兜底");
  await query.fill("alocator.cc");
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(3);
  await expect(page.locator(".duty-results")).toContainText("拼写近似");
  await query.fill(
    "C:\\work\\ge\\runtime\\v2\\kernel\\memory\\allocator.cc:12",
  );
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(1);
  await expect(page.locator(".duty-results")).toContainText("测试田主乙");
  await query.fill(
    "https://github.com/org/other/blob/main/runtime/v2/allocator.cc",
  );
  await expect(page.getByRole("alert")).toContainText("不是 GE 仓库");
  expect(
    await page.evaluate(
      () => JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
    ),
  ).not.toContain("测试田主");
  await page.reload();
  await expect(page.locator(".duty-table tbody tr")).toHaveCount(2);
});

test("nested directories, slash branches, boundary matching and mobile layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/duty");
  const query = page.getByLabel("GE 仓库链接、文件路径或关键词");
  await query.fill("runtime/v2");
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(2);
  await expect(page.locator(".duty-results")).toContainText("包含的责任田");
  await query.fill("runtime/v2/kernel/mem");
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(2);
  await expect(page.locator(".duty-results")).toContainText("测试田主乙");
  await expect(page.locator(".duty-results")).not.toContainText("测试田主甲");
  await query.fill("runtime/v2/kernel/memory/new_file_not_in_index.cc");
  await expect(page.locator(".duty-results")).toContainText("目录规则推断");
  await expect(page.locator(".duty-results")).toContainText("测试田主乙");
  await query.fill(
    "https://github.com/cann/ge/blob/feature/new/runtime/v2/kernel/memory/allocator.cc",
  );
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(1);
  await expect(page.locator(".duty-results")).toContainText("测试田主乙");
  await query.fill("runtime/v20/unassigned.cc");
  await expect(page.locator(".duty-results")).toContainText("测试兜底");
  await expect(page.locator(".duty-results")).not.toContainText("测试田主甲");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("failed data load offers retry without requiring a credential or file", async ({
  page,
}) => {
  await page.route("**/data/duty.json", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/#/duty");
  await expect(page.getByRole("alert")).toContainText("责任田数据暂不可用");
  await expect(
    page.locator('input[type="password"], input[type="file"]'),
  ).toHaveCount(0);
  await page.route("**/data/duty.json", (route) =>
    route.fulfill({ json: fixture }),
  );
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.locator(".duty-table tbody tr")).toHaveCount(2);
});
