export type DutyField = {
  module: string;
  sub_field: string;
  paths: { repo: string; prefix: string; whole_repo: boolean }[];
  owner: { name: string };
  committer: { name: string };
};

export type DutyData = {
  fields: DutyField[];
  repo_fallbacks: Record<string, Omit<DutyField, "module" | "paths">>;
  updated_at?: number;
  files?: string[];
};

export type DutyMatch = {
  path: string;
  fields: DutyField[];
  kind: "明确归属" | "包含的责任田" | "模糊候选" | "拼写近似" | "兜底归属";
};

const inside = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + "/");

export function parseDuty(value: unknown): DutyData {
  const d = value as DutyData;
  if (!d || !Array.isArray(d.fields) || !d.repo_fallbacks?.ge) {
    throw Error("责任田数据缺少 fields 或 GE 兜底配置");
  }
  for (const f of d.fields) {
    if (
      !f.module ||
      !f.sub_field ||
      !f.owner?.name ||
      !f.committer?.name ||
      !Array.isArray(f.paths) ||
      f.paths.some(
        (p) =>
          typeof p.repo !== "string" ||
          typeof p.prefix !== "string" ||
          typeof p.whole_repo !== "boolean",
      )
    ) {
      throw Error("责任田条目格式错误：需要模块、路径、田主和 committer");
    }
  }
  if (
    !d.repo_fallbacks.ge.owner?.name ||
    !d.repo_fallbacks.ge.committer?.name ||
    (d.files !== undefined &&
      (!Array.isArray(d.files) || d.files.some((p) => typeof p !== "string")))
  ) {
    throw Error("兜底配置或文件索引格式错误");
  }
  return d;
}

export function geFields(data: DutyData): DutyField[] {
  return data.fields.filter((f) => f.paths.some((p) => p.repo === "ge"));
}

export function dutyIndex(data: DutyData): string[] {
  const paths = new Set<string>();
  for (const path of [
    ...(data.files || []),
    ...geFields(data).flatMap((f) =>
      f.paths.filter((p) => p.repo === "ge").map((p) => p.prefix),
    ),
  ]) {
    const parts = path.split("/").filter(Boolean);
    while (parts.length) {
      paths.add(parts.join("/"));
      parts.pop();
    }
  }
  return [...paths].sort();
}

export function ownersFor(data: DutyData, path: string): DutyField[] {
  const matches = geFields(data).flatMap((field) =>
    field.paths
      .filter(
        (p) => p.repo === "ge" && (p.whole_repo || inside(path, p.prefix)),
      )
      .map((p) => ({ field, length: p.whole_repo ? 0 : p.prefix.length })),
  );
  const longest = Math.max(-1, ...matches.map((m) => m.length));
  return [
    ...new Set(matches.filter((m) => m.length === longest).map((m) => m.field)),
  ];
}

function normalizedQueries(raw: string, index: string[]): string[] {
  let q = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/");
  if (/^https?:\/\//i.test(q)) {
    const url = new URL(q);
    if (
      !["gitcode.com", "github.com", "raw.githubusercontent.com"].includes(
        url.hostname,
      )
    ) {
      throw Error("请输入 GitCode / GitHub 的 GE 仓库链接，或仓库文件路径");
    }
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (!/^ge(?:\.git)?$/i.test(parts[1] || ""))
      throw Error("该链接不是 GE 仓库链接");
    if (parts.length === 2) return [""];
    let tail = parts.slice(2);
    if (tail[0] === "-") tail = tail.slice(1);
    if (url.hostname !== "raw.githubusercontent.com") {
      if (!["blob", "tree", "raw"].includes(tail[0])) {
        throw Error(
          "请输入仓库首页、文件或目录链接；Issue / PR 链接不包含文件路径",
        );
      }
      tail = tail.slice(1);
    }
    // A branch can contain slashes: keep every plausible repository-path suffix.
    const roots = new Set(index.map((p) => p.split("/")[0]));
    const candidates = tail
      .slice(1)
      .map((_, i) => tail.slice(i + 1).join("/"))
      .filter((p) => roots.has(p.split("/")[0]));
    return [
      ...new Set(candidates.length ? candidates : [tail.slice(1).join("/")]),
    ];
  }
  q = q.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, "");
  q = q.replace(/^\.\//, "").replace(/\/+$/, "");
  const marker = q.toLowerCase().lastIndexOf("/ge/");
  if (marker >= 0) q = q.slice(marker + 4);
  else if (/^ge\//i.test(q)) q = q.slice(3);
  else if (/^(?:[a-z]:)?\//i.test(q)) {
    const parts = q.split("/");
    const roots = new Set(index.map((p) => p.split("/")[0]));
    const at = parts.findIndex((p) => roots.has(p));
    if (at < 0)
      throw Error("无法识别该绝对路径在 GE 仓库中的位置，请输入仓库相对路径");
    q = parts.slice(at).join("/");
  }
  return [q === "ge" || q === "." ? "" : q];
}

function similar(a: string, b: string): boolean {
  if (a.length < 4 || Math.abs(a.length - b.length) > 2) return false;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])),
      );
    }
    row = next;
  }
  return (
    row[b.length] <= Math.min(2, Math.floor(Math.max(a.length, b.length) / 4))
  );
}

export function searchDuty(
  data: DutyData,
  raw: string,
  index = dutyIndex(data),
): DutyMatch[] {
  const queries = normalizedQueries(raw, index);
  const matches = new Map<string, DutyMatch>();
  const fields = geFields(data);
  for (const query of queries) {
    if (!query) {
      for (const f of fields)
        for (const p of f.paths.filter((p) => p.repo === "ge")) {
          matches.set(p.prefix, {
            path: p.prefix,
            fields: ownersFor(data, p.prefix),
            kind: "包含的责任田",
          });
        }
      continue;
    }
    const exact = ownersFor(data, query);
    // A bare filename is ambiguous even if it happens to exist at repository root.
    if (query.includes("/") && (exact.length || index.includes(query))) {
      matches.set(query, {
        path: query,
        fields: exact,
        kind: exact.length ? "明确归属" : "兜底归属",
      });
      for (const f of fields)
        for (const p of f.paths.filter(
          (p) =>
            p.repo === "ge" && p.prefix !== query && inside(p.prefix, query),
        )) {
          matches.set(p.prefix, {
            path: p.prefix,
            fields: ownersFor(data, p.prefix),
            kind: "包含的责任田",
          });
        }
      continue;
    }
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const substring = index.filter((path) =>
      tokens.every((t) => path.toLowerCase().includes(t)),
    );
    for (const path of substring) {
      matches.set(path, {
        path,
        fields: ownersFor(data, path),
        kind: "模糊候选",
      });
    }
    for (const f of fields) {
      if (
        tokens.every((t) =>
          `${f.module} ${f.sub_field} ${f.owner.name} ${f.committer.name}`
            .toLowerCase()
            .includes(t),
        )
      ) {
        for (const p of f.paths.filter((p) => p.repo === "ge")) {
          matches.set(p.prefix, {
            path: p.prefix,
            fields: ownersFor(data, p.prefix),
            kind: "模糊候选",
          });
        }
      }
    }
    if (!substring.length && !matches.size) {
      const name = query.toLowerCase().split("/").pop()!;
      for (const path of index.filter((p) =>
        similar(name, p.toLowerCase().split("/").pop()!),
      )) {
        matches.set(path, {
          path,
          fields: ownersFor(data, path),
          kind: "拼写近似",
        });
      }
    }
    if (!matches.size && query.includes("/")) {
      matches.set(query, { path: query, fields: [], kind: "兜底归属" });
    }
  }
  return [...matches.values()];
}
