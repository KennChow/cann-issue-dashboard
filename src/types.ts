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
export type Data = {
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
      last_success?: string;
      warnings: string[];
      error: string | null;
    }
  >;
  stats: Stats;
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
