#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import os
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
README = ROOT / "README.md"
USERNAME = os.getenv("GITHUB_PROFILE_USER", "MRsoymilk")
TOKEN = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
GRAPHQL_URL = "https://api.github.com/graphql"


def graphql(query: str, variables: dict) -> dict:
    if not TOKEN:
        raise RuntimeError("GH_TOKEN or GITHUB_TOKEN is required")
    req = urllib.request.Request(
        GRAPHQL_URL,
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "MRsoymilk-profile-generator",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.load(response)
    if payload.get("errors"):
        raise RuntimeError(json.dumps(payload["errors"], ensure_ascii=False))
    return payload["data"]


def load_days() -> list[dict]:
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=364)
    query = """
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }
    """
    data = graphql(query, {
        "login": USERNAME,
        "from": f"{start}T00:00:00Z",
        "to": f"{today}T23:59:59Z",
    })
    user = data.get("user")
    if not user:
        raise RuntimeError(f"GitHub user not found: {USERNAME}")
    days = []
    for week in user["contributionsCollection"]["contributionCalendar"]["weeks"]:
        days.extend(week["contributionDays"])
    return [d for d in days if start.isoformat() <= d["date"] <= today.isoformat()]


def load_repos() -> list[dict]:
    query = """
    query($login: String!) {
      user(login: $login) {
        repositories(
          first: 30
          ownerAffiliations: OWNER
          orderBy: {field: PUSHED_AT, direction: DESC}
          isFork: false
          privacy: PUBLIC
        ) {
          nodes {
            name url description pushedAt isArchived stargazerCount
            primaryLanguage { name }
          }
        }
      }
    }
    """
    repos = graphql(query, {"login": USERNAME})["user"]["repositories"]["nodes"]
    return [r for r in repos if not r["isArchived"] and r["name"] != USERNAME][:10]


def relative_time(value: str) -> str:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    seconds = max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))
    if seconds < 3600:
        return f"{max(1, seconds // 60)}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    if seconds < 604800:
        return f"{seconds // 86400}d ago"
    if seconds < 2592000:
        return f"{seconds // 604800}w ago"
    if seconds < 31536000:
        return f"{seconds // 2592000}mo ago"
    return f"{seconds // 31536000}y ago"


def update_readme(repos: list[dict]) -> None:
    rows = []
    for index, repo in enumerate(repos, 1):
        lang = repo["primaryLanguage"]["name"] if repo.get("primaryLanguage") else "—"
        desc = (repo.get("description") or "").replace("\n", " ").strip()
        suffix = f" — {desc}" if desc else ""
        stars = f" · ★ {repo['stargazerCount']}" if repo.get("stargazerCount") else ""
        rows.append(
            f'{index:02d}. **[{repo["name"]}]({repo["url"]})** · {lang}{stars} '
            f'· updated {relative_time(repo["pushedAt"])}{suffix}'
        )
    replacement = (
        "<!-- RECENT_PROJECTS:START -->\n"
        + ("\n".join(rows) if rows else "_No public repositories found._")
        + "\n<!-- RECENT_PROJECTS:END -->"
    )
    text = README.read_text()
    text, count = re.subn(
        r"<!-- RECENT_PROJECTS:START -->.*?<!-- RECENT_PROJECTS:END -->",
        replacement,
        text,
        flags=re.S,
    )
    if count != 1:
        raise RuntimeError("README project markers are missing or duplicated")
    README.write_text(text)


def colors(dark: bool) -> dict:
    if dark:
        return {
            "bg": "#0d1117", "border": "#30363d", "text": "#f0f6fc",
            "muted": "#8b949e", "grid": "#21262d", "line": "#39d353",
            "empty": "#161b22", "levels": ["#0e4429", "#006d32", "#26a641", "#39d353"],
        }
    return {
        "bg": "#ffffff", "border": "#d0d7de", "text": "#1f2328",
        "muted": "#656d76", "grid": "#d8dee4", "line": "#1a7f37",
        "empty": "#ebedf0", "levels": ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
    }


def heatmap_svg(days: list[dict], dark: bool) -> str:
    c = colors(dark)
    width, height = 920, 178
    left, top, cell, gap = 50, 48, 12, 3
    step = cell + gap
    maximum = max((d["contributionCount"] for d in days), default=1)
    total = sum(d["contributionCount"] for d in days)
    values = {date.fromisoformat(d["date"]): d["contributionCount"] for d in days}
    first = min(values)
    last = max(values)
    sunday = first - timedelta(days=(first.weekday() + 1) % 7)

    rects, labels, seen = [], [], set()
    current, week = sunday, 0
    while current <= last:
        for weekday in range(7):
            day = current + timedelta(days=weekday)
            if day not in values:
                continue
            value = values[day]
            level = 0 if value == 0 else min(4, max(1, math.ceil(value / maximum * 4)))
            fill = c["empty"] if level == 0 else c["levels"][level - 1]
            x, y = left + week * step, top + weekday * step
            rects.append(
                f'<rect x="{x}" y="{y}" width="{cell}" height="{cell}" rx="2" fill="{fill}">'
                f'<title>{escape(day.isoformat())}: {value} contributions</title></rect>'
            )
            key = (day.year, day.month)
            if day.day <= 7 and key not in seen:
                seen.add(key)
                labels.append(
                    f'<text x="{x}" y="35" font-size="11" fill="{c["muted"]}">{day.strftime("%b")}</text>'
                )
        current += timedelta(days=7)
        week += 1

    day_labels = "".join(
        f'<text x="8" y="{top+i*step+10}" font-size="10" fill="{c["muted"]}">{name}</text>'
        for i, name in ((1, "Mon"), (3, "Wed"), (5, "Fri"))
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<rect x=".5" y=".5" width="{width-1}" height="{height-1}" rx="8" fill="{c["bg"]}" stroke="{c["border"]}"/>
<text x="18" y="24" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13" font-weight="600" fill="{c["text"]}">{total:,} contributions in the last year</text>
<g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">{''.join(labels)}{day_labels}{''.join(rects)}</g>
</svg>'''


def line_svg(days: list[dict], dark: bool) -> str:
    c = colors(dark)
    width, height = 920, 260
    left, right, top, bottom = 46, 18, 36, 38
    plot_w, plot_h = width-left-right, height-top-bottom
    values = [d["contributionCount"] for d in days]
    maximum = max(values, default=0)
    y_max = max(4, int(math.ceil(maximum / 4.0) * 4))
    n = max(1, len(values)-1)

    def x_at(i: int) -> float:
        return left + i/n*plot_w

    def y_at(v: int) -> float:
        return top + plot_h - v/y_max*plot_h

    points = " ".join(f"{x_at(i):.2f},{y_at(v):.2f}" for i, v in enumerate(values))
    grid = []
    y_labels = []
    for i in range(5):
        value = round(y_max*i/4)
        y = y_at(value)
        grid.append(f'<line x1="{left}" y1="{y:.2f}" x2="{width-right}" y2="{y:.2f}" stroke="{c["grid"]}"/>')
        y_labels.append(f'<text x="{left-8}" y="{y+4:.2f}" text-anchor="end" font-size="10" fill="{c["muted"]}">{value}</text>')

    ticks = []
    for idx in sorted(set([0, len(days)//4, len(days)//2, 3*len(days)//4, len(days)-1])):
        d = date.fromisoformat(days[idx]["date"])
        ticks.append(f'<text x="{x_at(idx):.2f}" y="{height-13}" text-anchor="middle" font-size="10" fill="{c["muted"]}">{d.strftime("%b %d")}</text>')

    total30 = sum(values[-30:])
    avg30 = total30 / min(30, len(values))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<rect x=".5" y=".5" width="{width-1}" height="{height-1}" rx="8" fill="{c["bg"]}" stroke="{c["border"]}"/>
<text x="18" y="23" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13" font-weight="600" fill="{c["text"]}">Daily contributions</text>
<text x="{width-18}" y="23" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="11" fill="{c["muted"]}">30d total {total30:,} · avg {avg30:.1f}/day</text>
<g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">{''.join(grid)}{''.join(y_labels)}{''.join(ticks)}<polyline points="{points}" fill="none" stroke="{c["line"]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>
</svg>'''


def main() -> int:
    try:
        days = load_days()
        repos = load_repos()
        ASSETS.mkdir(exist_ok=True)
        for dark, suffix in ((False, "light"), (True, "dark")):
            (ASSETS / f"contributions-{suffix}.svg").write_text(heatmap_svg(days, dark))
            (ASSETS / f"daily-contributions-{suffix}.svg").write_text(line_svg(days, dark))
        update_readme(repos)
        print(f"Updated {USERNAME}: {len(days)} days, {len(repos)} repositories")
        return 0
    except Exception as exc:
        print(f"profile generation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
