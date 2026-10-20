export type Person = { login: string; avatar: string; membership?: string };
export type Metrics = {
  age_hours: number;
  overdue_hours: number;
  remaining_hours: number;
  unassigned: boolean;
  no_internal_assignee: boolean;
  unreplied: boolean;
  overdue: boolean;
  due_soon: boolean;
  has_report: boolean;
};
export type Issue = {
  id: string;
  repo: string;
  number: string;
  title: string;
  body: string;
  url: string;
  author: Person;
  author_role?: "internal" | "external";
  assignees: Person[];
  workload_owner?: string;
  state: string;
  internal_assignment?: "assigned" | "missing" | "unknown";
  reply_status: string;
  first_reply_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: string[];
  source_status: string;
  priority: string;
  comments_complete: boolean;
  comments: {
    id: string;
    body: string;
    author: Person;
    created_at: string;
    system: boolean;
  }[];
  reports: { at: string; url: string; path: string }[];
  events: { at: string; kind: string; detail: string }[];
  metrics: Metrics;
};
export type Stats = {
  open: number;
  closed: number;
  unassigned: number;
  no_internal_assignee: number;
  unreplied: number;
  overdue: number;
  due_soon: number;
  unknown: number;
  normal: number;
  has_report: number;
  closure_rate: number | null;
};
export type PrComment = {
  id: string;
  body: string;
  author: Person;
  created_at: string;
  updated_at?: string;
  comment_type?: string;
  resolved?: boolean;
  system: boolean;
};
export type PrMetrics = {
  age_hours: number;
  ready: boolean;
  blocked: boolean;
  unreplied: boolean;
  has_linked_issue: boolean;
};
export type PullRequest = {
  id: string;
  repo: string;
  number: string;
  title: string;
  body: string;
  url: string;
  author: Person;
  author_role?: "internal" | "external";
  assignees: Person[];
  testers: Person[];
  state: string;
  draft: boolean;
  mergeable: boolean;
  ci_status: string;
  ci_passed_at: string | null;
  head_sha: string;
  target_branch: string;
  source_branch: string;
  added_lines: number;
  removed_lines: number;
  reply_status: string;
  first_reply_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  labels: string[];
  comment_count?: number;
  comments: PrComment[];
  files: string[];
  linked_issues: string[];
  details_complete: boolean;
  confidential?: boolean;
  metrics: PrMetrics;
};
export type PrStats = {
  total: number;
  open: number;
  merged: number;
  closed: number;
  closed_loop: number;
  ready: number;
  blocked: number;
  unreplied: number;
  has_linked_issue: number;
  closure_rate: number | null;
};
export type Data = {
  internal_directory?: {
    checked_at: string;
    complete: boolean;
    people: {
      login: string;
      avatar: string;
      repos: string[];
      stale_repos: string[];
      explicit_reason: string;
      confirmed: boolean;
    }[];
    sources: Record<string, { last_success?: string; error: string | null }>;
  };
  schema_version: number;
  generated_at: string;
  last_success: string | null;
  complete: boolean;
  errors: string[];
  repositories: Record<
    string,
    {
      issues: Issue[];
      stats: Stats;
      prs?: PullRequest[];
      pr_stats?: PrStats;
      last_success?: string;
      pr_last_success?: string;
      warnings: string[];
      error: string | null;
    }
  >;
  stats: Stats;
  pr_stats?: PrStats;
  owners: {
    person: Person;
    role: string;
    repo_roles: Record<string, string>;
    stats: Stats;
    repos: Record<string, number>;
    issues: string[];
  }[];
  snapshots: ({ date: string } & Stats)[];
  activity: { date: string; created: number; closed: number }[];
  report_success: string | null;
};
