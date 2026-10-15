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

test("private duty table, precise paths, multiple fuzzy candidates and clearing", async ({
  page,
}) => {
  await page.goto("/#/duty");
  await expect(
    page.getByRole("heading", { name: "GE 责任田查询" }),
  ).toBeVisible();
  await expect(page.getByText("测试田主甲", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("导入责任田 JSON")
    .setInputFiles({
      name: "fixture.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
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
  await page.getByRole("button", { name: "清除当前数据" }).click();
  await expect(page.locator(".duty-table")).toHaveCount(0);
});

test("GitHub credential is sent only to the private API and is not retained", async ({
  page,
}) => {
  await page.route(
    "https://api.github.com/repos/KennChow/cann-radar-private/contents/ge/duty.json",
    async (route) => {
      expect(route.request().headers().authorization).toBe(
        "Bearer synthetic-test-token",
      );
      await route.fulfill({ json: fixture });
    },
  );
  await page.goto("/#/duty");
  await page.getByLabel("GitHub 只读访问凭证").fill("synthetic-test-token");
  await page.getByRole("button", { name: "读取私有分工表" }).click();
  await expect(page.locator(".duty-table tbody tr")).toHaveCount(2);
  expect(page.url()).not.toContain("synthetic-test-token");
  expect(
    await page.evaluate(
      () => JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
    ),
  ).not.toContain("synthetic-test-token");
  await page.reload();
  await expect(page.getByLabel("GitHub 只读访问凭证")).toHaveValue("");
  await expect(page.locator(".duty-table")).toHaveCount(0);
});

test("nested directories, slash branches, boundary matching and mobile layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/duty");
  await page
    .getByLabel("导入责任田 JSON")
    .setInputFiles({
      name: "fixture.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
  const query = page.getByLabel("GE 仓库链接、文件路径或关键词");
  await query.fill("runtime/v2");
  await expect(page.locator(".duty-results tbody tr")).toHaveCount(2);
  await expect(page.locator(".duty-results")).toContainText("包含的责任田");
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

test("private authorization failure stays locked and malformed imports are rejected", async ({
  page,
}) => {
  await page.route(
    "https://api.github.com/repos/KennChow/cann-radar-private/contents/ge/duty.json",
    (route) => route.fulfill({ status: 403, json: {} }),
  );
  await page.goto("/#/duty");
  await page.getByLabel("GitHub 只读访问凭证").fill("synthetic-invalid-token");
  await page.getByRole("button", { name: "读取私有分工表" }).click();
  await expect(page.getByRole("alert")).toContainText("无权读取");
  await expect(page.getByLabel("GitHub 只读访问凭证")).toHaveValue("");
  await expect(page.locator(".duty-table")).toHaveCount(0);
  await page
    .getByLabel("导入责任田 JSON")
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"fields":[null]}'),
    });
  await expect(page.getByRole("alert")).toContainText("文件无效");
});
