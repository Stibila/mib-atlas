import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry, builtinRoots, parseMib } from "../parser.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libraryRoot = resolve(projectRoot, "server-mibs");
const parserPath = resolve(projectRoot, "parser.js");
const sqlPath = resolve(projectRoot, "database", "mib-atlas.sql");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\0", "\\0")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\u001a", "\\Z")
    .replaceAll("'", "''")}'`;
}

function isMibSource(source) {
  return /\bDEFINITIONS\s*::=\s*BEGIN\b/i.test(source);
}

function providerFromPath(path) {
  if (!path.includes("/")) return "Provided";
  const directory = path.split("/", 1)[0];
  return directory === directory.toLowerCase() ? directory.toUpperCase() : directory;
}

function insertBatches(lines, table, columns, rows, batchSize = 200) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    lines.push(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${batch.join(",\n")};`,
    );
  }
}

const candidates = (await listFiles(libraryRoot))
  .map((path) => relative(libraryRoot, path).split(sep).join("/"))
  .sort();
const sourceFiles = [];
for (const path of candidates) {
  const source = await readFile(resolve(libraryRoot, path), "utf8");
  if (!isMibSource(source)) continue;
  sourceFiles.push(path);
}

const parsedModules = [];
const moduleItems = [];
const sourceHash = createHash("sha256");

for (const path of sourceFiles) {
  const sourceBuffer = await readFile(resolve(libraryRoot, path));
  const source = sourceBuffer.toString("utf8");
  const name = basename(path);
  const provider = providerFromPath(path);
  if (path.length > 512 || name.length > 255 || provider.length > 64) {
    throw new Error(`MIB path exceeds a database field limit: ${path}`);
  }
  const item = {
    path,
    name,
    provider,
    size: sourceBuffer.byteLength,
  };
  const parsed = parseMib(source, item.name);
  parsed.definitions = parsed.definitions.map((definition) => ({
    ...definition,
    serverPath: path,
  }));
  parsedModules.push({
    item,
    parsed,
  });
  moduleItems.push(item);
  sourceHash.update(path);
  sourceHash.update("\0");
  sourceHash.update(sourceBuffer);
  sourceHash.update("\0");
}

const registry = buildRegistry(parsedModules.map(({ parsed }) => parsed));
const definitionsByPath = new Map();
for (const definition of registry.definitions) {
  const bucket = definitionsByPath.get(definition.serverPath) || [];
  bucket.push(definition);
  definitionsByPath.set(definition.serverPath, bucket);
}

const navigableOids = new Set([
  ...builtinRoots.map((definition) => definition.oid),
  ...registry.definitions.map((definition) => definition.oid).filter(Boolean),
]);
function treeParentOid(oid) {
  if (!oid) return "";
  const parts = oid.split(".");
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join(".");
    if (navigableOids.has(candidate)) return candidate;
  }
  return "";
}

function sortableOid(oid) {
  return oid
    ? oid
        .split(".")
        .map((part) => part.padStart(10, "0"))
        .join(".")
    : "";
}

const sourceSha256 = sourceHash.digest("hex");
const parserSha256 = createHash("sha256").update(await readFile(parserPath)).digest("hex");

const moduleRows = [];
const definitionRows = [];
let definitionId = 1;
for (let moduleIndex = 0; moduleIndex < parsedModules.length; moduleIndex += 1) {
  const moduleId = moduleIndex + 1;
  const { item, parsed } = parsedModules[moduleIndex];
  const definitions = definitionsByPath.get(item.path) || [];
  moduleRows.push(
    `(${[
      moduleId,
      sqlString(item.path),
      sqlString(item.name),
      sqlString(parsed.name),
      sqlString(item.provider),
      item.size,
      definitions.length,
    ].join(", ")})`,
  );

  for (const definition of definitions) {
    const description = definition.description;
    const syntax = definition.syntax;
    const access = definition.access;
    const status = definition.status;
    const index = definition.index;
    const units = definition.units;
    const revision = definition.revision;
    const raw = definition.raw;
    const searchText = [
      definition.name,
      definition.oid,
      parsed.name,
      definition.type,
      syntax,
      description,
    ]
      .filter(Boolean)
      .join(" ");
    definitionRows.push(
      `(${[
        definitionId,
        moduleId,
        sqlString(definition.name),
        sqlString(definition.type),
        sqlString(definition.oid),
        sqlString(sortableOid(definition.oid)),
        sqlString(definition.parentOid),
        sqlString(treeParentOid(definition.oid)),
        sqlString(syntax),
        sqlString(access),
        sqlString(status),
        sqlString(index),
        sqlString(units),
        sqlString(revision),
        sqlString(description),
        sqlString(raw),
        sqlString(searchText),
      ].join(", ")})`,
    );
    definitionId += 1;
  }
}

const sql = [
  "-- Generated by scripts/build-server-data.mjs. Do not edit by hand.",
  "-- Import into an existing MySQL 8+/MariaDB database selected for MIB Atlas.",
  "-- This is a full replacement: all previous MIB Atlas rows are removed first.",
  "SET NAMES utf8mb4;",
  "SET FOREIGN_KEY_CHECKS = 0;",
  "DROP TABLE IF EXISTS mib_atlas_definitions;",
  "DROP TABLE IF EXISTS mib_atlas_modules;",
  "DROP TABLE IF EXISTS mib_atlas_metadata;",
  "CREATE TABLE mib_atlas_metadata (",
  "  metadata_key VARCHAR(64) PRIMARY KEY,",
  "  metadata_value VARCHAR(255) NOT NULL",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
  "CREATE TABLE mib_atlas_modules (",
  "  id INT UNSIGNED PRIMARY KEY,",
  "  source_path VARCHAR(512) NOT NULL UNIQUE,",
  "  file_name VARCHAR(255) NOT NULL,",
  "  module_name VARCHAR(255) NOT NULL,",
  "  provider VARCHAR(64) NOT NULL,",
  "  source_size INT UNSIGNED NOT NULL,",
  "  definition_count INT UNSIGNED NOT NULL DEFAULT 0,",
  "  KEY idx_module_name (module_name),",
  "  KEY idx_provider_name (provider, file_name)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
  "CREATE TABLE mib_atlas_definitions (",
  "  id BIGINT UNSIGNED PRIMARY KEY,",
  "  module_id INT UNSIGNED NOT NULL,",
  "  name VARCHAR(255) NOT NULL,",
  "  declaration_type VARCHAR(64) NOT NULL,",
  "  oid VARCHAR(255) NOT NULL DEFAULT '',",
  "  oid_sort VARCHAR(2048) NOT NULL DEFAULT '',",
  "  parent_oid VARCHAR(255) NOT NULL DEFAULT '',",
  "  tree_parent_oid VARCHAR(255) NOT NULL DEFAULT '',",
  "  syntax_text TEXT NOT NULL,",
  "  access_text VARCHAR(255) NOT NULL DEFAULT '',",
  "  status_text VARCHAR(255) NOT NULL DEFAULT '',",
  "  index_text TEXT NOT NULL,",
  "  units_text VARCHAR(255) NOT NULL DEFAULT '',",
  "  revision_text VARCHAR(64) NOT NULL DEFAULT '',",
  "  description_text MEDIUMTEXT NOT NULL,",
  "  raw_declaration MEDIUMTEXT NOT NULL,",
  "  search_text MEDIUMTEXT NOT NULL,",
  "  CONSTRAINT fk_definition_module FOREIGN KEY (module_id)",
  "    REFERENCES mib_atlas_modules(id) ON DELETE CASCADE,",
  "  KEY idx_tree_parent (tree_parent_oid, oid),",
  "  KEY idx_module_oid (module_id, oid),",
  "  KEY idx_name (name),",
  "  KEY idx_oid (oid),",
  "  FULLTEXT KEY ft_search (search_text)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
  `INSERT INTO mib_atlas_metadata (metadata_key, metadata_value) VALUES
('schema_version', '2'),
('source_count', ${sqlString(moduleItems.length)}),
('definition_count', ${sqlString(definitionRows.length)}),
('resolved_count', ${sqlString(registry.definitions.filter((definition) => definition.oid).length)}),
('source_sha256', ${sqlString(sourceSha256)}),
('parser_sha256', ${sqlString(parserSha256)});`,
];
insertBatches(
  sql,
  "mib_atlas_modules",
  [
    "id",
    "source_path",
    "file_name",
    "module_name",
    "provider",
    "source_size",
    "definition_count",
  ],
  moduleRows,
);
insertBatches(
  sql,
  "mib_atlas_definitions",
  [
    "id",
    "module_id",
    "name",
    "declaration_type",
    "oid",
    "oid_sort",
    "parent_oid",
    "tree_parent_oid",
    "syntax_text",
    "access_text",
    "status_text",
    "index_text",
    "units_text",
    "revision_text",
    "description_text",
    "raw_declaration",
    "search_text",
  ],
  definitionRows,
);
sql.push("SET FOREIGN_KEY_CHECKS = 1;", "");

await writeFile(sqlPath, sql.join("\n"));

console.log(
  `Wrote database/mib-atlas.sql with ${moduleRows.length} modules and ${definitionRows.length} definitions.`,
);
