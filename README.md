# ⚔️ MicroMiniger

Detailed management of your personal miniature and collectible collection — a single-page,
zero-dependency, offline-first PWA. No accounts, no server, no tracking.

> **⚠️ Your data lives only in your browser.** Everything is stored in this browser's
> IndexedDB. Clearing site data, uninstalling the browser, or heavy disk pressure can
> erase it. Use the **Backup** button regularly — it downloads a single JSON file that
> restores everything, photos included.

## Running it

Any static file server works; ES modules don't load from `file://`.

- **Windows:** double-click `start.cmd` (serves on `localhost:8137` and opens your browser)
- **Anything else:** `python -m http.server 8137` in this folder, then open `http://localhost:8137`
- **Hosted:** works as-is on GitHub Pages or any static host

Once open, your browser's install button adds it as a desktop/mobile app with offline support.

## What it does

- **Collection**: per-mini metadata — game/faction/unit, quantity, scale, material, base size,
  tags, kit(s) used (kitbash-aware), paints & tools used, stats/lore links, purchase or gift
  provenance with receipt attachment and text-receipt parsing, current/former owners, painters,
  lost/sold/gifted status with sale details, wishlist, estimated value, ratings (overall +
  paint/assembly/varnish/sculpt), damage log, dated work log, paint recipes, notes
- **Painting workflow**: 8-stage progress, kanban Paint Queue with drag-and-drop, a paint
  timer that banks time into per-mini totals, deadlines with overdue warnings, automatic
  finished-on dates, finished-per-month chart, "what should I paint next?"
- **Photos**: multi-angle photos with labels, drag-drop and camera capture, auto thumbnails,
  lightbox with rotate, gallery photo wall, 360° drag viewer, spin video (WebM) and animated
  GIF export, Instagram-ready share cards, per-mini exhibition/post URL tracking
- **3D**: build a real textured 3D mesh from your turntable photos entirely offline
  (silhouette space carving), preview STL/PLY in a WebGL viewer, import and orbit Gaussian
  splats (`.splat` / 3DGS `.ply`), export NeRF/splat capture sets with camera poses
  (nerfstudio `transforms.json`), orbit video/GIF export, STL/PLY export for printing
- **Armies & battles**: sets/armies with points, painted progress and cost, tournament
  deadlines, copyable text rosters, and a battle log with per-army win/loss records
- **Organisation**: field-scoped search (`game:x stage:primed tag:hero`), saved filter views,
  sortable table view, bulk edit, slideshows with video/GIF export, CSV import/export,
  print view, dashboard with click-through stats
- **Paints & tools**: inventory with color swatches, condition tracking, restock shopping list
- **Safety**: one-file backup/restore, undo on delete, unsaved-changes guard, persistent-storage
  request, storage meter, backup-age reminder

## Privacy

All data stays on your device; the app makes no network requests beyond loading its own
files. There are no analytics, no cookies, and no accounts. If you use a hosted copy, the
host (e.g. GitHub Pages) logs standard web-request data such as your IP address, as all
web hosts do.

**Optional cloud backup** (the ☁ button) is off until you connect it. Two providers:

- **Local folder** — writes the backup file into a folder you pick (point it at a Google
  Drive / Dropbox / OneDrive desktop sync folder for free cloud backup, no accounts).
- **Google Drive** — signs in with Google (OAuth popup) and stores the backup in the app's
  private Drive app-data folder. Your browser talks directly to Google; no other server is
  involved and no token is ever persisted. Self-hosted forks are origin-gated out of the
  built-in OAuth client and must supply their own client ID in the ☁ dialog.

## Disclaimer

MicroMiniger is a fan-made hobby tool. It is **not affiliated with, sponsored, or endorsed
by any game publisher, miniature manufacturer, or paint brand**. All product names and
trademarks that you enter into the app, or that appear in links you attach, belong to their
respective owners. The app ships with no game content — stats and lore are your own links
to wherever you legally read them.

## License

[MIT](LICENSE). Provided as-is, without warranty — see the license text, and keep backups.
