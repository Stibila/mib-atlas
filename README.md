# MIB Atlas

MIB Atlas is an SNMP MIB browser with two separate data paths:

- Server-provided MIBs are preprocessed into MySQL, searched through a small
  PHP API, and available as original-file downloads.
- User-uploaded MIBs are parsed, searched, and stored entirely in the browser.
  Uploaded source is never sent to the server.

The repository contains the application, parser, API, and SQL generator. It
does not distribute a MIB collection or a generated database dump. Each
operator supplies the MIBs they are entitled to host.

## Features

- Recursively discovers MIBs anywhere below `server-mibs/`.
- Recognizes MIB source by `DEFINITIONS ::= BEGIN`, including extensionless
  files, while ignoring `.htaccess`, README, license, and other non-MIB files.
- Preprocesses server MIBs into a MySQL search and tree index.
- Makes every indexed server-provided MIB available through the download API.
- Uses bounded, paginated server searches instead of loading the full index in
  the browser.
- Opens a provided MIB as a fully expanded OID tree.
- Opens a global search result in its owning MIB and expands its ancestor path.
- Parses arbitrary user uploads locally and keeps them separate from provided
  MIBs in the interface.
- Persists user uploads in IndexedDB and supports individual removal or
  clear-all.
- Provides responsive light and dark themes without external UI assets.

## Requirements

Runtime:

- PHP 8.1 or later with PDO MySQL
- MySQL 8 or a current MariaDB release with InnoDB full-text indexes
- Apache, Nginx, or another PHP-capable web server
- HTTPS in production

Build and maintenance:

- Node.js 20 or later
- npm only when running the browser test suite

There are no npm runtime dependencies. Playwright is development-only.

## Run MIB Atlas step by step

These instructions assume the web server, PHP, PDO MySQL, Node.js, and
MySQL/MariaDB are already installed.

### 1. Enter the project directory

```bash
cd /path/to/mib-atlas
```

### 2. Add server-provided MIBs

Place any MIBs you want to provide below `server-mibs/`. Subdirectories may be
nested to any depth:

```text
server-mibs/
├── cisco/
│   └── ...
├── ietf/
│   └── ...
└── private-vendor/
    └── product/
        └── ...
```

The first directory below `server-mibs/` is used as the provider label. A MIB
placed directly in `server-mibs/` uses `Provided`.

File extensions do not matter. The generator reads files recursively and
indexes those containing a MIB module declaration. Hidden files and hidden
directories are skipped.

MIB originals are ignored by Git. This is intentional: keep the application
source repository independent from the deployment's MIB collection.

### 3. Generate the SQL database

```bash
npm run build:server-data
```

This creates `database/mib-atlas.sql`. The file is generated deployment data,
contains material derived from the local MIB collection, and is ignored by Git.
Regenerate it whenever MIB files or `parser.js` change.

The generator:

1. Finds MIBs recursively below `server-mibs/`.
2. Parses all modules together so imported symbols can resolve across files.
3. Builds module, search, detail, and OID-tree rows.
4. Includes every indexed MIB in the original-file download API.
5. Records source and parser SHA-256 hashes in database metadata.

### 4. Create the database

```bash
mysql -u root -p
```

```sql
CREATE DATABASE mib_atlas
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
EXIT;
```

The generated dump is a full replacement of the three `mib_atlas_*` tables: it
drops their old contents and schema before recreating them. Therefore, a MIB
removed from `server-mibs/` is also removed from MySQL when the newly generated
dump is imported. Back up an existing installation before importing it.

### 5. Import the generated data

```bash
mysql --default-character-set=utf8mb4 -u root -p mib_atlas \
  < database/mib-atlas.sql
```

Confirm the counts:

```bash
mysql -u root -p mib_atlas \
  -e "SELECT COUNT(*) AS modules FROM mib_atlas_modules; SELECT COUNT(*) AS definitions FROM mib_atlas_definitions;"
```

The results depend on the MIB collection supplied in step 2.

### 6. Create a read-only application user

```bash
mysql -u root -p
```

```sql
CREATE USER 'mib_atlas'@'127.0.0.1'
  IDENTIFIED BY 'replace-with-a-long-random-password';
GRANT SELECT ON mib_atlas.* TO 'mib_atlas'@'127.0.0.1';
EXIT;
```

Replace the host when PHP connects from another machine. The runtime API needs
only `SELECT`; generation and import use a separate administrative account.

### 7. Create `api/config.php`

```bash
cp api/config.example.php api/config.php
```

Edit the copy:

```php
<?php

declare(strict_types=1);

return [
    'db_dsn' => 'mysql:host=127.0.0.1;dbname=mib_atlas;charset=utf8mb4',
    'db_user' => 'mib_atlas',
    'db_password' => 'replace-with-a-long-random-password',
    'mib_root' => dirname(__DIR__) . '/server-mibs',
];
```

Because `config.php` lives in `api/`, `dirname(__DIR__)` resolves to the project
root. The default expression therefore points to the project's `server-mibs/`
directory regardless of where the project is installed.

`mib_root` must be the same source tree used to generate the imported SQL and
must be readable by PHP. If originals are stored elsewhere, replace the default
with their absolute directory. `api/config.php` is ignored by Git; never commit
real credentials.

### 8. Serve and verify

Point the web document root at the project and configure PHP execution for
`api/*.php`. The default API path is `./api`; change the
`mib-atlas-api-base` meta tag in `index.html` if needed.

For a trusted local check only:

```bash
php -S 127.0.0.1:8080
```

Then verify:

```bash
curl -fsS 'http://127.0.0.1:8080/api/modules.php'
curl -fsS 'http://127.0.0.1:8080/api/search.php?q=sysDescr&limit=5'
```

The first response should report the generated module count and
`"schemaVersion":2`. The built-in PHP server ignores `.htaccess`; never expose
that development command publicly.

## Updating the server MIB collection

1. Add, replace, or remove files below `server-mibs/`.
2. Run `npm run build:server-data`.
3. Import the new `database/mib-atlas.sql`.
4. Verify catalogue, search, tree, details, and downloads.

The MIB files and SQL dump must be deployed together. A database row pointing
at a missing or changed source file cannot be downloaded correctly.

## Original downloads and source protection

Every indexed server MIB is downloadable. `api/download.php` accepts a module
ID, resolves the database path below the configured `mib_root`, prevents
directory traversal, and streams the original file as an attachment.

Do not expose `server-mibs/` directly. The included root `.htaccess` denies
every non-root request below that directory. Apache deployments must enable
overrides. Use this equivalent rule with Nginx:

```nginx
location = /api/config.php {
    return 404;
}

location ^~ /server-mibs/ {
    return 404;
}
```

The strongest layout stores MIB originals outside the public document root and
sets `mib_root` to that absolute directory. The generator currently reads
`server-mibs/` in the project checkout, so copy or mount that exact tree at the
configured runtime location.

## PHP API

| Endpoint | Purpose |
| --- | --- |
| `api/modules.php` | Provided module catalogue and aggregate counts |
| `api/search.php` | Bounded, filtered definition search or module listing |
| `api/tree.php` | Immediate children for one numeric OID |
| `api/definition.php` | Rich details for one definition |
| `api/download.php` | Original MIB download |

Search responses default to 100 rows and are capped at 500. The browser asks
for bounded pages so broad searches do not create tens of thousands of DOM
nodes.

## Client-side privacy and storage

- User uploads are read with browser APIs and persisted only in the
  `mib-atlas` IndexedDB database.
- Uploaded source is parsed and searched locally.
- Uploaded symbols resolve only against built-in OID roots and other uploads.
- The global search text is sent to the PHP API and also matched against local
  uploads; uploaded file contents are not sent.
- API requests bypass the service-worker cache. Only the small application
  shell is cached.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js`, `favicon.ico` | Browser interface and API client |
| `parser.js`, `storage.js` | Local parser/resolver and IndexedDB layer |
| `api/` | PHP/MySQL endpoints and ignored runtime configuration |
| `scripts/build-server-data.mjs` | Recursive MIB-to-SQL generator |
| `database/README.md` | Generated database artifact notes |
| `server-mibs/` | Local, Git-ignored server MIB source tree |
| `PROJECT_CONTEXT.md` | Maintainer/LLM architectural handoff |
| `tests/` | Parser and browser regression tests with synthetic fixtures |

## Parser scope

The parser recognizes common SMIv1/SMIv2 declarations including
`OBJECT IDENTIFIER`, `OBJECT-TYPE`, module/object identities, notifications,
traps, groups, compliance declarations, and agent capabilities. It extracts
common clauses and resolves symbolic OIDs across modules.

It is pragmatic rather than a complete ASN.1 compiler. Malformed or unresolved
definitions remain visible instead of making an upload fatal.

## Testing

Install development dependencies and Playwright's Chromium build once:

```bash
npm install
npx playwright install chromium
```

Run all tests:

```bash
npm run test:all
```

Individual checks:

```bash
npm run test:unit
npm run test:e2e
node --check app.js
node --check scripts/build-server-data.mjs
find api -name '*.php' -exec php -l {} \;
```

The browser suite uses synthetic fixtures and a mock API. It does not require
production MIBs, PHP, MySQL, or network access.

## Licensing responsibility

MIB Atlas application code is MIT-licensed, but MIB files are separate works.
The repository intentionally includes neither server MIBs nor derived SQL.
Deployment operators are responsible for confirming that they may possess,
process, host, and offer each chosen MIB for download. Public availability on
another website is not by itself a redistribution license.

## AI development disclaimer

MIB Atlas was created primarily by an AI coding agent under human direction.
AI-generated code can contain mistakes. Review and test it for your environment,
especially its parser, security configuration, generated database, and your MIB
licensing obligations.

## License

MIB Atlas application code is available under the [MIT License](LICENSE). The
MIT License does not apply to MIBs supplied by a deployment operator.
