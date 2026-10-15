import type { Data } from "./types";

// Filter per repository: the same person can be internal in one repo and external in another.
export function filterOwners(data: Data, role: string): Data["owners"] {
  if (!role) return data.owners;
  const issues = new Map(
    Object.values(data.repositories)
      .flatMap((r) => r.issues)
      .map((i) => [i.id, i]),
  );
  return data.owners.flatMap((owner) => {
    const selected = owner.issues
      .map((id) => issues.get(id))
      .filter((i) => i && owner.repo_roles[i.repo] === role);
    if (!selected.length) return [];
    const repos: Record<string, number> = {};
    for (const i of selected) if (i) repos[i.repo] = (repos[i.repo] || 0) + 1;
    return [
      {
        ...owner,
        role,
        repos,
        repo_roles: Object.fromEntries(
          Object.keys(repos).map((repo) => [repo, role]),
        ),
        issues: selected.map((i) => i!.id),
        stats: {
          ...owner.stats,
          open: selected.length,
          normal: selected.filter(
            (i) => !i!.metrics.overdue && !i!.metrics.due_soon,
          ).length,
          unreplied: selected.filter((i) => i!.metrics.unreplied).length,
          overdue: selected.filter((i) => i!.metrics.overdue).length,
          due_soon: selected.filter((i) => i!.metrics.due_soon).length,
        },
      },
    ];
  });
}
