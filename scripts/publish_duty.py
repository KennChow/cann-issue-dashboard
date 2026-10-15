"""Read the private duty source into Pages output, never into public Git sources."""

import json
import os
from pathlib import Path
import urllib.request


def publication_data(source):
    fields = []
    for field in source["fields"]:
        paths = [
            {key: path[key] for key in ("repo", "prefix", "whole_repo")}
            for path in field["paths"] if path["repo"] == "ge"
        ]
        if paths:
            fields.append({
                "module": field["module"], "sub_field": field["sub_field"],
                "paths": paths,
                "owner": {"name": field["owner"]["name"]},
                "committer": {"name": field["committer"]["name"]},
            })
    fallback = source["repo_fallbacks"]["ge"]
    return {
        "fields": fields,
        "repo_fallbacks": {"ge": {
            "sub_field": fallback["sub_field"],
            "owner": {"name": fallback["owner"]["name"]},
            "committer": {"name": fallback["committer"]["name"]},
        }},
        "files": source.get("files", []),
    }


if __name__ == "__main__":
    token = os.environ.get("PRIVATE_REPO_PAT", "")
    if not token:
        raise SystemExit("Missing PRIVATE_REPO_PAT deployment secret")
    target = Path("dist/data/duty.json")
    if not Path("dist/index.html").is_file():
        raise SystemExit("Build the site before preparing duty publication data")
    request = urllib.request.Request(
        "https://api.github.com/repos/KennChow/cann-radar-private/contents/ge/duty.json",
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github.raw+json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = publication_data(json.load(response))
    payload = json.dumps(data, ensure_ascii=False)
    if token in payload:
        raise SystemExit("Credential detected in publication data")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload + "\n", encoding="utf-8")
    print("Prepared GE duty publication data in ignored Pages output")
