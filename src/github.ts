/** Minimal GitHub REST client for one file: read and commit GOALS.md through the contents API (fine-grained PAT, contents: read/write). */

export interface GithubConfig {
  token: string;
  repo: string; // owner/name
  branch: string;
  path: string;
}

export interface GithubFile {
  sha: string;
  text: string;
  htmlUrl: string;
}

const API = "https://api.github.com";
const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "yuke-persistent-agent-flow-board"
});

/** UTF-8 text → base64 (the contents API wants base64), in chunks so large files do not blow the call stack. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Current content and blob sha of the file on the branch. */
export async function getFile(cfg: GithubConfig): Promise<GithubFile> {
  const res = await fetch(`${API}/repos/${cfg.repo}/contents/${cfg.path}?ref=${encodeURIComponent(cfg.branch)}`, { headers: headers(cfg.token) });
  if (!res.ok) throw new Error(`GitHub read failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { sha: string; content: string; html_url: string };
  return { sha: body.sha, text: fromBase64(body.content), htmlUrl: body.html_url };
}

/** Commit new content over the blob `sha` we read (GitHub refuses the write with 409 when the file changed meanwhile). */
export async function putFile(cfg: GithubConfig, sha: string, text: string, message: string): Promise<{ commitSha: string; commitUrl: string }> {
  const res = await fetch(`${API}/repos/${cfg.repo}/contents/${cfg.path}`, {
    method: "PUT",
    headers: { ...headers(cfg.token), "content-type": "application/json" },
    body: JSON.stringify({ message, content: toBase64(text), sha, branch: cfg.branch })
  });
  if (res.status === 409 || res.status === 422) throw new Error("conflict: the file changed on GitHub since this page was loaded. Reload it and apply your change again.");
  if (!res.ok) throw new Error(`GitHub write failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { commit: { sha: string; html_url: string } };
  return { commitSha: body.commit.sha, commitUrl: body.commit.html_url };
}

/** Public repos can be read without a token (raw.githubusercontent.com, cached a few minutes, no sha). */
export async function getRawFile(cfg: Omit<GithubConfig, "token">): Promise<string> {
  const res = await fetch(`https://raw.githubusercontent.com/${cfg.repo}/${encodeURIComponent(cfg.branch)}/${cfg.path}`, { headers: { "user-agent": "yuke-persistent-agent-flow-board" } });
  if (!res.ok) throw new Error(`GitHub raw read failed: HTTP ${res.status}`);
  return await res.text();
}
