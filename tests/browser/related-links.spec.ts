import { test, expect } from "@playwright/test";
import type { Data, PullRequest } from "../../src/types";

test("related links show PR lifecycle and original Issue status in lists and drawers", async ({
  page,
}) => {
  const data: Data = await (
    await page.request.get("/data/dashboard.json")
  ).json();
  const repos = Object.values(data.repositories);
  const issue = structuredClone(repos.flatMap((r) => r.issues)[0]);
  const seed = repos.flatMap((r) => r.prs || [])[0];
  issue.source_status = "修复中";
  issue.state = "open";
  issue.title = "LongIssueTitle".repeat(30);
  issue.labels = ["LongLabel".repeat(25)];
  issue.assignees = [
    { login: "LongMaintainer".repeat(20), avatar: "", membership: "internal" },
  ];
  const prs: PullRequest[] = ["open", "merged", "closed"].map(
    (state, index) => ({
      ...structuredClone(seed),
      id: `${seed.repo}!${990001 + index}`,
      number: String(990001 + index),
      title: `关联测试 PR ${state} ${"LongPRTitle".repeat(30)}`,
      url: `https://gitcode.com/${seed.repo}/pulls/${990001 + index}`,
      state,
      author_role: "external",
      linked_issues: [issue.id, issue.id, "cann/missing#999999"],
    }),
  );
  for (const repo of repos) {
    repo.issues = [];
    repo.prs = [];
  }
  repos[0].issues = [issue];
  repos[0].prs = prs;
  await page.route("**/data/dashboard.json", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/#/issues?state=all");
  const row = page.locator("table.issues tbody tr").first();
  await expect(
    page.getByRole("columnheader", { name: "关联PR", exact: true }),
  ).toBeVisible();
  await expect(
    row.locator("td").nth(0).locator(".related-reference"),
  ).toHaveCount(0);
  await expect(
    row.locator("td").nth(2).locator(".related-reference"),
  ).toHaveCount(3);
  expect(
    await row
      .locator("td")
      .evaluateAll((cells) =>
        cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
      ),
  ).toBe(true);
  await expect(row.locator(".related-reference")).toHaveCount(3);
  for (const [index, status] of ["开启", "已合入", "关闭"].entries()) {
    const ref = row.locator(".related-reference").nth(index);
    await expect(ref).toContainText(status);
    await expect(ref.locator("a")).toHaveAttribute("href", prs[index].url);
    await expect(ref.locator("a")).toHaveAttribute("target", "_blank");
  }
  // Stop external navigation while exercising the row's click handler.
  await row
    .locator(".related-reference a")
    .first()
    .evaluate((a) => {
      a.addEventListener("click", (e) => e.preventDefault());
    });
  await row.locator(".related-reference a").first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row.locator(".title").click();
  await expect(
    page.getByRole("dialog").locator(".related-reference"),
  ).toHaveCount(3);
  await page.keyboard.press("Escape");

  await page.goto("/#/prs?state=all");
  const prRow = page.locator("table.issues tbody tr").first();
  await expect(
    page.getByRole("columnheader", {
      name: "维护人/田主/Committer",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "关联Issue", exact: true }),
  ).toBeVisible();
  await expect(prRow.locator("td").nth(2)).toContainText(
    issue.assignees[0].login,
  );
  await expect(prRow.locator("td").nth(3)).not.toContainText("内部维护人");
  expect(
    await prRow
      .locator("td")
      .evaluateAll((cells) =>
        cells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
      ),
  ).toBe(true);
  await expect(prRow.locator(".related-reference")).toHaveCount(2);
  const issueRef = prRow
    .locator(".related-reference")
    .filter({ hasText: "修复中" })
    .first();
  await expect(issueRef.locator("a")).toHaveAttribute("href", issue.url);
  await expect(
    prRow.locator(".related-reference").filter({ hasText: "状态未知" }),
  ).toHaveCount(1);
  await prRow.locator(".title").click();
  await expect(
    page.getByRole("dialog").getByTitle("Issue状态").first(),
  ).toHaveText("修复中");
});
