import type { Data } from "./types";

// Filter per repository and optional date range: the same person can be internal in one repo and external in another.
export function filterOwners(
  data: Data,
  role: string,
  allowedIds?: Set<string>,
): Data["owners"] {
  if (!role && !allowedIds) return data.owners;
  const issues = new Map(
    Object.values(data.repositories)
      .flatMap((r) => r.issues)
      .map((i) => [i.id, i]),
  );
  return data.owners.flatMap((owner) => {
    const selected = owner.issues
      .map((id) => issues.get(id))
      .filter(
        (i) =>
          i &&
          (!role || owner.repo_roles[i.repo] === role) &&
          (!allowedIds || allowedIds.has(i.id)),
      );
    if (!selected.length) return [];
    const repos: Record<string, number> = {};
    for (const i of selected) if (i) repos[i.repo] = (repos[i.repo] || 0) + 1;
    const effectiveRole =
      role ||
      (new Set(Object.keys(repos).map((r) => owner.repo_roles[r])).size === 1
        ? owner.repo_roles[Object.keys(repos)[0]]
        : owner.role);
    return [
      {
        ...owner,
        role: effectiveRole,
        repos,
        repo_roles: Object.fromEntries(
          Object.keys(repos).map((repo) => [
            repo,
            role || owner.repo_roles[repo],
          ]),
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
