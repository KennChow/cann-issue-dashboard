"""Prepare private GE ownership data and file index; never publish or push it."""

import argparse
import json
import subprocess
from pathlib import Path


def prepare(ge_root, private_checkout):
    ge_root = Path(ge_root).resolve()
    private_checkout = Path(private_checkout).resolve()
    remote = subprocess.check_output(
        ["git", "-C", str(private_checkout), "remote", "get-url", "origin"],
        text=True,
    ).strip().removesuffix(".git")
    if remote not in (
        "https://github.com/KennChow/cann-radar-private",
        "git@github.com:KennChow/cann-radar-private",
    ):
        raise ValueError("输出目录必须是 KennChow/cann-radar-private 的检出目录")
    data = json.loads((ge_root / "duty.json").read_text(encoding="utf-8"))
    if not isinstance(data.get("fields"), list) or not data.get("repo_fallbacks", {}).get("ge"):
        raise ValueError("责任田 JSON 结构无效")
    for field in data["fields"]:
        if not field.get("owner", {}).get("name") or not field.get("committer", {}).get("name"):
            raise ValueError("田主与 committer 必须完整")
    data["files"] = sorted(filter(None, subprocess.check_output(
        ["git", "-C", str(ge_root), "ls-files", "-z"], text=True,
    ).split("\0")))
    data["source_commit"] = subprocess.check_output(
        ["git", "-C", str(ge_root), "rev-parse", "HEAD"], text=True,
    ).strip()
    target = private_checkout / "ge" / "duty.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)
    print(f"已生成私有责任田与 {len(data['files'])} 个文件的索引；尚未提交或推送。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ge-root", required=True)
    parser.add_argument("--private-checkout", required=True)
    args = parser.parse_args()
    prepare(args.ge_root, args.private_checkout)
