interface Env {
  GITHUB_TOKEN: string;
  MANUAL_TRIGGER_TOKEN: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

type Repo = {
  name: string;
  url: string;
  description: string | null;
  pushedAt: string;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  stargazerCount: number;
  primaryLanguage: { name: string } | null;
};

const GRAPHQL_URL = "https://api.github.com/graphql";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/update" && request.method === "POST") {
      if (!env.MANUAL_TRIGGER_TOKEN) {
        return new Response("MANUAL_TRIGGER_TOKEN secret is not configured.\n", { status: 500 });
      }
      const authorization = request.headers.get("Authorization");
      if (authorization !== `Bearer ${env.MANUAL_TRIGGER_TOKEN}`) {
        return new Response("Unauthorized\n", { status: 401 });
      }

      try {
        await updateProfile(env);
        return new Response("Profile updated.\n");
      } catch (error) {
        console.error("Manual profile update failed", error);
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`Profile update failed: ${message}\n`, { status: 500 });
      }
    }

    return new Response("MRsoymilk profile updater is running. Updates are executed by Cron Trigger.\n");
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(updateProfile(env));
  },
};

async function updateProfile(env: Env): Promise<void> {
  const owner = env.GITHUB_OWNER || "MRsoymilk";
  const repo = env.GITHUB_REPO || "MRsoymilk";
  const branch = env.GITHUB_BRANCH || "main";
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is required");

  const today = utcDate(new Date());
  const start = addDays(today, -364);

  const [dailyCommits, repos, currentReadme] = await Promise.all([
    loadDailyCommits(env.GITHUB_TOKEN, owner, start, today),
    loadRecentRepos(env.GITHUB_TOKEN, owner),
    getFileText(env.GITHUB_TOKEN, owner, repo, "README.md", branch),
  ]);
  const commitDays = dateRange(start, today).map((date) => ({
    date,
    commitCount: dailyCommits.get(date) || 0,
  }));

  const files: Record<string, string> = {
    "README.md": updateReadmeProjects(currentReadme, repos),
    "assets/daily-contributions-light.svg": lineSvg(commitDays, false),
    "assets/daily-contributions-dark.svg": lineSvg(commitDays, true),
  };

  await commitFiles(env.GITHUB_TOKEN, owner, repo, branch, files);
}

async function githubGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "MRsoymilk-profile-worker",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as { data?: T; errors?: unknown };
  if (payload.errors || !payload.data) throw new Error(`GitHub GraphQL error: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

async function githubRest<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "MRsoymilk-profile-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub REST HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function loadDailyCommits(token: string, login: string, from: string, to: string): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const [rangeStart, rangeEnd] of splitDateRange(from, to, 92)) {
    const query = `
      query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            commitContributionsByRepository(maxRepositories: 100) {
              contributions(
                first: 100
                orderBy: {field: OCCURRED_AT, direction: ASC}
              ) {
                nodes { occurredAt commitCount }
              }
            }
          }
        }
      }
    `;
    type Data = {
      user: {
        contributionsCollection: {
          commitContributionsByRepository: Array<{
            contributions: {
              nodes: Array<{ occurredAt: string; commitCount: number }>;
            };
          }>;
        };
      } | null;
    };
    const data = await githubGraphql<Data>(token, query, {
      login,
      from: `${rangeStart}T00:00:00Z`,
      to: `${rangeEnd}T23:59:59Z`,
    });
    if (!data.user) throw new Error(`GitHub user not found: ${login}`);
    for (const group of data.user.contributionsCollection.commitContributionsByRepository) {
      for (const node of group.contributions.nodes) {
        const day = node.occurredAt.slice(0, 10);
        totals.set(day, (totals.get(day) || 0) + node.commitCount);
      }
    }
  }
  return totals;
}

async function loadRecentRepos(token: string, login: string): Promise<Repo[]> {
  const query = `
    query($login: String!) {
      user(login: $login) {
        repositories(first: 50, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes {
            name
            url
            description
            pushedAt
            isArchived
            isFork
            isPrivate
            stargazerCount
            primaryLanguage { name }
          }
        }
      }
    }
  `;
  type Data = { user: { repositories: { nodes: Repo[] } } | null };
  const data = await githubGraphql<Data>(token, query, { login });
  if (!data.user) throw new Error(`GitHub user not found: ${login}`);
  return data.user.repositories.nodes
    .filter((repo) => !repo.isPrivate && !repo.isArchived && !repo.isFork && repo.name !== login)
    .slice(0, 10);
}

function updateReadmeProjects(readme: string, repos: Repo[]): string {
  const rows = repos.map((repo, index) => {
    const lang = repo.primaryLanguage?.name || "—";
    const stars = repo.stargazerCount ? ` · ★ ${repo.stargazerCount}` : "";
    const desc = repo.description ? ` — ${repo.description.replace(/\s+/g, " ").trim()}` : "";
    return `${String(index + 1).padStart(2, "0")}. **[${repo.name}](${repo.url})** · ${lang}${stars} · updated ${relativeTime(repo.pushedAt)}${desc}`;
  });
  const replacement = `<!-- RECENT_PROJECTS:START -->\n${rows.length ? rows.join("\n") : "_No public repositories found._"}\n<!-- RECENT_PROJECTS:END -->`;
  const pattern = /<!-- RECENT_PROJECTS:START -->[\s\S]*?<!-- RECENT_PROJECTS:END -->/;
  if (!pattern.test(readme)) throw new Error("README project markers are missing");
  return readme.replace(pattern, replacement);
}

function palette(dark: boolean) {
  return dark
    ? { bg: "#0d1117", border: "#30363d", text: "#f0f6fc", muted: "#8b949e", grid: "#21262d", line: "#39d353", empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"] }
    : { bg: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#656d76", grid: "#d8dee4", line: "#1a7f37", empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"] };
}

function lineSvg(days: Array<{ date: string; commitCount: number }>, dark: boolean): string {
  const c = palette(dark);
  const width = 920, height = 260, left = 46, right = 18, top = 36, bottom = 38;
  const plotW = width - left - right, plotH = height - top - bottom;
  const values = days.map((d) => d.commitCount);
  const maximum = Math.max(0, ...values);
  const yMax = Math.max(4, Math.ceil(maximum / 4) * 4);
  const n = Math.max(1, values.length - 1);
  const xAt = (i: number) => left + (i / n) * plotW;
  const yAt = (v: number) => top + plotH - (v / yMax) * plotH;
  const points = values.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");

  const grid: string[] = [];
  const yLabels: string[] = [];
  for (let i = 0; i < 5; i++) {
    const value = Math.round((yMax * i) / 4);
    const y = yAt(value);
    grid.push(`<line x1="${left}" y1="${y.toFixed(2)}" x2="${width - right}" y2="${y.toFixed(2)}" stroke="${c.grid}"/>`);
    yLabels.push(`<text x="${left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-size="10" fill="${c.muted}">${value}</text>`);
  }

  const indices = [...new Set([0, Math.floor(days.length / 4), Math.floor(days.length / 2), Math.floor((3 * days.length) / 4), days.length - 1])];
  const ticks = indices.map((idx) => {
    const d = parseDate(days[idx].date);
    return `<text x="${xAt(idx).toFixed(2)}" y="${height - 13}" text-anchor="middle" font-size="10" fill="${c.muted}">${monthName(d)} ${String(d.getUTCDate()).padStart(2, "0")}</text>`;
  });

  const total30 = values.slice(-30).reduce((a, b) => a + b, 0);
  const avg30 = total30 / Math.min(30, values.length);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="8" fill="${c.bg}" stroke="${c.border}"/>
<text x="18" y="23" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13" font-weight="600" fill="${c.text}">Daily commits</text>
<text x="${width - 18}" y="23" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="11" fill="${c.muted}">30d total ${total30.toLocaleString()} · avg ${avg30.toFixed(1)}/day</text>
<g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">${grid.join("")}${yLabels.join("")}${ticks.join("")}<polyline points="${points}" fill="none" stroke="${c.line}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>
</svg>`;
}

async function getFileText(token: string, owner: string, repo: string, path: string, branch: string): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const data = await githubRest<{ content: string; encoding: string }>(token, url);
  if (data.encoding !== "base64") throw new Error(`Unsupported GitHub content encoding: ${data.encoding}`);
  return decodeBase64(data.content.replace(/\n/g, ""));
}

async function commitFiles(token: string, owner: string, repo: string, branch: string, files: Record<string, string>): Promise<void> {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const ref = await githubRest<{ object: { sha: string } }>(token, `${api}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object.sha;
  const commit = await githubRest<{ tree: { sha: string } }>(token, `${api}/git/commits/${headSha}`);

  const tree = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const blob = await githubRest<{ sha: string }>(token, `${api}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content, encoding: "utf-8" }),
    });
    return { path, mode: "100644", type: "blob", sha: blob.sha };
  }));

  const newTree = await githubRest<{ sha: string }>(token, `${api}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
  });
  const newCommit = await githubRest<{ sha: string }>(token, `${api}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: "chore(profile): update activity stats",
      tree: newTree.sha,
      parents: [headSha],
    }),
  });
  await githubRest(token, `${api}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
}

function dateRange(from: string, to: string): string[] {
  const result: string[] = [];
  let current = parseDate(from);
  const end = parseDate(to);
  while (current <= end) {
    result.push(utcDate(current));
    current = addDaysObj(current, 1);
  }
  return result;
}

function splitDateRange(from: string, to: string, chunkDays: number): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  let current = parseDate(from);
  const end = parseDate(to);
  while (current <= end) {
    const chunkEnd = addDaysObj(current, chunkDays - 1);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    result.push([utcDate(current), utcDate(actualEnd)]);
    current = addDaysObj(actualEnd, 1);
  }
  return result;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo ago`;
  return `${Math.floor(seconds / 31536000)}y ago`;
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value: string, amount: number): string {
  return utcDate(addDaysObj(parseDate(value), amount));
}

function addDaysObj(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function monthName(value: Date): string {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][value.getUTCMonth()];
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
