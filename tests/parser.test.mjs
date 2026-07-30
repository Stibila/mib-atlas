import test from "node:test";
import assert from "node:assert/strict";

import { buildRegistry, builtinRoots, matchesDefinition, parseMib } from "../parser.js";

const baseMib = `
ACME-BASE-MIB DEFINITIONS ::= BEGIN
IMPORTS
  enterprises, OBJECT-TYPE, MODULE-IDENTITY
    FROM SNMPv2-SMI;

acme MODULE-IDENTITY
  LAST-UPDATED "202607300000Z"
  ORGANIZATION "Acme Networks"
  DESCRIPTION "Root module for Acme devices."
  REVISION "202607300000Z"
  DESCRIPTION "Initial revision."
  ::= { enterprises 424242 }

acmeProducts OBJECT IDENTIFIER ::= { acme 1 }

acmeTemperature OBJECT-TYPE
  SYNTAX Integer32
  UNITS "degrees Celsius"
  MAX-ACCESS read-only
  STATUS current
  DESCRIPTION
    "Current chassis temperature."
  ::= { acmeProducts 7 }
END
`;

test("parses common declarations and metadata", () => {
  const module = parseMib(baseMib, "ACME-BASE-MIB.mib");
  assert.equal(module.name, "ACME-BASE-MIB");
  assert.equal(module.definitions.length, 3);

  const temperature = module.definitions.find((item) => item.name === "acmeTemperature");
  assert.equal(temperature.type, "OBJECT-TYPE");
  assert.equal(temperature.syntax, "Integer32");
  assert.equal(temperature.units, "degrees Celsius");
  assert.equal(temperature.access, "read-only");
  assert.equal(temperature.status, "current");
  assert.equal(temperature.description, "Current chassis temperature.");
});

test("does not treat IMPORTS as a MODULE-IDENTITY declaration", () => {
  const module = parseMib(`
    IMPORT-EDGE-MIB DEFINITIONS ::= BEGIN
    IMPORTS
      MODULE-IDENTITY, OBJECT-TYPE, mib-2
        FROM SNMPv2-SMI;

    importEdge MODULE-IDENTITY
      STATUS current
      DESCRIPTION "Import edge-case root."
      ::= { mib-2 999 }
    END
  `, "import-edge.mib");

  assert.equal(module.definitions.some((item) => item.name === "IMPORTS"), false);
  assert.equal(module.definitions.some((item) => item.name === "importEdge"), true);
});

test("resolves built-in roots and a symbolic chain", () => {
  const registry = buildRegistry([parseMib(baseMib, "base.mib")]);
  assert.equal(registry.symbols.get("acme"), "1.3.6.1.4.1.424242");
  assert.equal(registry.symbols.get("acmeProducts"), "1.3.6.1.4.1.424242.1");
  assert.equal(registry.symbols.get("acmeTemperature"), "1.3.6.1.4.1.424242.1.7");
});

test("resolves references across modules regardless of load order", () => {
  const extension = parseMib(`
    ACME-EXT-MIB DEFINITIONS ::= BEGIN
    acmeFans OBJECT IDENTIFIER ::= { acmeProducts 9 }
    fanSpeed OBJECT-TYPE
      SYNTAX Gauge32
      MAX-ACCESS read-only
      STATUS current
      DESCRIPTION "Fan speed."
      ::= { acmeFans 1 }
    END
  `, "extension.mib");
  const base = parseMib(baseMib, "base.mib");
  const registry = buildRegistry([extension, base]);
  assert.equal(registry.symbols.get("fanSpeed"), "1.3.6.1.4.1.424242.1.9.1");
});

test("uses pre-resolved index definitions to resolve uploaded modules", () => {
  const indexed = {
    name: "INDEXED-MIB",
    definitions: [
      {
        name: "indexedRoot",
        type: "OBJECT IDENTIFIER",
        oid: "1.3.6.1.4.1.55555",
        oidParts: [],
        module: "INDEXED-MIB",
      },
    ],
  };
  const uploaded = parseMib(`
    UPLOADED-MIB DEFINITIONS ::= BEGIN
    uploadedObject OBJECT IDENTIFIER ::= { indexedRoot 7 }
    END
  `, "uploaded.mib");
  const registry = buildRegistry([indexed, uploaded]);

  assert.equal(registry.symbols.get("uploadedObject"), "1.3.6.1.4.1.55555.7");
});

test("preserves unresolved definitions", () => {
  const module = parseMib(`
    BROKEN-MIB DEFINITIONS ::= BEGIN
    orphan OBJECT IDENTIFIER ::= { missingParent 3 }
    END
  `, "broken.mib");
  const registry = buildRegistry([module]);
  assert.equal(registry.definitions[0].name, "orphan");
  assert.equal(registry.definitions[0].oid, "");
});

test("strips comments but preserves comment-like text in quoted descriptions", () => {
  const module = parseMib(`
    QUOTES-MIB DEFINITIONS ::= BEGIN
    quoteRoot OBJECT IDENTIFIER ::= { enterprises 99 } -- trailing comment
    quoted OBJECT-TYPE
      SYNTAX INTEGER
      MAX-ACCESS read-only
      STATUS current
      DESCRIPTION "Keep -- these characters."
      ::= { quoteRoot 1 }
    END
  `, "quotes.mib");
  const quoted = module.definitions.find((item) => item.name === "quoted");
  assert.equal(quoted.description, "Keep -- these characters.");
});

test("ignores example declarations embedded in quoted descriptions", () => {
  const module = parseMib(`
    QUOTED-DECLARATION-MIB DEFINITIONS ::= BEGIN
    quotedRoot OBJECT IDENTIFIER ::= { enterprises 100 }
    quotedExample OBJECT-TYPE
      SYNTAX OBJECT IDENTIFIER
      MAX-ACCESS read-only
      STATUS current
      DESCRIPTION
        "The special value:
           noValue OBJECT IDENTIFIER ::= { 0 0 }
         indicates that no value is available."
      ::= { quotedRoot 1 }
    END
  `, "quoted-declaration.mib");
  const registry = buildRegistry([module]);

  assert.equal(module.definitions.some((item) => item.name === "noValue"), false);
  assert.equal(registry.symbols.get("quotedExample"), "1.3.6.1.4.1.100.1");
});

test("search matches OIDs and descriptions", () => {
  const registry = buildRegistry([parseMib(baseMib, "base.mib")]);
  const temperature = registry.definitions.find((item) => item.name === "acmeTemperature");
  assert.equal(matchesDefinition(temperature, "chassis"), true);
  assert.equal(matchesDefinition(temperature, "424242.1.7"), true);
  assert.equal(matchesDefinition(temperature, "unrelated"), false);
});

test("built-in roots are explicit namespace nodes, not fallback descriptions", () => {
  const enterprises = builtinRoots.find((item) => item.name === "enterprises");
  assert.equal(enterprises.source, "builtin");
  assert.equal(enterprises.type, "NAMESPACE NODE");
  assert.match(enterprises.description, /enterprise object identifiers/i);
  assert.equal(builtinRoots.some((item) => item.description === "Well-known OID namespace root."), false);
});
