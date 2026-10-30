/**
 * Homescapes Save Studio — local API server.
 *
 * Zero runtime dependencies: `node:http` plus the engine. Runs either as the
 * backend for the Vite dev server or as the single process that also serves
 * the built UI (which is what the desktop shell points WebView2 at).
 *
 * The server OWNS every save algorithm. The Python client only moves bytes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, extname, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  COSMETICS,
  SaveError,
  describeContainer,
  equipManyOps,
  grantOps,
  openSave,
  planGrants,
  planSeasonPass,
  readAlbum,
  scanSpans,
  CARD_COUNT,
  SET_COUNT,
  STOCK_CAP,
  BATCH_MAX,
  type CosmeticKind,
  type EditOp,
} from "../engine/index.ts";
import { MAX_GP } from "../engine/MAX_GP.ts";
import {
  activate as licenseActivate,
  issue as licenseIssue,
  licenseRequired,
  LicenseError,
  requireLicense,
  resetDevices as licenseResetDevices,
  setActive as licenseSetActive,
  snapshot as licenseSnapshot,
  storageKind as licenseStorageKind,
  store as licenseStore,
} from "./license.ts";
import { asciiTokens, decodeBlkZstd, scanVsoDir, uniqueTokens } from "../engine/upk.ts";
import {
  SessionError,
  createSession,
  listSessions,
  resolveSession,
  type SaveSession,
} from "./session.ts";
import {
  CONTENT_ROOTS,
  assertContentRoots,
} from "./cloneGuard.ts";

const execFileAsync = promisify(execFile);

const ROOT = resolvePath(fileURLToPath(new URL("../../", import.meta.url)));
const DIST = join(ROOT, "dist");
/**
 * The one account the clone feature reads, shipped with the tool.
 *
 * `path` is optional on `/api/clone-content` precisely so the client cannot
 * send some other file: the source of a clone is this save and nothing else.
 * Resolved against ROOT rather than the working directory so the built-in
 * account is found no matter where the server was started from.
 */
const IGG_SOURCE = join(ROOT, "data", "IGG-account.db");
const PYTHON = process.env.HC_PYTHON ?? "python";
const CLIENT = join(ROOT, "client", "hc_client.py");
const PORT = Number(process.env.PORT ?? process.env.HC_PORT ?? 8787);
/**
 * Bind address. Render (and most PaaS) inject `PORT` and require listening on
 * `0.0.0.0`; a local run keeps the loopback default so the tool is not exposed
 * on the LAN by accident. `HOST` overrides either.
 */
const HOST = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const MAX_BODY = 96 * 1024 * 1024; // base64 inflates by ~4/3

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// ------------------------------------------------------------------ helpers --

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof LicenseError) {
    sendJson(res, err.status, { ok: false, error: err.message, licenseRequired: true });
    return;
  }
  if (err instanceof SessionError) {
    sendJson(res, err.status, { ok: false, error: err.message });
    return;
  }
  if (err instanceof SaveError) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { ok: false, error: message });
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new SessionError("request body too large", 413);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new SessionError("request body is not valid JSON", 400);
  }
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function bytesToB64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/** Run the Python ADB bridge and parse its single-line JSON reply. */
async function callBridge(args: string[], timeoutMs = 180_000): Promise<any> {
  try {
    const { stdout } = await execFileAsync(PYTHON, [CLIENT, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 96 * 1024 * 1024,
      encoding: "buffer",
    });
    const text = stdout.toString("utf8").trim();
    if (!text) return { ok: false, error: "bridge produced no output" };
    // The bridge emits exactly one JSON object; take the last non-empty line
    // so stray interpreter warnings cannot break parsing.
    const line = text.split(/\r?\n/).filter(Boolean).pop() ?? "";
    return JSON.parse(line);
  } catch (err: any) {
    if (err?.stdout) {
      const text = Buffer.from(err.stdout).toString("utf8").trim();
      const line = text.split(/\r?\n/).filter(Boolean).pop();
      if (line) {
        try {
          return JSON.parse(line);
        } catch {
          /* fall through */
        }
      }
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ------------------------------------------------------------- static files --

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Refuse traversal: normalize, then re-anchor under DIST.
  const normalized = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const full = resolvePath(join(DIST, normalized));
  if (!full.startsWith(DIST)) {
    sendJson(res, 400, { ok: false, error: "bad path" });
    return true;
  }
  try {
    const info = await stat(full);
    const target = info.isDirectory() ? join(full, "index.html") : full;
    const data = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-cache",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ routes --

interface ApplyBody {
  sessionId?: string;
  ops: EditOp[];
  refreshIntegrity?: boolean;
}

interface LoadBody {
  name?: string;
  b64?: string;
  path?: string;
}

interface CosmeticsBody {
  sessionId?: string;
  /** Ids to grant per group; missing groups are skipped. */
  grant?: Partial<Record<CosmeticKind, string[]>>;
  /** One id per group to equip; materializes fresh ProfileData safely. */
  equip?: Partial<Record<CosmeticKind, string>>;
  refreshIntegrity?: boolean;
}

interface CardsGrantBody {
  sessionId?: string;
  /** Card numbers 1..150 to grant, exactly like the grid's ticked buttons. */
  cards?: number[];
  /** Copies per card; clamped in-engine to STOCK_CAP (the event's own cap). */
  copies?: number;
  refreshIntegrity?: boolean;
}

interface OwnerBody {
  passcode?: string;
  action?: "issue" | "list" | "revoke" | "restore" | "reset-devices";
  plan?: "trial" | "week" | "month" | "year" | "lifetime";
  days?: number;
  devices?: number;
  count?: number;
  note?: string;
  key?: string;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/health") {
    sendJson(res, 200, { ok: true, app: "Homescapes Save Studio", version: "0.1.0" });
    return;
  }

  /* ---------------------------------------------------------- license --
   * The login. `/api/health` and everything under `/api/license/*` stay open so
   * the lock screen can be served and keys can be activated; every other API
   * route is gated when `HS_MASTER` is configured.
   */
  if (route === "GET /api/license/status") {
    sendJson(res, 200, {
      ok: true,
      required: licenseRequired(),
      storage: licenseStorageKind(),
      ownerConfigured: Boolean(process.env.HS_OWNER?.trim()),
    });
    return;
  }

  if (route === "POST /api/license/activate") {
    const body = await readJson<{ key?: string; deviceId?: string }>(req);
    const { token, snap } = await licenseActivate(body.key ?? "", body.deviceId ?? "");
    sendJson(res, 200, { ok: true, token, license: snap });
    return;
  }

  if (route === "POST /api/license/owner") {
    // The owner passcode IS the credential here — an owner must be able to
    // issue the very first key, before any token exists.
    const body = await readJson<OwnerBody>(req);
    const passcode = String(body.passcode ?? "");
    if (!process.env.HS_OWNER?.trim()) throw new SessionError("HS_OWNER is not configured on this server", 503);
    if (passcode !== process.env.HS_OWNER.trim()) throw new SessionError("Wrong owner passcode", 401);
    if (body.action === "issue") {
      const issued = await licenseIssue(body);
      sendJson(res, 200, { ok: true, issued });
      return;
    }
    if (body.action === "list") {
      const rows = await licenseStore.all();
      sendJson(res, 200, { ok: true, rows: rows.map((r) => ({ ...r, fp: r.fp.slice(0, 12), snap: licenseSnapshot(r) })) });
      return;
    }
    if (body.action === "revoke" || body.action === "restore") {
      const done = await licenseSetActive(body.key ?? "", body.action === "restore");
      sendJson(res, done ? 200 : 404, { ok: done, error: done ? undefined : "no such key" });
      return;
    }
    if (body.action === "reset-devices") {
      const done = await licenseResetDevices(body.key ?? "");
      sendJson(res, done ? 200 : 404, { ok: done, error: done ? undefined : "no such key" });
      return;
    }
    throw new SessionError("`action` must be issue | list | revoke | restore | reset-devices", 400);
  }

  // Everything below this line edits a save, so it needs a valid token.
  requireLicense(req);

  if (route === "GET /api/sessions") {
    sendJson(res, 200, { ok: true, sessions: listSessions() });
    return;
  }

  if (route === "POST /api/session/load") {
    const body = await readJson<LoadBody>(req);
    let bytes: Uint8Array;
    let name: string;
    if (body.b64) {
      bytes = b64ToBytes(body.b64);
      name = body.name ?? "device save";
    } else if (body.path) {
      const full = resolvePath(body.path);
      bytes = new Uint8Array(await readFile(full));
      name = body.name ?? full.split(/[\\/]/).pop() ?? "save";
    } else {
      throw new SessionError("provide either `b64` or `path`", 400);
    }
    const session = createSession(name, bytes);
    sendJson(res, 200, { ok: true, overview: session.overview() });
    return;
  }

  if (route === "GET /api/overview") {
    sendJson(res, 200, { ok: true, overview: resolveSession(url.searchParams.get("sessionId") ?? undefined).overview() });
    return;
  }

  if (route === "GET /api/values") {
    sendJson(res, 200, { ok: true, values: resolveSession(url.searchParams.get("sessionId") ?? undefined).values() });
    return;
  }

  if (route === "GET /api/discover") {
    const session = resolveSession(url.searchParams.get("sessionId") ?? undefined);
    const prefix = url.searchParams.get("prefix") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 2000);
    const q = url.searchParams.get("q") ?? "";
    sendJson(res, 200, { ok: true, prefix, fields: session.discover(prefix, limit, q) });
    return;
  }

  if (route === "GET /api/field") {
    const session = resolveSession(url.searchParams.get("sessionId") ?? undefined);
    const path = url.searchParams.get("path") ?? "";
    const save = openSave(session.plain);
    if (!save.has(path)) throw new SessionError(`no such field: ${path}`, 404);
    sendJson(res, 200, { ok: true, field: save.field(path) });
    return;
  }

  if (route === "POST /api/apply") {
    const body = await readJson<ApplyBody>(req);
    if (!Array.isArray(body.ops)) throw new SessionError("`ops` must be an array", 400);
    const session = resolveSession(body.sessionId);
    const result = session.apply(body.ops, { refreshIntegrity: body.refreshIntegrity ?? true });
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      summary: result.summary,
      integrity: result.integrity,
      warnings: result.warnings,
      errors: result.errors,
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      overview: result.ok ? session.overview() : undefined,
    });
    return;
  }

  /* -------------------------------------------------- clone-content --
   * The "complete home" primitive, and the only clone that survives the
   * server's anti-cheat.
   *
   * The APK (9.2.101) shows Playrix scores an account's *progress* server-side
   * (`AntiCheat.Server.ScoreValidation` → `SetPause` → the "suspicious
   * activity" window) against that account's own history. Transplanting a
   * whole save therefore always loses — measured three ways on 2026-10-17.
   * What the save may carry is *content*: the home, the décor, the characters.
   *
   * So this route copies a whitelist of content roots from the source save
   * onto the live account and refuses any progression root outright. The
   * account keeps its own level, balances, statistics, quests, events and
   * secret values; it gains the donor's house. Nothing is pushed here — the
   * result stays staged until the operator presses Push.
   *
   * The source is the built-in IGG account (`data/IGG-account.db`). `path` is
   * accepted but ignored unless it is omitted — it stays optional only so an
   * offline proof can point at a fixture file; the shipped UI never sends it.
   */
  if (route === "POST /api/clone-content") {
    const body = await readJson<{
      path?: string;
      serial: string;
      roots?: string[];
      limit?: number;
    }>(req);
    if (!body.serial) {
      throw new SessionError("`serial` is required", 400);
    }
    const srcPath = body.path ? resolvePath(body.path) : IGG_SOURCE;
    let srcBytes: Uint8Array;
    try {
      srcBytes = new Uint8Array(await readFile(srcPath));
    } catch {
      throw new SessionError(
        `the built-in clone account is missing: ${srcPath}`,
        400,
      );
    }
    const roots = body.roots && body.roots.length ? body.roots : [...CONTENT_ROOTS];
    try {
      assertContentRoots(roots);
    } catch (err) {
      throw new SessionError((err as Error).message, 400);
    }

    const source = createSession("content-source", srcBytes);

    const reply = await callBridge(["pull", "--serial", body.serial]);
    if (!(reply.ok && reply.b64)) {
      sendJson(res, 400, reply);
      return;
    }
    const target = createSession(`device:${body.serial}`, b64ToBytes(reply.b64));

    const ops: EditOp[] = [];
    const perRoot: Array<{ root: string; fields: number; mode: string; skipped: number }> = [];
    const targetSave = openSave(target.plain);
    const donorSave = openSave(source.plain);

    const tMember = (p: string) => targetSave.index.members.get(p) ?? null;
    const dMember = (p: string) => donorSave.index.members.get(p) ?? null;

    /**
     * A donor value as a REAL JSON value.
     *
     * `field().value` deliberately returns the raw TEXT for containers (that is
     * what the field viewer wants to show). Handing that text to `set`/`create`
     * re-encodes it as a JSON *string*, so every whole-root transplant silently
     * landed as `"Avatars": "{...}"` — a string the game then ignores or wipes.
     * Rebuild the value from the donor's member index instead: literal dotted
     * keys stay literal, and `{"t":...,"v":...}` wrappers are preserved.
     */
    const dValue = (p: string): EditOp["value"] => {
      const m = donorSave.index.members.get(p);
      if (!m) throw new SessionError(`donor is missing ${p}`, 500);
      if (m.type === "object") {
        const out: Record<string, unknown> = {};
        for (const ch of donorSave.children(p)) out[ch.slice(p.length + 1)] = dValue(ch);
        return out as EditOp["value"];
      }
      if (m.type === "array") {
        return donorSave.children(p).map((ch) => dValue(ch)) as EditOp["value"];
      }
      return donorSave.field(p).value as EditOp["value"];
    };
    /** JSON kind of a value, and of a target member, for set()-compatibility. */
    const kindOf = (v: EditOp["value"]): string =>
      v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;
    const memberKind = (m: { type: string }): string =>
      m.type === "true" || m.type === "false" ? "boolean" : m.type;

    /**
     * Transplant the donor's content **as whole subtrees**, never leaf by leaf.
     *
     * The engine's `create()` names a member by the REMAINDER of a dotted path,
     * so leaf-merging a deep donor field like
     * `PhotoAlbums.X.v.multyWindowData[0].v.…` into a target whose chain stops
     * at a null leaf writes a literal key named
     * `"v.multyWindowData[0].v.…"` — thousands of them (measured: 3871 bogus
     * keys, which the game then re-serialized into a malformed entry).
     *
     * So: walk the donor's leaves; at the shallowest point where the target
     * cannot continue the chain, splice the donor's coherent subtree in ONE
     * `set`/`create`. Containers the target already owns are never replaced —
     * the walk descends into them instead.
     */
    for (const root of roots) {
      if (!dMember(root)) {
        perRoot.push({ root, fields: 0, mode: "absent-in-donor", skipped: 0 });
        continue;
      }

      const leaves = donorSave.paths().filter((p) => p.startsWith(`${root}.`));
      const tRoot = tMember(root);
      const dRoot = dMember(root)!;

      // A root is taken whole only when the target holds nothing there (absent,
      // or the game's bare `null`). A container the target already owns is
      // never replaced — the walk descends into it instead.
      if (tRoot && tRoot.type !== "null") {
        if (tRoot.type !== "object" || dRoot.type !== "object") {
          perRoot.push({ root, fields: 0, mode: "kept-target", skipped: leaves.length });
          continue;
        }
      } else {
        ops.push(
          tRoot
            ? { path: root, value: dValue(root) }
            : { path: root, value: dValue(root), create: true },
        );
        perRoot.push({ root, fields: leaves.length, mode: "whole-root", skipped: 0 });
        continue;
      }

      // Both sides hold the root as an object: descend and splice subtrees.
      const covered = new Set<string>();
      let fields = 0;
      let skipped = 0;
      let spliced = 0;

      for (const p of leaves) {
        // Walk the donor's OWN parent links, root -> leaf. Playrix stores many
        // members under literal dotted keys (`"2FloorBarrel.step"`), so a naive
        // split on "." invents intermediate paths that are not real members and
        // `field()` throws on them.
        const chain: string[] = [];
        let up = p;
        while (up && up !== root) {
          chain.unshift(up);
          const m = donorSave.index.members.get(up);
          if (!m) break;
          up = m.parent;
        }
        if (chain.some((c) => covered.has(c))) continue;

        let prefix = root;
        for (let i = 0; i < chain.length; i++) {
          const c = chain[i]!;
          const tm = tMember(c);
          const last = i === chain.length - 1;

          if (!last && tm && tm.type === "object") {
            prefix = c;
            continue;
          }

          // Splice point. Writable only when the target holds a null there, is
          // absent (so `create` can hang the member off `prefix`), or holds a
          // leaf of the same JSON kind the donor writes.
          if (tm && (tm.type === "object" || tm.type === "array")) {
            skipped++;
            break;
          }
          const name = prefix ? c.slice(prefix.length + 1) : c;
          if (!tm && (name.includes("[") || name.includes("]"))) {
            skipped++;
            break;
          }
          let dv: EditOp["value"];
          try {
            dv = dValue(c);
          } catch {
            skipped++;
            break;
          }
          if (tm && memberKind(tm) !== "null" && memberKind(tm) !== kindOf(dv)) {
            skipped++;
            break;
          }
          ops.push(tm ? { path: c, value: dv } : { path: c, value: dv, create: true });
          covered.add(c);
          fields++;
          spliced++;
          break;
        }
      }

      perRoot.push({ root, fields, mode: spliced > 0 ? "splice" : "leaves", skipped });
    }
    if (ops.length === 0) {
      throw new SessionError(`no content fields found in ${body.path}`, 400);
    }
    // Shallow paths first so a parent splice lands before anything nested.
    ops.sort((a, b) => (a.path.match(/\./g)?.length ?? 0) - (b.path.match(/\./g)?.length ?? 0));

    // `runApply` discards the WHOLE batch on the first refusal, so a single
    // incompatible splice would cost the entire clone. Retry by dropping only
    // the ops the engine named. Those drops are recorded: a "whole-root" line
    // must never overstate what actually landed in the save.
    const pushed = ops.length;
    const droppedPaths: string[] = [];
    let result = target.apply(ops, { refreshIntegrity: true });
    for (let attempt = 0; attempt < 6 && !result.ok; attempt++) {
      const bad = new Set<string>();
      for (const e of result.errors) {
        for (const op of ops) if (e.includes(op.path)) bad.add(op.path);
      }
      if (bad.size === 0) break;
      for (let i = ops.length - 1; i >= 0; i--) {
        if (bad.has(ops[i]!.path)) {
          droppedPaths.push(ops[i]!.path);
          ops.splice(i, 1);
        }
      }
      if (ops.length === 0) break;
      result = target.apply(ops, { refreshIntegrity: true });
    }

    // Report the ops that actually landed, per root.
    const appliedByRoot = new Map<string, number>();
    for (const op of ops) {
      const dot = op.path.indexOf(".");
      const top = dot < 0 ? op.path : op.path.slice(0, dot);
      appliedByRoot.set(top, (appliedByRoot.get(top) ?? 0) + 1);
    }
    for (const r of perRoot) r.fields = appliedByRoot.get(r.root) ?? 0;

    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      source: srcPath,
      serial: body.serial,
      roots: perRoot,
      fields: ops.length,
      pushed,
      dropped: droppedPaths.length,
      droppedPaths: droppedPaths.slice(0, 40),
      summary: result.summary.slice(0, 40),
      warnings: result.warnings.slice(0, 40),
      warningsTotal: result.warnings.length,
      errors: result.errors.slice(0, 40),
      errorsTotal: result.errors.length,
      overview: result.ok ? target.overview() : undefined,
    });
    return;
  }

  /* --------------------------------------------------- clone/source --
   * Reports the one account the clone feature reads. The panel shows it so an
   * operator can see exactly which file is about to land on their device, and
   * so a missing or moved save surfaces as a clear message rather than a
   * clone that fails partway through.
   */
  if (route === "GET /api/clone/source") {
    let exists = false;
    let bytes = 0;
    try {
      const st = await stat(IGG_SOURCE);
      exists = st.isFile();
      bytes = st.size;
    } catch {
      exists = false;
    }
    sendJson(res, 200, { ok: true, path: IGG_SOURCE, exists, bytes });
    return;
  }

  // Preview and apply MAX_GP to the requested session; pushing stays explicit.
  if (route === "GET /api/seasonpass/max-gp" || route === "POST /api/seasonpass/max-gp") {
    const body = req.method === "POST" ? await readJson<{ sessionId?: string }>(req) : null;
    const sessionId = body?.sessionId ?? url.searchParams.get("sessionId");
    if (!sessionId) throw new SessionError("`sessionId` is required", 400);
    const session = resolveSession(sessionId);
    let plan;
    try {
      plan = MAX_GP(session.plain);
    } catch (error) {
      throw new SessionError(error instanceof Error ? error.message : String(error), 400);
    }
    const detail = {
      season: plan.season, source: plan.source, points: 10000, prevAmount: 9999,
      changes: plan.ops.length,
    };
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, ...detail });
      return;
    }
    const result = session.apply(plan.ops, { refreshIntegrity: false });
    sendJson(res, result.ok ? 200 : 400, {
      ...result, bytes: undefined, ...detail,
      overview: result.ok ? session.overview() : undefined,
    });
    return;
  }

  /* ------------------------------------------------- seasonpass/unlock --
   * Write the season-pass progress set and push it, in one action.
   *
   * MEASURED OUTCOME (2026-10-20, real in-game test on 127.0.0.1:21513): this
   * does NOT unlock the pass, and the reply says so rather than claiming an
   * unlock. Read back from the game's own re-saved file after relaunch:
   *
   *   * the account was NOT rolled back — level 40, coins 123,456, stars 42,
   *     13 areas, StepsState 2,603, no "suspicious activity" window;
   *   * every local field written here SURVIVED untouched (31 stages,
   *     currProgress=30, currentOpenedStageIndex=31, the log counters);
   *   * but the game DELETED `Currency.<season>Points`, and the pass rendered
   *     at stage 1 of 31 with the next stage locked at 0/1.
   *
   * So the displayed tier derives from that currency server-side and the
   * completion cache is inert without it. The first attempt's catastrophic
   * rollback (level 40 -> gone) is now isolated as a consequence of writing the
   * currency alone against zero progress — the INCONSISTENCY — not the currency
   * write itself; with the whole set written together the game removed only the
   * currency and left the account whole.
   *
   * The GOLD row is refused outright: it needs the golden ticket, a real-money
   * purchase validated through ValidatePurchase/ConsumePurchase. Asserting
   * `LogEventComponent.goldenPassBought` would be purchase spoofing, so the
   * reply carries `goldRow.unlocked=false` and the reason.
   */
  if (route === "POST /api/seasonpass/unlock") {
    const body = await readJson<{ serial: string }>(req);
    if (!body.serial) throw new SessionError("`serial` is required", 400);

    let srcBytes: Uint8Array;
    try {
      srcBytes = new Uint8Array(await readFile(IGG_SOURCE));
    } catch {
      throw new SessionError(`the built-in account is missing: ${IGG_SOURCE}`, 400);
    }
    const donor = createSession("season-pass-source", srcBytes);

    const reply = await callBridge(["pull", "--serial", body.serial]);
    if (!(reply.ok && reply.b64)) {
      sendJson(res, 400, { ok: false, error: reply.error ?? "could not read the device save" });
      return;
    }
    const target = createSession(`device:${body.serial}`, b64ToBytes(reply.b64));

    let plan;
    try {
      plan = planSeasonPass(openSave(target.plain), openSave(donor.plain));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message });
      return;
    }

    const result = target.apply(plan.ops, { refreshIntegrity: true });
    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        season: plan.season,
        pointsPath: plan.pointsPath,
        highlights: plan.highlights,
        errors: result.errors,
        warnings: result.warnings,
      });
      return;
    }

    // Push now — this route is the one-tap action, not a staged session.
    const tmp = join(DIST, "..", ".push-tmp.db");
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(tmp, Buffer.from(target.exportContainer()));
    let pushed: any;
    try {
      pushed = await callBridge(["push", "--serial", body.serial, "--in", tmp]);
    } finally {
      await rm(tmp, { force: true });
    }

    sendJson(res, pushed?.ok ? 200 : 400, {
      ok: Boolean(pushed?.ok),
      season: plan.season,
      pointsPath: plan.pointsPath,
      points: plan.points,
      completedStages: plan.completedStages,
      goldRow: plan.goldRow,
      eventPresent: plan.eventPresent,
      highlights: plan.highlights,
      stats: plan.stats,
      notes: plan.notes,
      bytes: target.overview().meta.plainBytes,
      relaunched: pushed?.relaunched ?? false,
      warnings: result.warnings.slice(0, 20),
      warningsTotal: result.warnings.length,
      pushError: pushed?.ok ? undefined : pushed?.error,
    });
    return;
  }

  if (route === "GET /api/cosmetics/catalog") {
    sendJson(res, 200, { ok: true, groups: COSMETICS });
    return;
  }

  if (route === "GET /api/cosmetics/state") {
    const session = resolveSession(url.searchParams.get("sessionId") ?? undefined);
    const save = openSave(session.plain);
    const state: Record<string, { owned: string[]; equipped: string | null }> = {};
    for (const g of COSMETICS) {
      const owned: string[] = [];
      if (g.flagPrefix) {
        if (save.has("Avatars")) {
          for (const it of g.items) {
            const flag = `${g.flagPrefix}${it.id}`;
            if (save.has(flag) && save.field(flag).value === true) owned.push(it.id);
          }
        }
      } else if (g.ownershipList && save.has(g.ownershipList)) {
        for (const id of save.string(g.ownershipList).split(",")) if (id) owned.push(id);
      }
      const equipped = save.has(g.equipPath) ? save.string(g.equipPath) : null;
      state[g.kind] = { owned, equipped };
    }
    sendJson(res, 200, { ok: true, state });
    return;
  }

  if (route === "POST /api/cosmetics") {
    const body = await readJson<CosmeticsBody>(req);
    const session = resolveSession(body.sessionId);
    const save = openSave(session.plain);
    const ops: EditOp[] = [];
    try {
      for (const kind of ["frames", "styles", "badges", "titles", "avatars"] as const) {
        const ids = body.grant?.[kind];
        if (ids === undefined) continue;
        if (!Array.isArray(ids)) {
          throw new SessionError(`grant.${kind} must be an array of ids`, 400);
        }
        ops.push(...grantOps(save, kind, ids));
      }
      if (body.equip !== undefined) ops.push(...equipManyOps(save, body.equip));
    } catch (err) {
      throw err instanceof SessionError
        ? err
        : new SessionError((err as Error).message, 400);
    }
    const result = session.apply(ops, { refreshIntegrity: body.refreshIntegrity ?? true });
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      summary: result.summary,
      integrity: result.integrity,
      warnings: result.warnings,
      errors: result.errors,
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      overview: result.ok ? session.overview() : undefined,
    });
    return;
  }

  /* ------------------------------------------------------- cards grant --
   * The Cards tab's write path. Pure planning in the engine: which rows
   * bump, which get appended, and the derived `lastSeenProgress` re-derivation
   * for every touched set. Nothing is pushed here — the operator presses Push.
   */
  if (route === "POST /api/cards/grant") {
    const body = await readJson<CardsGrantBody>(req);
    if (!Array.isArray(body.cards) || body.cards.length === 0) {
      throw new SessionError("`cards` must be a non-empty array of card numbers", 400);
    }
    for (const c of body.cards) {
      if (!Number.isInteger(c) || c < 1 || c > CARD_COUNT) {
        throw new SessionError(`card number ${String(c)} is outside 1..${CARD_COUNT}`, 400);
      }
    }
    if (body.cards.length > BATCH_MAX) {
      throw new SessionError(
        `\`cards\` carries ${body.cards.length} entries but one grant holds at most ${BATCH_MAX} — split the selection into waves of ${BATCH_MAX}`,
        400,
      );
    }
    const session = resolveSession(body.sessionId);
    const save = openSave(session.plain);
    if (!readAlbum(save).present) {
      throw new SessionError(
        "this save has no SpecialEvents.CardsCollection album — the card event is not live for this account",
        400,
      );
    }
    const plan = planGrants(save, body.cards, body.copies ?? 1);
    const result = session.apply(plan.ops, { refreshIntegrity: body.refreshIntegrity ?? true });
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      summary: result.summary,
      integrity: result.integrity,
      warnings: result.warnings,
      errors: result.errors,
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      overview: result.ok ? session.overview() : undefined,
      plan: {
        bumps: plan.bumps,
        added: plan.added,
        capped: plan.capped,
        stockCap: STOCK_CAP,
        cardCount: CARD_COUNT,
        setCount: SET_COUNT,
      },
    });
    return;
  }

  if (route === "POST /api/session/reset") {
    const body = await readJson<{ sessionId?: string; fromSessionId?: string }>(req);
    const session = resolveSession(body.sessionId);
    // Reload the ORIGINAL container so the user can start over.
    const fresh = createSession(session.name + " (reset)", session.container);
    sendJson(res, 200, { ok: true, overview: fresh.overview() });
    return;
  }

  if (route === "GET /api/export") {
    const session = resolveSession(url.searchParams.get("sessionId") ?? undefined);
    const data = Buffer.from(session.exportContainer());
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": data.length,
      "content-disposition": `attachment; filename="SaveGame.db"`,
    });
    res.end(data);
    return;
  }

  // ---- device operations (delegate to the Python bridge) ------------------

  if (route === "GET /api/devices") {
    sendJson(res, 200, { ok: true, ...(await callBridge(["adb-info"])) });
    return;
  }

  if (route === "POST /api/device/pull") {
    const body = await readJson<{ serial: string }>(req);
    if (!body.serial) throw new SessionError("`serial` is required", 400);
    const reply = await callBridge(["pull", "--serial", body.serial]);
    if (reply.ok && reply.b64) {
      const session = createSession(`device:${body.serial}`, b64ToBytes(reply.b64));
      sendJson(res, 200, { ok: true, file: reply.file, package: reply.package, overview: session.overview() });
      return;
    }
    sendJson(res, 400, reply);
    return;
  }

  if (route === "POST /api/device/push") {
    const body = await readJson<{ serial: string; restart?: boolean; sessionId?: string }>(req);
    if (!body.serial) throw new SessionError("`serial` is required", 400);
    const session = resolveSession(body.sessionId);
    const tmp = join(DIST, "..", ".push-tmp.db");
    const data = Buffer.from(session.exportContainer());
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(tmp, data);
    try {
      const args = ["push", "--serial", body.serial, "--in", tmp];
      if (body.restart === false) args.push("--no-restart");
      const reply = await callBridge(args);
      sendJson(res, reply.ok ? 200 : 400, reply);
    } finally {
      await rm(tmp, { force: true });
    }
    return;
  }

  if (route === "POST /api/device/stop") {
    const body = await readJson<{ serial: string }>(req);
    sendJson(res, 200, { ok: true, ...(await callBridge(["force-stop", "--serial", body.serial])) });
    return;
  }

  if (route === "POST /api/device/start") {
    const body = await readJson<{ serial: string }>(req);
    sendJson(res, 200, { ok: true, ...(await callBridge(["start", "--serial", body.serial])) });
    return;
  }

  if (route === "POST /api/device/restore") {
    const body = await readJson<{ serial: string }>(req);
    sendJson(res, 200, { ok: true, ...(await callBridge(["restore-backup", "--serial", body.serial])) });
    return;
  }

  if (route === "POST /api/inspect") {
    // Debug endpoint: report how a raw buffer would be interpreted.
    const body = await readJson<{ b64: string }>(req);
    const bytes = b64ToBytes(body.b64);
    try {
      const idx = scanSpans(bytes);
      sendJson(res, 200, {
        ok: true,
        container: describeContainer(bytes),
        rootType: idx.rootType,
        members: idx.members.size,
        rootEnd: idx.rootEnd,
        trailing: bytes.length - idx.rootEnd,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message });
    }
    return;
  }

  if (route === "GET /api/apk/vso") {
    // Decode BLK(zstd) VSO bundles out of an extracted APK directory and
    // return their identifier pools (feature/condition/variable names).
    const dir = url.searchParams.get("dir") ?? "";
    const q = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 300);
    if (!dir) throw new SessionError("pass `dir` (path to a decoded APK assets directory)", 400);
    const full = resolvePath(dir).replace(/\\/g, "/");
    if (!/(?:^|\/)(?:assets|[^/]+\.vso)(?:$|\/)/i.test(full) && !full.toLowerCase().endsWith(".vso")) {
      // Only allow apk directories: either an assets dir or an individual .vso file.
      throw new SessionError("dir must be an APK assets directory or a .vso file path", 400);
    }
    try {
      await stat(full);
    } catch {
      throw new SessionError(`path not found: ${full}`, 404);
    }
    const fileStat = await stat(full);
    const rows = fileStat.isDirectory()
      ? await scanVsoDir(full, limit)
      : ([{ path: full, decodedBytes: 0, tokens: [] }] as Array<{
          path: string;
          decodedBytes: number;
          tokens: string[];
        }>);
    // Fill single-file row from the payload directly.
    if (rows.length > 0 && rows[0]!.decodedBytes === 0) {
      const bytes = new Uint8Array(await readFile(full));
      const dec = decodeBlkZstd(bytes);
      if (!dec) throw new SessionError(`no zstd frame in ${full}`, 415);
      const row = rows[0]!;
      row.decodedBytes = dec.data.length;
      row.tokens = uniqueTokens(asciiTokens(dec.data));
    }
    const needle = q.toLowerCase();
    const filtered = needle
      ? rows
          .map((r) => ({ ...r, tokens: r.tokens.filter((t) => t.toLowerCase().includes(needle)) }))
          .filter((r) => r.tokens.length > 0)
      : rows;
    sendJson(res, 200, {
      ok: true,
      dir: full,
      query: q,
      bundles: filtered.map((r) => ({
        path: r.path,
        decodedBytes: r.decodedBytes,
        tokens: r.tokens.slice(0, 400),
        tokenCount: r.tokens.length,
      })),
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: `no route: ${route}` });
}

// ------------------------------------------------------------------- server --

const server = createServer((req, res) => {
  void (async () => {
    // Dev server (Vite) runs on another origin; allow it.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (await serveStatic(res, url.pathname)) return;
      sendJson(res, 404, {
        ok: false,
        error: "UI not built. Run `npm run build` or use the Vite dev server.",
      });
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  })();
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Homescapes Save Studio listening on http://${HOST}:${PORT}\n`);
});
