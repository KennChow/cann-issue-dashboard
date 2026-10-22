import type { Issue, PrStats, PullRequest } from "./types";
import type { DutyData, DutyField } from "./duty";
import { ownersFor } from "./duty";
import {
  closureRateColor,
  firstRespRateColor,
  toBeijingDateStr,
  workdayHours,
} from "./sla";
import { buildBuckets, type Granularity } from "./trends";

const PR_BOT_LOGINS = new Set([
  "cann-robot",
  "gitcode-bot",
  "openeuler-ci-bot",
  "ascend-robot",
  "atomgit-bot",
]);

function isBotLogin(login: string): boolean {
  const cf = login.toLowerCase();
  return PR_BOT_LOGINS.has(cf) || cf.endsWith("[bot]") || cf.endsWith("-bot");
}

export type PrSlaDetail = {
  isReadyToMerge: boolean;
  isBlockedMerge: boolean;
  respEligible: boolean;
  ciStartIso: string;
  firstHumanReplyAt: string | null;
  firstRespWorkHours: number | null;
  stayWorkHours: number;
  stayWorkDays: number;
  closeWorkDays: number | null;
  sinceCiWorkHours: number;
  firstRespQualified: boolean;
  firstRespUnqualified: boolean;
  openNoResp: boolean;
  openNoRespTimeout: boolean;
  reviewStatus: "resolved" | "unresolved" | "no_opinion";
  reviewStayWorkHours: number | null;
};

export function evaluatePrSla(
  pr: PullRequest,
  snapshotIso: string,
): PrSlaDetail {
  const isReady = !pr.draft && pr.mergeable && pr.ci_status === "passed";
  const isReadyToMerge = pr.state === "open" && isReady;
  const isBlockedMerge = pr.state === "open" && !isReady;
  const respEligible =
    (pr.state === "open" || pr.state === "merged") && isReady;

  const authorLogin = (pr.author?.login || "").toLowerCase();
  const createdMs = Date.parse(pr.created_at);
  const ciStartIso = pr.ci_passed_at || pr.created_at;
  const ciStartMs = Date.parse(ciStartIso) || createdMs;

  const validHumanComments: { created_at: string; ms: number }[] = [];
  const diffComments: {
    created_at: string;
    updated_at: string;
    resolved?: boolean;
  }[] = [];

  for (const c of pr.comments || []) {
    if (c.system) continue;
    const commenter = (c.author?.login || "").toLowerCase();
    if (!commenter || isBotLogin(commenter)) continue;
    if (c.comment_type === "diff_comment" && commenter !== authorLogin) {
      diffComments.push({
        created_at: c.created_at,
        updated_at: c.updated_at || c.created_at,
        resolved: c.resolved,
      });
    }
    const body = (c.body || "").trim();
    if (!body) continue;
    if (commenter === authorLogin) continue;
    const ms = Date.parse(c.created_at);
    if (!Number.isNaN(ms) && ms >= createdMs) {
      validHumanComments.push({ created_at: c.created_at, ms });
    }
  }

  let firstHumanReplyAt: string | null = null;
  if (validHumanComments.length > 0) {
    const afterCi = validHumanComments.find((c) => c.ms >= ciStartMs);
    if (afterCi) {
      firstHumanReplyAt = afterCi.created_at;
    } else if (pr.state === "merged") {
      firstHumanReplyAt = validHumanComments[0].created_at;
    }
  } else if (pr.first_reply_at) {
    firstHumanReplyAt = pr.first_reply_at;
  }

  const endIso = pr.merged_at || pr.closed_at || snapshotIso;
  const stayWorkHours = workdayHours(pr.created_at, endIso);
  const stayWorkDays = Number((stayWorkHours / 24).toFixed(1));
  const closeIso = pr.merged_at || pr.closed_at;
  const closeWorkDays =
    (pr.state === "merged" || pr.state === "closed") && closeIso
      ? Number((workdayHours(pr.created_at, closeIso) / 24).toFixed(1))
      : null;

  const sinceCiWorkHours = workdayHours(ciStartIso, endIso);
  let firstRespWorkHours: number | null = null;
  if (firstHumanReplyAt) {
    const replyMs = Date.parse(firstHumanReplyAt);
    firstRespWorkHours =
      replyMs >= ciStartMs
        ? workdayHours(ciStartIso, firstHumanReplyAt)
        : workdayHours(pr.created_at, firstHumanReplyAt);
  }

  const firstRespQualified = respEligible
    ? firstRespWorkHours !== null
      ? firstRespWorkHours <= 24
      : sinceCiWorkHours <= 24
    : false;
  const firstRespUnqualified = respEligible && !firstRespQualified;

  const openNoResp = isReadyToMerge && firstHumanReplyAt === null;
  const openNoRespTimeout =
    openNoResp && workdayHours(ciStartIso, snapshotIso) > 24;

  let reviewStatus: "resolved" | "unresolved" | "no_opinion" = "no_opinion";
  if (diffComments.length > 0) {
    reviewStatus = diffComments.some((c) => c.resolved === false)
      ? "unresolved"
      : "resolved";
  }

  let reviewStayWorkHours: number | null = null;
  if (isReadyToMerge && reviewStatus !== "unresolved") {
    let reviewStartIso = ciStartIso;
    if (reviewStatus === "resolved" && diffComments.length > 0) {
      let latestMs = ciStartMs;
      for (const c of diffComments) {
        const ms = Date.parse(c.updated_at);
        if (!Number.isNaN(ms) && ms > latestMs) {
          latestMs = ms;
          reviewStartIso = c.updated_at;
        }
      }
    }
    reviewStayWorkHours = Number(
      workdayHours(reviewStartIso, snapshotIso).toFixed(1),
    );
  }

  return {
    isReadyToMerge,
    isBlockedMerge,
    respEligible,
    ciStartIso,
    firstHumanReplyAt,
    firstRespWorkHours,
    stayWorkHours,
    stayWorkDays,
    closeWorkDays,
    sinceCiWorkHours,
    firstRespQualified,
    firstRespUnqualified,
    openNoResp,
    openNoRespTimeout,
    reviewStatus,
    reviewStayWorkHours,
  };
}

export type OfficialPrSlaStats = {
  total: number;
  open: number;
  merged: number;
  closed: number;
  closedLoop: number;
  closureRate: number | null;
  closureColor: "blue" | "amber" | "red";
  readyToMergeNum: number;
  blockedMergeNum: number;
  avgCloseDays: number | null;
  respEligibleTotal: number;
  firstRespQualifiedNum: number;
  firstRespUnqualifiedNum: number;
  firstRespQualifiedRate: number | null;
  firstRespColor: "blue" | "amber" | "red";
  avgFirstRespHours: number | null;
  openNoRespTotal: number;
  openNoRespTimeoutNum: number;
  withLinkedIssueNum: number;
};

export function computeOfficialPrSla(
  prs: PullRequest[],
  snapshotIso: string,
): OfficialPrSlaStats {
  const total = prs.length;
  let open = 0;
  let merged = 0;
  let closed = 0;
  let readyToMergeNum = 0;
  let blockedMergeNum = 0;
  let closeDaysSum = 0;
  let closeDaysCount = 0;
  let respEligibleTotal = 0;
  let firstRespQualifiedNum = 0;
  let firstRespUnqualifiedNum = 0;
  let firstRespHoursSum = 0;
  let firstRespHoursCount = 0;
  let openNoRespTotal = 0;
  let openNoRespTimeoutNum = 0;
  let withLinkedIssueNum = 0;

  for (const pr of prs) {
    if (pr.state === "open") open++;
    else if (pr.state === "merged") merged++;
    else if (pr.state === "closed") closed++;

    if (pr.linked_issues?.length) withLinkedIssueNum++;

    const sla = evaluatePrSla(pr, snapshotIso);
    if (sla.isReadyToMerge) readyToMergeNum++;
    if (sla.isBlockedMerge) blockedMergeNum++;

    if (sla.closeWorkDays !== null) {
      closeDaysSum += sla.closeWorkDays;
      closeDaysCount++;
    }

    if (sla.openNoResp) {
      openNoRespTotal++;
      if (sla.openNoRespTimeout) openNoRespTimeoutNum++;
    }

    if (!sla.respEligible) continue;
    respEligibleTotal++;
    if (sla.firstRespQualified) firstRespQualifiedNum++;
    else firstRespUnqualifiedNum++;

    if (sla.firstRespWorkHours !== null) {
      firstRespHoursSum += sla.firstRespWorkHours;
      firstRespHoursCount++;
    }
  }

  const closedLoop = merged + closed;
  const closureRate =
    total > 0 ? Number(((closedLoop / total) * 100).toFixed(2)) : null;
  const firstRespQualifiedRate =
    respEligibleTotal > 0
      ? Number(((firstRespQualifiedNum / respEligibleTotal) * 100).toFixed(2))
      : null;

  return {
    total,
    open,
    merged,
    closed,
    closedLoop,
    closureRate,
    closureColor: closureRateColor(closureRate),
    readyToMergeNum,
    blockedMergeNum,
    avgCloseDays:
      closeDaysCount > 0
        ? Number((closeDaysSum / closeDaysCount).toFixed(1))
        : null,
    respEligibleTotal,
    firstRespQualifiedNum,
    firstRespUnqualifiedNum,
    firstRespQualifiedRate,
    firstRespColor: firstRespRateColor(firstRespQualifiedRate),
    avgFirstRespHours:
      firstRespHoursCount > 0
        ? Number((firstRespHoursSum / firstRespHoursCount).toFixed(1))
        : null,
    openNoRespTotal,
    openNoRespTimeoutNum,
    withLinkedIssueNum,
  };
}

export function computeDynamicPrStats(prs: PullRequest[]): PrStats {
  const total = prs.length;
  const open = prs.filter((p) => p.state === "open").length;
  const merged = prs.filter((p) => p.state === "merged").length;
  const closed = prs.filter((p) => p.state === "closed").length;
  const closed_loop = merged + closed;
  const ready = prs.filter((p) => p.metrics?.ready).length;
  const blocked = prs.filter((p) => p.metrics?.blocked).length;
  const unreplied = prs.filter((p) => p.metrics?.unreplied).length;
  const has_linked_issue = prs.filter(
    (p) => p.metrics?.has_linked_issue || (p.linked_issues?.length ?? 0) > 0,
  ).length;
  const closure_rate = total
    ? Number(((closed_loop / total) * 100).toFixed(2))
    : null;
  return {
    total,
    open,
    merged,
    closed,
    closed_loop,
    ready,
    blocked,
    unreplied,
    has_linked_issue,
    closure_rate,
  };
}

export function filterPrsByDateRange(
  prs: PullRequest[],
  from: string,
  to: string,
): PullRequest[] {
  if (!from && !to) return prs;
  return prs.filter((p) => {
    const day = toBeijingDateStr(p.created_at);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

export type PrDutyFieldRef = {
  module: string;
  sub_field: string;
  owner: string;
  committer: string;
  isFallback?: boolean;
};

export type LinkedIssueRef = {
  id: string;
  repo: string;
  number: string;
  title: string;
  state: string;
  url: string;
  source_status: string;
  internalMaintainers: string[];
  allAssignees: string[];
};

export type PrAttribution = {
  fields: PrDutyFieldRef[];
  owners: string[];
  committers: string[];
  linkedIssues: LinkedIssueRef[];
  issueMaintainers: string[];
};

const insidePath = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + "/");

function matchRepoFieldsForPath(
  dutyData: DutyData,
  shortRepo: string,
  filePath: string,
): DutyField[] {
  if (shortRepo === "ge") {
    return ownersFor(dutyData, filePath);
  }
  const explicit = dutyData.fields.flatMap((field) =>
    field.paths
      .filter(
        (p) =>
          p.repo === shortRepo &&
          (p.whole_repo || insidePath(filePath, p.prefix)),
      )
      .map((p) => ({ field, length: p.whole_repo ? 0 : p.prefix.length })),
  );
  if (explicit.length > 0) {
    const longest = Math.max(-1, ...explicit.map((m) => m.length));
    return [
      ...new Set(
        explicit.filter((m) => m.length === longest).map((m) => m.field),
      ),
    ];
  }
  if (shortRepo === "metadef") {
    return dutyData.fields.filter(
      (f) =>
        f.sub_field === "公共数据结构" ||
        f.paths.some((p) => p.prefix === "graph_metadef"),
    );
  }
  return [];
}

export function resolvePrAttribution(
  pr: PullRequest,
  dutyData: DutyData | undefined,
  issueMap: Map<string, Issue>,
): PrAttribution {
  const fields: PrDutyFieldRef[] = [];
  const fieldKeySet = new Set<string>();
  const addField = (f: PrDutyFieldRef) => {
    const key = `${f.module}:${f.sub_field}:${f.owner}:${f.committer}`;
    if (!fieldKeySet.has(key)) {
      fieldKeySet.add(key);
      fields.push(f);
    }
  };

  if (dutyData && pr.author_role !== "internal") {
    const shortRepo = pr.repo.replace(/^cann\//, "");
    const files = pr.files || [];
    if (files.length > 0) {
      for (const file of files) {
        const matched = matchRepoFieldsForPath(dutyData, shortRepo, file);
        if (matched.length > 0) {
          for (const m of matched) {
            addField({
              module: m.module,
              sub_field: m.sub_field,
              owner: m.owner.name,
              committer: m.committer.name,
            });
          }
        } else if (dutyData.repo_fallbacks?.[shortRepo]) {
          const fb = dutyData.repo_fallbacks[shortRepo];
          addField({
            module: shortRepo.toUpperCase(),
            sub_field: fb.sub_field,
            owner: fb.owner.name,
            committer: fb.committer.name,
            isFallback: true,
          });
        }
      }
    } else {
      const wholeMatched = matchRepoFieldsForPath(dutyData, shortRepo, "");
      if (wholeMatched.length > 0) {
        for (const m of wholeMatched) {
          addField({
            module: m.module,
            sub_field: m.sub_field,
            owner: m.owner.name,
            committer: m.committer.name,
          });
        }
      } else if (dutyData.repo_fallbacks?.[shortRepo]) {
        const fb = dutyData.repo_fallbacks[shortRepo];
        addField({
          module: shortRepo.toUpperCase(),
          sub_field: fb.sub_field,
          owner: fb.owner.name,
          committer: fb.committer.name,
          isFallback: true,
        });
      }
    }
  }

  const owners = Array.from(
    new Set(fields.map((f) => f.owner).filter(Boolean)),
  );
  const committers = Array.from(
    new Set(fields.map((f) => f.committer).filter(Boolean)),
  );

  const linkedIssues: LinkedIssueRef[] = [];
  const issueMaintainerSet = new Set<string>();
  for (const issueId of new Set(pr.linked_issues || [])) {
    const found = issueMap.get(issueId);
    if (found) {
      const internalMaintainers = Array.from(
        new Set([
          ...found.assignees
            .filter((a) => a.membership === "internal")
            .map((a) => a.login),
          ...(found.internal_assignment === "assigned" &&
          found.workload_owner &&
          found.workload_owner !== "未分配"
            ? [found.workload_owner]
            : []),
        ]),
      );
      for (const m of internalMaintainers) issueMaintainerSet.add(m);
      linkedIssues.push({
        id: found.id,
        repo: found.repo,
        number: found.number,
        title: found.title,
        state: found.state,
        source_status: found.source_status,
        url: found.url,
        internalMaintainers,
        allAssignees: found.assignees.map((a) => a.login),
      });
    } else {
      const [irepo, inum] = issueId.split("#");
      if (irepo && inum) {
        linkedIssues.push({
          id: issueId,
          repo: irepo,
          number: inum,
          title: `Issue #${inum}`,
          state: "unknown",
          source_status: "",
          url: `https://gitcode.com/${irepo}/issues/${inum}`,
          internalMaintainers: [],
          allAssignees: [],
        });
      }
    }
  }

  return {
    fields,
    owners,
    committers,
    linkedIssues,
    issueMaintainers:
      pr.author_role === "internal" ? [] : Array.from(issueMaintainerSet),
  };
}

export type PrRoleKind = "owner" | "committer" | "issue_maintainer";

export const PR_ROLE_LABELS: Record<PrRoleKind, string> = {
  owner: "田主",
  committer: "Committer",
  issue_maintainer: "关联 Issue 维护人",
};

export type PrPersonWorkload = {
  name: string;
  roles: PrRoleKind[];
  totalPrs: number;
  openPrs: number;
  closedLoopPrs: number;
  readyPrs: number;
  unqualifiedPrs: number;
  openNoRespTimeoutPrs: number;
  asOwnerTotal: number;
  asOwnerOpen: number;
  asCommitterTotal: number;
  asCommitterOpen: number;
  asIssueMaintainerTotal: number;
  asIssueMaintainerOpen: number;
  repos: Record<string, number>;
  subFields: string[];
  prIds: string[];
};

export function computePrPersonWorkloads(
  prs: PullRequest[],
  dutyData: DutyData | undefined,
  issueMap: Map<string, Issue>,
  snapshotIso: string,
  roleFilter: PrRoleKind | "" = "",
): PrPersonWorkload[] {
  type Acc = {
    name: string;
    roleSet: Set<PrRoleKind>;
    allPrs: Map<string, { pr: PullRequest; sla: PrSlaDetail }>;
    ownerPrs: Map<string, PullRequest>;
    committerPrs: Map<string, PullRequest>;
    issueMaintainerPrs: Map<string, PullRequest>;
    subFieldSet: Set<string>;
  };
  const map = new Map<string, Acc>();
  const getAcc = (name: string): Acc => {
    let acc = map.get(name);
    if (!acc) {
      acc = {
        name,
        roleSet: new Set(),
        allPrs: new Map(),
        ownerPrs: new Map(),
        committerPrs: new Map(),
        issueMaintainerPrs: new Map(),
        subFieldSet: new Set(),
      };
      map.set(name, acc);
    }
    return acc;
  };

  for (const pr of prs) {
    if (pr.author_role === "internal") continue;
    const attr = resolvePrAttribution(pr, dutyData, issueMap);
    const sla = evaluatePrSla(pr, snapshotIso);

    if (!roleFilter || roleFilter === "owner") {
      for (const owner of attr.owners) {
        const acc = getAcc(owner);
        acc.roleSet.add("owner");
        acc.allPrs.set(pr.id, { pr, sla });
        acc.ownerPrs.set(pr.id, pr);
        for (const f of attr.fields) {
          if (f.owner === owner) acc.subFieldSet.add(f.sub_field);
        }
      }
    }
    if (!roleFilter || roleFilter === "committer") {
      for (const committer of attr.committers) {
        const acc = getAcc(committer);
        acc.roleSet.add("committer");
        acc.allPrs.set(pr.id, { pr, sla });
        acc.committerPrs.set(pr.id, pr);
        for (const f of attr.fields) {
          if (f.committer === committer) acc.subFieldSet.add(f.sub_field);
        }
      }
    }
    if (!roleFilter || roleFilter === "issue_maintainer") {
      for (const maintainer of attr.issueMaintainers) {
        const acc = getAcc(maintainer);
        acc.roleSet.add("issue_maintainer");
        acc.allPrs.set(pr.id, { pr, sla });
        acc.issueMaintainerPrs.set(pr.id, pr);
      }
    }
  }

  const out: PrPersonWorkload[] = [];
  for (const acc of map.values()) {
    const entries = Array.from(acc.allPrs.values());
    if (!entries.length) continue;
    const repos: Record<string, number> = {};
    let openPrs = 0;
    let closedLoopPrs = 0;
    let readyPrs = 0;
    let unqualifiedPrs = 0;
    let openNoRespTimeoutPrs = 0;

    for (const { pr, sla } of entries) {
      if (pr.state === "open") {
        openPrs++;
        repos[pr.repo] = (repos[pr.repo] || 0) + 1;
      } else {
        closedLoopPrs++;
        if (!(pr.repo in repos)) repos[pr.repo] = 0;
      }
      if (sla.isReadyToMerge) readyPrs++;
      if (sla.firstRespUnqualified) unqualifiedPrs++;
      if (sla.openNoRespTimeout) openNoRespTimeoutPrs++;
    }

    const ownerList = Array.from(acc.ownerPrs.values());
    const committerList = Array.from(acc.committerPrs.values());
    const issueMaintainerList = Array.from(acc.issueMaintainerPrs.values());

    const roles: PrRoleKind[] = (
      ["owner", "committer", "issue_maintainer"] as PrRoleKind[]
    ).filter((r) => acc.roleSet.has(r));

    out.push({
      name: acc.name,
      roles,
      totalPrs: entries.length,
      openPrs,
      closedLoopPrs,
      readyPrs,
      unqualifiedPrs,
      openNoRespTimeoutPrs,
      asOwnerTotal: ownerList.length,
      asOwnerOpen: ownerList.filter((p) => p.state === "open").length,
      asCommitterTotal: committerList.length,
      asCommitterOpen: committerList.filter((p) => p.state === "open").length,
      asIssueMaintainerTotal: issueMaintainerList.length,
      asIssueMaintainerOpen: issueMaintainerList.filter(
        (p) => p.state === "open",
      ).length,
      repos,
      subFields: Array.from(acc.subFieldSet),
      prIds: entries.map((e) => e.pr.id),
    });
  }

  return out;
}

export function earliestPrDay(prs: PullRequest[]): string {
  let min = "";
  for (const p of prs) {
    const d = toBeijingDateStr(p.created_at);
    if (d && (!min || d < min)) min = d;
  }
  return min;
}

export function prCreatedClosedTrend(
  prs: PullRequest[],
  from: string,
  to: string,
  g: Granularity,
) {
  const rows = prs.map((p) => {
    const closeIso = p.merged_at || p.closed_at;
    return {
      created: toBeijingDateStr(p.created_at),
      closed:
        (p.state === "merged" || p.state === "closed") && closeIso
          ? toBeijingDateStr(closeIso)
          : null,
    };
  });
  return buildBuckets(from, to, g).map((b) => ({
    date: b.label,
    created: rows.filter((r) => r.created >= b.start && r.created <= b.end)
      .length,
    closed: rows.filter(
      (r) => r.closed && r.closed >= b.start && r.closed <= b.end,
    ).length,
  }));
}

export function prClosureRateTrend(
  prs: PullRequest[],
  repos: string[],
  from: string,
  to: string,
  g: Granularity,
) {
  type Norm = { repo: string; created: string; closed: string | null };
  const rows: Norm[] = prs.map((p) => {
    const closeIso = p.merged_at || p.closed_at;
    return {
      repo: p.repo,
      created: toBeijingDateStr(p.created_at),
      closed:
        (p.state === "merged" || p.state === "closed") && closeIso
          ? toBeijingDateStr(closeIso)
          : null,
    };
  });
  const rate = (subset: Norm[], end: string) => {
    let total = 0;
    let closed = 0;
    for (const r of subset) {
      if (r.created > end) continue;
      total++;
      if (r.closed && r.closed <= end) closed++;
    }
    return total ? Math.round((closed / total) * 10000) / 100 : null;
  };
  const byRepo = Object.fromEntries(
    repos.map((name) => [name, rows.filter((r) => r.repo === name)]),
  );
  return buildBuckets(from, to, g).map((b) => {
    const point: Record<string, string | number | null> = {
      date: b.label,
      all: rate(rows, b.end),
    };
    for (const name of repos) point[name] = rate(byRepo[name], b.end);
    return point;
  });
}
