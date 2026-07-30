import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildRegistry, parseMib } from "../parser.js";

test("resolves a fully qualified named-number OID path", () => {
  const module = parseMib(`
    QUALIFIED-PATH-MIB DEFINITIONS ::= BEGIN
    qualifiedRoot OBJECT IDENTIFIER ::= {
      iso(1) org(3) dod(6) internet(1) private(4) enterprises(1) 77777
    }
    qualifiedLeaf OBJECT IDENTIFIER ::= { qualifiedRoot 9 }
    END
  `, "qualified-path.mib");
  const registry = buildRegistry([module]);

  assert.equal(registry.symbols.get("qualifiedRoot"), "1.3.6.1.4.1.77777");
  assert.equal(registry.symbols.get("qualifiedLeaf"), "1.3.6.1.4.1.77777.9");
});

test("retains every definition that shares an OID", () => {
  const registry = buildRegistry([
    parseMib(`
      ALIASES-MIB DEFINITIONS ::= BEGIN
      aliasRoot OBJECT IDENTIFIER ::= { enterprises 77778 }
      firstAlias OBJECT IDENTIFIER ::= { aliasRoot 1 }
      secondAlias OBJECT IDENTIFIER ::= { aliasRoot 1 }
      END
    `, "aliases.mib"),
  ]);

  const aliases = registry.byOid.get("1.3.6.1.4.1.77778.1");
  assert.deepEqual(aliases.map((definition) => definition.name), [
    "firstAlias",
    "secondAlias",
  ]);
});

test("parses legacy ACCESS and multiline metadata", () => {
  const module = parseMib(`
    LEGACY-METADATA-MIB DEFINITIONS ::= BEGIN
    legacyRoot OBJECT IDENTIFIER ::= { enterprises 77779 }
    legacyObject OBJECT-TYPE
      SYNTAX OCTET STRING
      ACCESS read-only
      STATUS mandatory
      DESCRIPTION
        "A legacy
         multiline description."
      INDEX {
        legacyObject
      }
      ::= { legacyRoot 1 }
    END
  `, "legacy-metadata.mib");
  const definition = module.definitions.find((item) => item.name === "legacyObject");

  assert.equal(definition.access, "read-only");
  assert.equal(definition.status, "mandatory");
  assert.equal(definition.description, "A legacy multiline description.");
  assert.equal(definition.index, "{ legacyObject }");
});

test("keeps empty descriptions empty instead of inventing placeholder prose", () => {
  const module = parseMib(`
    EMPTY-DESCRIPTION-MIB DEFINITIONS ::= BEGIN
    emptyRoot OBJECT IDENTIFIER ::= { enterprises 77780 }
    emptyObject OBJECT-TYPE
      SYNTAX INTEGER
      MAX-ACCESS read-only
      STATUS current
      DESCRIPTION ""
      ::= { emptyRoot 1 }
    END
  `, "empty-description.mib");

  assert.equal(
    module.definitions.find((definition) => definition.name === "emptyObject").description,
    "",
  );
});

test("preserves cyclic definitions as unresolved without looping", () => {
  const registry = buildRegistry([
    parseMib(`
      CYCLIC-MIB DEFINITIONS ::= BEGIN
      cycleA OBJECT IDENTIFIER ::= { cycleB 1 }
      cycleB OBJECT IDENTIFIER ::= { cycleA 1 }
      END
    `, "cyclic.mib"),
  ]);

  assert.deepEqual(
    registry.definitions.map(({ name, oid }) => ({ name, oid })),
    [
      { name: "cycleA", oid: "" },
      { name: "cycleB", oid: "" },
    ],
  );
});

test("falls back to the filename and reports a missing module header", () => {
  const module = parseMib(
    "fallbackRoot OBJECT IDENTIFIER ::= { enterprises 77781 }",
    "FALLBACK-MIB.txt",
  );

  assert.equal(module.name, "FALLBACK-MIB");
  assert.deepEqual(module.parseWarnings, [
    "No ASN.1 module header was found; the filename was used.",
  ]);
});

test("the browser workflow fixture stays fully resolvable", async () => {
  const source = await readFile(
    new URL("./fixtures/WORKFLOW-TEST-MIB.mib", import.meta.url),
    "utf8",
  );
  const module = parseMib(source, "WORKFLOW-TEST-MIB.mib");
  const registry = buildRegistry([module]);

  assert.equal(module.definitions.length, 7);
  assert.equal(registry.definitions.every((definition) => definition.oid), true);
  assert.equal(
    registry.symbols.get("workflowTemperature"),
    "1.3.6.1.4.1.424242.1.1.7",
  );
});
