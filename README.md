# Homescapes VIP Studio

Professional Homescapes save editor — all save algorithms run server-side, and a Windows
client (WebView2 + ADB) drives the device. The server owns every transformation (byte-exact,
surgical edits); the client only moves bytes and hosts the UI.

## What works

Everything below is wired into the running UI and covered by the verification suite.

**Client flow (the way a job actually gets done)**

| Step | What happens |
| --- | --- |
| *Device picker + Connect* | Reads the client's live `SaveGame.db` off the selected emulator/phone (ADB + root, with `run-as` and temp-copy fallbacks), then shows the account's own name and level. |
| *Edit* | 25 tabs, all writing through the same staged-edit pipeline. Nothing is written until Save/Push. |
| *Save* | Applies staged edits byte-exactly, refreshes only the integrity strings that are **proven derived**, and reports the exact byte diff. |
| *Push & Launch* | Force-stops the game, writes the save, keeps a `.hcsbak` snapshot and relaunches. Refuses a payload that is not a save. |
| *Restore* | One-click restore from the tool's own backup. |

**Editable data**

- **Data Center / Stats** — coins, stars (with the R4 `V:` mirror), level, lives, first-play
  date and the in-game profile statistics (Olympus Cup + General Stats).
- **Currencies, Items, Quests, Rooms, Collections, Costumes, Events, Match-3, Explorer** —
  live field browsers over `Currency.*`, `PlayerItems.*`, `Quests.*`, `RoomDesign.*`,
  `Characters|PhotoAlbums|GameTrophy`, `Garment.*`, `SpecialEvents.*`, `Match3.*`, plus a raw
  path explorer with server-side search.
- **Boosters / Lives** — one-click presets and bulk fill.
- **Cards** — grants copies into the album (stock-capped at 4, because the event converts a
  5th copy), appending rows and re-deriving `lastSeenProgress`.
- **Frames / Styles / Badges / Avatars / All cosmetics** — grant + equip, merge-safe
  (a grant is a union, never a clobber).
- **Decorations / Pets** — the visible home.
- **Home Pass + MAX_GP** — one click detects the live season and writes the season points
  and `PlayerItems.<season>GoldenTicket`. Idempotent: a second run changes nothing.
- **Season pass** — copies the donor's whole season shape, matched **by component name**,
  never asserts the gold row (that is a real-money purchase; see `src/engine/seasonpass.ts`).
- **IGG Account (content clone)** — transplants the donor's content roots (home, décor,
  furniture, characters, avatars, photo albums) onto the live account and refuses every
  progression root.
- **Fresh Start / Review** — reset to the original bytes, or inspect the staged diff and the
  byte-level audit trail before committing.
- **Owner Hub** — issue / list / revoke / restore / device-reset keys.

## Verification

```bash
npm install
npm run typecheck     # strict TS, noUncheckedIndexedAccess
npm test              # engine suite (78 cases, incl. integration vs the shipped save)
npm run test:ui       # renders the app in jsdom, clicks all 25 tabs
npm run build         # bundle
npm run verify        # all of the above
```

`npm test` runs the integration cases against `data/IGG-account.db` (the save this repo
ships), not a developer's Downloads folder, so they actually run in CI. Set `HS_FIXTURE` to
test a different save, and `HS_LIVE` to a raw 9.2.101 container to exercise the recovered
XOR key.

`.github/workflows/verify.yml` runs the above on every push/PR, then boots the server and
proves a load → export round-trip is byte-identical.

## Develop

```bash
npm run dev        # Vite dev server (proxies /api to the studio server)
npm run server     # studio server on :8787, serves ./dist when built
```

## Architecture

```
src/engine/    save codec + span scanner + byte patcher + planners (zero deps)
src/server/     node:http server — license gate, sessions, all game logic
src/sections/   UI tabs (React 19 + Tailwind 4)
client/         Windows EXE — ADB bridge, WebView2 shell, local device proxy
tools/          research probes + the UI smoke test
```

The invariant that matters: **never re-serialise a save**. Every write is a span splice, and
`assertUntouched` proves afterwards that nothing outside the edited spans moved.

## Deploy on Render

`render.yaml` is a Blueprint — *New → Blueprint* is enough. Manual settings for a Web Service:

| Setting | Value |
| --- | --- |
| Runtime | Node 22 |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Instance Type | Free (or Starter for no spin-down) |

| Environment variable | Value | Needed |
| --- | --- | --- |
| `NODE_VERSION` | `22` | always |
| `HS_MASTER` | ≥32 random chars | turns the login on |
| `HS_OWNER` | ≥12 chars, private | enables the Owner Hub |
| `DATABASE_URL` | Postgres (Neon) string | **mandatory in the cloud** — without it issued keys are lost on every restart |
| `HC_ALLOW_ORIGIN` | comma-separated origins | only if the UI is served from another origin |
| `HC_MAX_SESSIONS` / `HC_MAX_SESSIONS_PER_OWNER` | default `4` / `3` | raise on a bigger plan |
| `HC_SESSION_TTL_MS` | default `2700000` (45 min) | idle eviction |
| `HC_HOSTED` | `1`/`0` | forces hosted/local behaviour (otherwise inferred from `PORT`) |

Generate the master key, never invent it — changing `HS_MASTER` invalidates every issued key.

### Hosted vs local

**Works in the cloud:** license login, **Open save** (pick a `SaveGame.db` — this is how a save
enters a hosted deployment), every edit, cards, cosmetics, MAX_GP, review, export.

**Needs a local machine:** `/api/device/*` and `/api/clone-content` shell out to
`client/hc_client.py` + `adb` against a connected device, which a container cannot reach. The
desktop client solves this by running a **local proxy**: the window loads
`http://127.0.0.1:<port>`, `/api/device/*` is answered locally by ADB, and everything else is
forwarded to the hosted studio. So the UI is the hosted one, the device stays local.

### Security notes (what changed)

- **Sessions are scoped to the license fingerprint.** Two clients on one deployment can never
  list, read, edit or export each other's save; the store is capped (per-owner and global) and
  idle sessions expire.
- **CORS is not `*` any more.** Only real loopback origins are allowed (the dev server proxies
  `/api`, so it needs none), unless `HC_ALLOW_ORIGIN` names them. This closes the chain where a
  page you merely visited could `POST /api/session/load {path}` and then `GET /api/export`.
- **`/api/clone-content` reads only the built-in account.** A caller-supplied source path is
  gone; `/api/session/load` path reads stay local-only.
- **License and owner routes are rate-limited** (10/min, then doubling cooldowns after 5
  failures) and the passcode comparison is constant-time.
- **Each push gets its own temp directory**, so two simultaneous pushes cannot write over each
  other's file.
- **`hc update` only installs this project's release, and only with a published SHA-256.**

## Known scope (honest)

- A Push writes the edited bytes and relaunches; Playrix's own launch-time cloud reconciliation
  is outside a save editor's control and can overwrite local progression. Force-stop, relaunch
  and re-pull if a change does not appear.
- The season-pass **gold row** is never written: the golden ticket is a store purchase the
  client validates through `ValidatePurchase`/`ConsumePurchase`, so asserting
  `goldenPassBought` would be purchase spoofing. The API reports `goldRow.unlocked=false` with
  the reason instead of pretending.
- A full-account transplant is not offered: `AntiCheat.Server.ScoreValidation` scores an
  account's progress against its own history, so only *content* is ever cloned.
- Account risk is yours: modifying a live save can be detected and can cost the account.

## Licensing / disclaimer

This is a save editor for your own devices and accounts. It ships a recovered XOR key for the
current client build, a sample save (`data/IGG-account.db`) and game artwork under `public/`;
all trademarks and assets belong to Playrix. Use at your own risk — no warranty of any kind.
