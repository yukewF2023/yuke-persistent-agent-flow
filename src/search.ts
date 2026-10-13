/**
 * Live search for `listen` tasks, shared by the router (keys, the gateway call) and the Durable Object (caps, the log).
 *
 * A DeepSeek session gets a per-task key at claim time. The key names its claim (task id, attempt, claimed_at) and is
 * signed with SEARCH_KEY_SECRET, so the router rejects a forged key without touching the Durable Object, and the
 * Durable Object accepts a genuine one only while that exact claim is live: a submit, fail, release, expired lease or
 * re-claim changes the task's row, and every key minted for the old claim stops working with no key table to clean up.
 *
 * The searches themselves run in the agent-board app's research gateway (POST <SEARCH_GATEWAY_URL>/<source>), which
 * holds every per-source limit and bills the DeepSpace integrations to the app owner.
 */

/**
 * The sources the gateway serves. `est` is what one call is expected to cost (booked against the budget before the
 * call), `worst` what it may cost when the outcome is unknown (the api-worker's reservation, marked up). USD.
 */
export const SEARCH_SOURCES: Record<string, { est: number; worst: number }> = {
  x: { est: 0.004, worst: 0.0078 },
  "x-thread": { est: 0.006, worst: 0.0195 },
  "x-replies": { est: 0.006, worst: 0.0195 },
  reddit: { est: 0.02, worst: 0.65 },
  web: { est: 0.02, worst: 0.65 },
  news: { est: 0.02, worst: 0.65 },
  linkedin: { est: 0.0325, worst: 0.0325 },
  review: { est: 0.03, worst: 0.65 },
  hn: { est: 0, worst: 0 },
  "hn-thread": { est: 0, worst: 0 },
  forum: { est: 0, worst: 0 },
  "forum-topic": { est: 0, worst: 0 }
};

/** Calls one attempt may make (a retry starts from the previous attempt's files and needs fewer), and what it may spend. */
export const SEARCH_CALLS_FIRST_ATTEMPT = 25;
export const SEARCH_CALLS_RETRY = 10;
export const SEARCH_ATTEMPT_MAX_USD = 0.15;
export const DEFAULT_SEARCH_USD_PER_DAY = 1;

export type SearchClaim = { taskId: number; attempt: number; claimedAt: number };

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, claim: SearchClaim): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`search:${claim.taskId}.${claim.attempt}.${claim.claimedAt}`)));
}

/** The key handed to the session: `<task id>.<attempt>.<claimed_at>.<signature>`. */
export async function searchKey(secret: string, claim: SearchClaim): Promise<string> {
  return `${claim.taskId}.${claim.attempt}.${claim.claimedAt}.${await sign(secret, claim)}`;
}

/** The claim a key names, when its signature is genuine; null otherwise. Says nothing about whether the claim is still live. */
export async function verifySearchKey(secret: string, key: string): Promise<SearchClaim | null> {
  const m = /^(\d{1,9})\.(\d{1,3})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(key);
  if (!m) return null;
  const claim = { taskId: Number(m[1]), attempt: Number(m[2]), claimedAt: Number(m[3]) };
  const expected = await sign(secret, claim);
  let diff = expected.length ^ m[4].length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[4].charCodeAt(i);
  return diff === 0 ? claim : null;
}
