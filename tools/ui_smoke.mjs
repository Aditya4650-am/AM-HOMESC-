/**
 * UI smoke test — renders the real app in jsdom against a real server.
 *
 * Why this exists: twelve complete feature tabs (currencies, items, quests,
 * rooms, collections, costumes, events, match-3, explorer, boosters, lives,
 * cosmetics) were written and typechecked but never mounted, and nothing
 * noticed. Typechecking proves a component compiles; only rendering proves it
 * runs. This boots the studio server, bundles the app with esbuild, loads it in
 * jsdom with the shipped save already open, then clicks every navigation entry
 * and fails on a crash, a blank tab, or any console error.
 *
 *   npm run test:ui            # headless, exits non-zero on failure
 *   UI_SMOKE_VERBOSE=1 ...     # print the tab list as it goes
 *
 * The save it opens is `data/IGG-account.db`, so a tab that reads a field which
 * does not exist still fails here rather than in a client's session.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

const PORT = Number(process.env.UI_SMOKE_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const verbose = Boolean(process.env.UI_SMOKE_VERBOSE);

/** Every navigation entry the shell is expected to expose. */
const LABELS = [
  "Dashboard", "Stats", "Cards",
  "Currencies", "Items", "Quests", "Rooms", "Collections", "Costumes", "Events",
  "Match 3", "Explorer", "Pets",
  "Boosters", "Lives",
  "Frames", "Styles", "Badges", "Avatars", "Decorations", "All cosmetics",
  "Home Pass", "Fresh Start", "IGG Account", "Review",
];

const fail = (message) => {
  console.error(`ui-smoke: ${message}`);
  process.exitCode = 1;
};

function loadJsdom() {
  try {
    return require("jsdom");
  } catch {
    console.error(
      "ui-smoke: jsdom is not installed — run `npm install` (it is a devDependency),\n" +
        "           or skip this check with `npm test`.",
    );
    process.exit(2);
  }
}

function loadEsbuild() {
  try {
    return require("esbuild");
  } catch {
    console.error("ui-smoke: esbuild is not installed — run `npm install`.");
    process.exit(2);
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer on ${BASE}`);
}

async function main() {
  const { JSDOM, VirtualConsole } = loadJsdom();
  const esbuild = loadEsbuild();

  const fixture = join(ROOT, "data", "IGG-account.db");
  if (!existsSync(fixture)) throw new Error(`missing fixture ${fixture}`);

  // ---- 1. server (ungated, so the shell opens straight into the studio)
  const server = spawn(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src", "server", "main.ts")],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", HS_MASTER: "", HC_HOSTED: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  const work = mkdtempSync(join(tmpdir(), "ui-smoke-"));
  try {
    const health = await waitForServer();
    if (health.licenseGate !== false) throw new Error("expected an ungated server for the smoke test");

    // ---- 2. a save is open before the UI loads
    const b64 = readFileSync(fixture).toString("base64");
    const loaded = await (
      await fetch(`${BASE}/api/session/load`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ui-smoke", b64 }),
      })
    ).json();
    if (!loaded.ok) throw new Error(`could not open the save: ${JSON.stringify(loaded)}`);

    // ---- 3. bundle the real app (CSS is irrelevant to behaviour)
    const bundle = join(work, "app.js");
    await esbuild.build({
      entryPoints: [join(ROOT, "src", "main.tsx")],
      bundle: true,
      format: "iife",
      loader: { ".css": "empty", ".png": "empty", ".webp": "empty", ".svg": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: bundle,
      logLevel: "warning",
    });

    // ---- 4. render it
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(`jsdomError: ${e.message}`));
    vc.on("error", (...a) => errors.push(`console.error: ${a.join(" ")}`));

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      runScripts: "outside-only",
      url: "http://127.0.0.1:5173/",
      virtualConsole: vc,
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.fetch = (url, init) =>
      fetch(String(url).startsWith("http") ? String(url) : BASE + String(url), init);
    window.Headers = Headers;
    window.Request = Request;
    window.Response = Response;
    window.AbortController = AbortController;
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.scrollTo = () => {};
    window.addEventListener("error", (e) => errors.push(`window.error: ${e.error?.stack ?? e.message}`));
    window.eval(readFileSync(bundle, "utf8"));

    const text = () => window.document.body.textContent ?? "";
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < 100 && !text().includes("Dashboard"); i++) await wait(100);
    if (!text().includes("Dashboard")) {
      throw new Error(`the studio shell never rendered — body starts: ${text().slice(0, 200)}`);
    }

    // ---- 5. the header must offer the three ways a job starts
    for (const control of ["Open save", "Connect", "Push & Launch"]) {
      const found = [...window.document.querySelectorAll("button")].some((b) =>
        (b.textContent ?? "").includes(control),
      );
      if (!found) {
        fail(`header: no "${control}" control`);
        process.exitCode = 1;
      }
    }

    // ---- 6. click every tab
    let passed = 0;
    let failed = 0;
    for (const label of LABELS) {
      const before = errors.length;
      const button = [...window.document.querySelectorAll("button, [role=tab]")].find(
        (n) => (n.textContent ?? "").trim() === label,
      );
      if (!button) {
        fail(`${label}: no navigation entry`);
        failed++;
        continue;
      }
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await wait(400);
      const newErrors = errors.slice(before);
      if (newErrors.length) {
        fail(`${label}: ${newErrors[0].slice(0, 200)}`);
        failed++;
        continue;
      }
      if (text().length < 80) {
        fail(`${label}: rendered nothing`);
        failed++;
        continue;
      }
      if (verbose) console.log(`  ok   ${label}`);
      passed++;
    }

    console.log(
      `ui-smoke: ${passed}/${LABELS.length} tabs rendered against the shipped save` +
        (failed ? `, ${failed} FAILED` : ""),
    );
    if (failed) process.exitCode = 1;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    if (serverLog) console.error(serverLog.trim().split("\n").slice(-8).join("\n"));
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!server.killed) server.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
