# MIB Atlas project context

Read this first when continuing work. Keep it synchronized with architecture,
commands, schema, privacy behavior, and deployment requirements.

## Product contract

MIB Atlas combines:

1. A scalable PHP/MySQL browser for operator-supplied server MIBs.
2. A private client-only parser and workspace for arbitrary user uploads.

User-uploaded source must never be sent to the backend. Server searches are
bounded and paginated; the browser must never download the complete server
definition index.

The source repository does not distribute server MIBs or generated SQL.

## Runtime architecture

```text
server-mibs/** ─build-server-data.mjs─→ database/mib-atlas.sql
                                             │
                                             ▼
Browser search/tree/detail requests ─→ PHP API ─→ MySQL
Browser download request ────────────→ PHP API ─→ original MIB file

User File objects ─→ parseMib ─→ buildRegistry ─→ UI
       └────────────→ IndexedDB (browser only)
```

## Important files

- `app.js`: server API state, bounded results, lazy tree loading, and local
  upload UI.
- `parser.js`: DOM-free ASN.1/SMI parser and resolver used by the SQL generator
  and browser uploads.
- `storage.js`: IndexedDB database `mib-atlas`, object store `mib-files`.
- `api/bootstrap.php`: PDO configuration, validation, row mapping, and generic
  error handling.
- `api/config.example.php`: committed configuration template.
- `api/config.php`: ignored runtime secrets and absolute MIB root.
- `api/{modules,search,tree,definition,download}.php`: server API.
- `scripts/build-server-data.mjs`: recursively discovers MIB source and writes
  the MySQL dump.
- `database/mib-atlas.sql`: generated and Git-ignored; never edit manually.
- `server-mibs/`: operator-supplied, recursively scanned, and Git-ignored.
- `server-mibs/.htaccess`: tracked protection for the otherwise ignored tree.
- `tests/fixtures/`: synthetic project-owned test MIBs.
- `sw.js`: application-shell cache only; `/api/` is bypassed.

## Server MIB discovery and build contract

- Scan `server-mibs/` recursively.
- Skip hidden files and hidden directories.
- Treat a file as a MIB when its decoded text contains
  `DEFINITIONS ::= BEGIN`, case-insensitively.
- Do not depend on filename extensions.
- The first path component is the provider label; top-level files use
  `Provided`.
- Parse all discovered modules together for cross-module OID resolution.
- Every server module is downloadable and has rich details; these are API
  invariants rather than per-module database flags.
- Generate rich fields for every definition.
- Identical source files and parser input must produce byte-identical SQL.

The generator records module/definition counts plus source and parser SHA-256
hashes. It no longer uses a JSON manifest or licensing audit.

## Database contract

Generated tables:

- `mib_atlas_metadata`: schema version, counts, source hash, parser hash.
- `mib_atlas_modules`: source path, names, provider, size, and definition count.
- `mib_atlas_definitions`: resolved structure, tree relationship, searchable
  text, and rich detail fields.

Important indexes:

- Full-text `ft_search(search_text)`.
- `idx_tree_parent(tree_parent_oid, oid)` for lazy tree requests.
- Module/name/OID indexes for scoped searches and lookup.

The dump drops and recreates the three `mib_atlas_*` tables before inserting
anything. This full-replacement behavior is required so removing a source MIB
also removes it from MySQL on the next import. Import the dump into an already
selected database. Production API credentials need only `SELECT`.

## Update workflow

1. Change files under `server-mibs/`.
2. Confirm the operator is allowed to process and redistribute every file.
3. Run `npm run build:server-data`.
4. Run `npm run test:all`.
5. Import the ignored SQL into a disposable database and test all endpoints.
6. Deploy the exact MIB tree with the generated database.

Do not commit MIBs or SQL. If either was tracked in an older Git history,
remove it from the index during migration.

## API behavior

- `modules.php`: up to 1000 catalogue rows plus aggregate metadata.
- `search.php`: offset pagination, default 100, maximum 500.
- `tree.php`: validates numeric OIDs and returns immediate indexed children.
- `definition.php`: returns one rich definition.
- `download.php`: accepts a numeric module ID, resolves it under `mib_root`,
  prevents traversal, and streams the original. All generated modules are
  downloadable.

All SQL uses prepared statements. Never interpolate request parameters into
SQL or filesystem paths.

## Client state and performance

- The neutral workspace loads module metadata only.
- There is no aggregate “All Objects” view.
- Server results are paginated and capped.
- Selecting a module opens its tree and expands the module by default.
- Built-in resolver arcs are never rendered.
- “Show in tree” expands only a result's ancestors and scrolls to it.
- Top search is global regardless of selected sidebar module.
- Search input is debounced and stale responses are ignored.
- Uploaded-module selection performs no server search.
- Uploaded definitions resolve only against built-in roots and other uploads.

Do not reintroduce a client-wide server definition index or unbounded DOM rows.

## Privacy and security

- Uploaded contents stay in browser memory and IndexedDB.
- Global search terms go to the server; uploaded file contents do not.
- Secrets live only in ignored `api/config.php`.
- Rendered values pass through `escapeHtml`.
- API errors do not expose SQL or exception details.
- Direct HTTP access to `server-mibs/` must be denied.
- Prefer placing runtime originals outside the public document root.
- The service worker excludes API responses and downloads.

## UI conventions

- Uploaded MIBs appear above provided MIBs.
- Every provided row exposes a download control.
- Search uses a distinct Symbol/MIB/Type/OID result layout.
- Built-in roots remain internal and are never rendered.
- `/` focuses global search; Escape clears it.
- Clearing uploads must not affect server data.

## Definition of done

- `npm run test:unit` and `npm run test:e2e` pass.
- JavaScript syntax checks pass.
- Every PHP file passes `php -l`.
- Generated SQL imports into a disposable MySQL/MariaDB database.
- API integration covers catalogue, search, tree, detail, and download.
- Local import/search/removal works while the API is unavailable.
- README, this file, schema behavior, and service-worker version are current.
