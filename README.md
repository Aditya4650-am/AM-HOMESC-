# Homescapes VIP Studio

Professional Homescapes save-editing tool — server-side save algorithms with a Windows
client shell (WebView2 + ADB). Modeled on the IGG VIP Studio architecture: the server
owns every save transformation (byte-exact, surgical edits) and the client only drives
the device and hosts the UI.

## Features

- **Device bridge** — ADB pull / push with root (`su`), force-stop, `SaveGame.db.hcsbak`
  snapshot backup, one-click restore, optional relaunch.
- **Save codec** — repeating-XOR (period 731) decode/encode with automatic per-install
  statistical key recovery; integrity strings refreshed only where proven derived.
- **Data Center** — coins, stars, lives, chapter & quest progress at a glance.
- **Boosters** — edit the match-3 booster inventory.
- **Cosmetics** — frames, styles, badges, titles, avatars: grant + equip with
  merge-safe operations (server unions grants, never clobbers ownership).
- **Quests / Rooms / Collections** — quest completion state, renovation repairs,
  character & album collections.
- **Review & apply** — every staged edit is reviewed, then applied as one byte-exact
  patch with `assertUntouched` guarantees.

## Develop

```bash
npm install
npm run dev        # Vite dev server
npm run server     # production server (serves ./dist) on :8787
npm test           # engine test-suite (node --experimental-strip-types --test)
npm run build      # typecheck + vite build
```

## Architecture

```
src/engine/    save codec + op-builder (surgical byte-level edits, zero deps)
src/server/    node:http server — all game logic lives here
src/sections/  UI sections (React + Tailwind)
client/        Windows EXE client — ADB driver + WebView2 shell around the web UI
```

All game logic is server-side. The UI stages intent; the server builds merge-safe
operations and returns the exact op list applied.
