/**
 * The desktop EXE's self-update release channel — resolved automatically.
 *
 * The channel IS the GitHub release: `.github/workflows/build-client.yml`
 * attaches `HOMESC.SAVE.STUDIO.exe` (the single-file client) plus its
 * `.sha256` to every `v*` tag. An
 * operator should never have to paste a URL and a checksum into Render after
 * each build, so the server reads the channel directly instead:
 *
 *   GET https://github.com/<repo>/releases/latest/download/<asset>.sha256
 *
 * GitHub answers that stable URL with a redirect into the latest release's own
 * asset, so the *final* URL reveals the tag and the body is the checksum —
 * one request, no API token, and none of the unauthenticated API's 60/hour
 * rate limit. The download URL is then taken from that same final URL (tag
 * pinned), so the bytes the installer fetches are exactly the bytes the
 * checksum describes, even if a newer release lands mid-flight.
 *
 * Precedence in `/api/update`:
 *   1. a runtime publish (Owner Hub → Publish update) — deliberate override;
 *   2. this module — the default, zero maintenance;
 *   3. `CLIENT_UPDATE_*` env vars — offline fallback when GitHub is
 *      unreachable, so a pinned/air-gapped deploy still works.
 */

/** What `/api/update` hands to the EXE's installer. */
export interface ReleaseRecord {
  version: string;
  downloadUrl: string;
  sha256: string;
  notes: string;
  publishedAt: number;
}

/** Asset names build-client.yml attaches to every release. */
export const UPDATE_ASSET = "HOMESC.SAVE.STUDIO.exe";
export const UPDATE_CHECKSUM_ASSET = `${UPDATE_ASSET}.sha256`;

/** The release channel this project publishes to. */
export const DEFAULT_UPDATE_REPO = "Aditya4650-am/AM-HOMESC-";

/** How long a successful resolve is served without re-checking GitHub. */
const CACHE_TTL_MS = 5 * 60_000;

/** First 64-hex token of a `.sha256` body (`<hash>  <file>`, coreutils form). */
function firstSha(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0] ?? "";
    if (/^[0-9a-f]{64}$/i.test(token)) return token.toLowerCase();
  }
  return "";
}

/**
 * Turn the answered URL of `releases/latest/download/<asset>.sha256` plus its
 * body into a release record.
 *
 * Returns null when the URL never resolved to a tag-pinned asset, or when the
 * body carries no usable checksum. Publishing a download without a checksum
 * would let the installer swap itself on unverified bytes, so "no checksum"
 * must mean "no update offered" — the caller then falls back or serves an
 * empty downloadUrl, and the UI skips the install.
 *
 * Pure by construction: URL + body in, record out — unit-tested with no
 * network.
 */
export function parseLatestChecksum(
  repo: string,
  finalUrl: string,
  body: string,
): ReleaseRecord | null {
  const sha = firstSha(body);
  if (!sha) return null;

  // `.../releases/download/<tag>/<asset>.sha256` — the tag GitHub redirected
  // to is the release's real name; strip the checksum suffix to pin the zip
  // to that same release.
  const pinned = /\/releases\/download\/([^/]+)\/[^/]+\.sha256(?:[?#].*)?$/.exec(finalUrl);
  if (!pinned) return null;
  const tag = decodeURIComponent(pinned[1]!);
  const version = tag.replace(/^v/i, "");
  if (!version || !/^\d/.test(version)) return null;

  const downloadUrl = finalUrl.replace(/\.sha256(?:[?#].*)?$/, "");
  if (!downloadUrl.endsWith(`/${UPDATE_ASSET}`)) return null;

  return { version, downloadUrl, sha256: sha, notes: "", publishedAt: Date.now() };
}

let cached: { at: number; record: ReleaseRecord } | null = null;
let inflight: Promise<ReleaseRecord | null> | null = null;

/** Drop the cache (tests, or an Owner Hub publish that should take effect now). */
export function resetReleaseCache(): void {
  cached = null;
}

/**
 * Resolve the latest published release, or null when the channel is empty /
 * unreachable. Concurrent callers share one request; failures serve the last
 * good record when there is one (a flaky GitHub must not unpublish an update
 * that clients have not picked up yet).
 */
export async function fetchLatestRelease(
  repo: string = DEFAULT_UPDATE_REPO,
): Promise<ReleaseRecord | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.record;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const probe = `https://github.com/${repo}/releases/latest/download/${UPDATE_CHECKSUM_ASSET}`;
      // Step 1: the stable URL 302s into the latest release's own asset, and
      // that *first* Location is the only place the tag is visible without
      // the rate-limited API. Following redirects instead would end on
      // release-assets.githubusercontent.com, where the tag is gone.
      const first = await fetch(probe, {
        redirect: "manual",
        headers: { "user-agent": "homescapes-save-studio" },
        signal: AbortSignal.timeout(15_000),
      });
      const location = first.headers.get("location");
      if (first.status < 300 || first.status >= 400 || !location) {
        return cached?.record ?? null;
      }
      const pinnedUrl = new URL(location, probe).toString();

      // Step 2: read the checksum from the tag-pinned URL (its own redirects
      // are followed normally — only the body matters now).
      const res = await fetch(pinnedUrl, {
        headers: { "user-agent": "homescapes-save-studio" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return cached?.record ?? null;
      const record = parseLatestChecksum(repo, pinnedUrl, await res.text());
      if (!record) return cached?.record ?? null;
      cached = { at: Date.now(), record };
      return record;
    } catch {
      // DNS/TLS/timeout — keep serving the previous record if we have one.
      return cached?.record ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
