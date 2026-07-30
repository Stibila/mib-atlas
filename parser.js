const BUILTIN_ROOTS = [
  ["iso", "1"],
  ["org", "1.3"],
  ["dod", "1.3.6"],
  ["internet", "1.3.6.1"],
  ["directory", "1.3.6.1.1"],
  ["mgmt", "1.3.6.1.2"],
  ["mib-2", "1.3.6.1.2.1"],
  ["transmission", "1.3.6.1.2.1.10"],
  ["experimental", "1.3.6.1.3"],
  ["private", "1.3.6.1.4"],
  ["enterprises", "1.3.6.1.4.1"],
  ["security", "1.3.6.1.5"],
  ["snmpV2", "1.3.6.1.6"],
  ["snmpDomains", "1.3.6.1.6.1"],
  ["snmpProxys", "1.3.6.1.6.2"],
  ["snmpModules", "1.3.6.1.6.3"],
  ["zeroDotZero", "0.0"],
];

const DECLARATION_TYPES = [
  "OBJECT-TYPE",
  "MODULE-IDENTITY",
  "OBJECT-IDENTITY",
  "NOTIFICATION-TYPE",
  "TRAP-TYPE",
  "OBJECT-GROUP",
  "NOTIFICATION-GROUP",
  "MODULE-COMPLIANCE",
  "AGENT-CAPABILITIES",
];

function normalizeSpace(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function unquote(value = "") {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/""/g, '"')
      .replace(/\r?\n\s*/g, " ")
      .trim();
  }
  return trimmed;
}

function stripComments(source) {
  let result = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        result += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
      result += char;
      continue;
    }
    if (!quoted && char === "-" && source[index + 1] === "-") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    result += char;
  }
  return result;
}

function maskQuotedText(source) {
  let result = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        result += "  ";
        index += 1;
        continue;
      }
      quoted = !quoted;
      result += " ";
      continue;
    }
    result += quoted && char !== "\n" && char !== "\r" ? " " : char;
  }
  return result;
}

function findClause(body, keyword, boundaries) {
  const boundaryPattern = boundaries.join("|");
  const expression = new RegExp(
    `\\b${keyword}\\b\\s+([\\s\\S]*?)(?=\\s+\\b(?:${boundaryPattern})\\b\\s+|$)`,
    "i",
  );
  const match = body.match(expression);
  return match ? match[1].trim() : "";
}

function parseOidExpression(expression) {
  return expression
    .replace(/[{},]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const namedNumber = token.match(/^([A-Za-z][\w-]*)\((\d+)\)$/);
      if (namedNumber) return { name: namedNumber[1], number: namedNumber[2] };
      if (/^\d+$/.test(token)) return { number: token };
      return { name: token };
    });
}

function extractImports(cleanSource) {
  const imports = [];
  const block = cleanSource.match(/\bIMPORTS\b([\s\S]*?);/i)?.[1] || "";
  for (const match of block.matchAll(/([\w\s,-]+?)\s+FROM\s+([\w-]+)/gi)) {
    const names = match[1]
      .split(",")
      .map((name) => normalizeSpace(name))
      .filter(Boolean);
    imports.push({ module: match[2], names });
  }
  return imports;
}

function extractRevision(body) {
  const revisions = [...body.matchAll(/\bREVISION\s+"([^"]+)"/gi)];
  return revisions[0]?.[1] || "";
}

export function parseMib(source, fileName = "uploaded.mib") {
  const cleanSource = stripComments(source);
  const definitionSource = cleanSource.replace(/\bIMPORTS\b[\s\S]*?;/i, "");
  const structuralSource = maskQuotedText(definitionSource);
  const moduleMatch = cleanSource.match(/^\s*([\w-]+)\s+DEFINITIONS\b[\s\S]*?::=\s*BEGIN\b/i);
  const moduleName = moduleMatch?.[1] || fileName.replace(/\.[^.]+$/, "") || "UNKNOWN-MODULE";
  const imports = extractImports(cleanSource);
  const definitions = [];

  const oidRegex = /(^|\n)\s*([\w-]+)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{([^}]+)\}/gi;
  for (const match of structuralSource.matchAll(oidRegex)) {
    const originalDeclaration = definitionSource.slice(
      match.index,
      match.index + match[0].length,
    );
    definitions.push({
      name: match[2],
      type: "OBJECT IDENTIFIER",
      oidParts: parseOidExpression(match[3]),
      module: moduleName,
      fileName,
      raw: normalizeSpace(originalDeclaration),
      description: "",
      syntax: "",
      access: "",
      status: "",
      index: "",
    });
  }

  const typePattern = DECLARATION_TYPES.join("|");
  const declarationRegex = new RegExp(
    `(^|\\n)\\s*([\\w-]+)\\s+(${typePattern})\\b([\\s\\S]*?)::=\\s*\\{([^}]+)\\}`,
    "gi",
  );
  const boundaries = [
    "SYNTAX",
    "UNITS",
    "MAX-ACCESS",
    "ACCESS",
    "STATUS",
    "DESCRIPTION",
    "REFERENCE",
    "INDEX",
    "AUGMENTS",
    "DEFVAL",
    "OBJECTS",
    "NOTIFICATIONS",
    "PRODUCT-RELEASE",
    "SUPPORTS",
    "INCLUDES",
    "VARIATION",
    "REVISION",
    "LAST-UPDATED",
    "ORGANIZATION",
    "CONTACT-INFO",
  ];

  for (const match of structuralSource.matchAll(declarationRegex)) {
    const [, , name, type, , oidExpression] = match;
    const originalDeclaration = definitionSource.slice(
      match.index,
      match.index + match[0].length,
    );
    const typeMatch = originalDeclaration.match(
      new RegExp(`\\b${type.replace("-", "\\-")}\\b`, "i"),
    );
    const assignmentIndex = originalDeclaration.lastIndexOf("::=");
    const body = originalDeclaration.slice(
      (typeMatch?.index || 0) + (typeMatch?.[0].length || 0),
      assignmentIndex,
    );
    definitions.push({
      name,
      type: type.toUpperCase(),
      oidParts: parseOidExpression(oidExpression),
      module: moduleName,
      fileName,
      raw: originalDeclaration.trim(),
      description: unquote(findClause(body, "DESCRIPTION", boundaries)),
      syntax: normalizeSpace(findClause(body, "SYNTAX", boundaries)),
      access: normalizeSpace(
        findClause(body, "MAX-ACCESS", boundaries) || findClause(body, "ACCESS", boundaries),
      ),
      status: normalizeSpace(findClause(body, "STATUS", boundaries)),
      index: normalizeSpace(
        findClause(body, "INDEX", boundaries) || findClause(body, "AUGMENTS", boundaries),
      ),
      units: unquote(findClause(body, "UNITS", boundaries)),
      revision: extractRevision(body),
    });
  }

  const seen = new Set();
  const uniqueDefinitions = definitions.filter((definition) => {
    const key = `${definition.name}:${definition.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    name: moduleName,
    fileName,
    imports,
    definitions: uniqueDefinitions,
    source,
    parseWarnings: moduleMatch ? [] : ["No ASN.1 module header was found; the filename was used."],
  };
}

function resolveDefinition(definition, symbols) {
  const parts = definition.oidParts;
  if (!parts.length) return "";
  const numbers = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.name && part.number) {
      numbers.push(part.number);
      continue;
    }
    if (part.name && symbols.has(part.name)) {
      const base = symbols.get(part.name).split(".");
      if (!numbers.length) {
        numbers.push(...base);
      } else {
        const sharedLength = Math.min(numbers.length, base.length);
        const compatible = numbers
          .slice(0, sharedLength)
          .every((number, baseIndex) => base[baseIndex] === number);
        if (!compatible) return "";
        if (numbers.length < base.length) numbers.push(...base.slice(numbers.length));
      }
      if (part.number && numbers.at(-1) !== part.number) numbers.push(part.number);
      continue;
    }
    if (part.name && part.number) {
      numbers.push(part.number);
      continue;
    }
    return "";
  }
  return numbers.join(".");
}

export function buildRegistry(modules) {
  const symbols = new Map(BUILTIN_ROOTS);
  const definitions = modules.flatMap((module) =>
    module.definitions.map((definition) => ({ ...definition })),
  );

  for (const definition of definitions) {
    if (definition.oid) symbols.set(definition.name, definition.oid);
  }

  let changed = true;
  let passes = 0;
  while (changed && passes < definitions.length + 2) {
    changed = false;
    passes += 1;
    for (const definition of definitions) {
      if (definition.oid) continue;
      const oid = resolveDefinition(definition, symbols);
      if (oid) {
        definition.oid = oid;
        symbols.set(definition.name, oid);
        changed = true;
      }
    }
  }

  for (const definition of definitions) {
    definition.oid ||= "";
    definition.parentOid = definition.oid ? definition.oid.split(".").slice(0, -1).join(".") : "";
    definition.depth = definition.oid ? definition.oid.split(".").length : 0;
  }

  definitions.sort((a, b) => {
    if (!a.oid && !b.oid) return a.name.localeCompare(b.name);
    if (!a.oid) return 1;
    if (!b.oid) return -1;
    const aParts = a.oid.split(".").map(Number);
    const bParts = b.oid.split(".").map(Number);
    for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
      if (aParts[index] === undefined) return -1;
      if (bParts[index] === undefined) return 1;
      if (aParts[index] !== bParts[index]) return aParts[index] - bParts[index];
    }
    return a.name.localeCompare(b.name);
  });

  const byOid = new Map();
  for (const definition of definitions) {
    if (!definition.oid) continue;
    const existing = byOid.get(definition.oid) || [];
    existing.push(definition);
    byOid.set(definition.oid, existing);
  }

  return { modules, definitions, symbols, byOid };
}

export function matchesDefinition(definition, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    definition.name,
    definition.oid,
    definition.module,
    definition.type,
    definition.syntax,
    definition.description,
  ].some((value) => value?.toLowerCase().includes(needle));
}

const BUILTIN_ROOT_DESCRIPTIONS = {
  iso: "Top-level object identifier arc assigned to the International Organization for Standardization (ISO).",
  org: "Organizations registered beneath the ISO object identifier arc.",
  dod: "U.S. Department of Defense arc containing the Internet object identifier tree.",
  internet: "Root of the Internet object identifier namespace.",
  directory: "Internet directory-services namespace.",
  mgmt: "Internet network-management namespace.",
  "mib-2": "Standard SNMP MIB-2 management objects.",
  transmission: "Media-specific transmission MIB modules.",
  experimental: "Internet experimental objects.",
  private: "Private organization objects.",
  enterprises: "Private enterprise object identifiers assigned by IANA.",
  security: "Internet security objects.",
  snmpV2: "SNMPv2 objects and infrastructure.",
  snmpDomains: "SNMP transport-domain identifiers.",
  snmpProxys: "SNMP proxy identifiers.",
  snmpModules: "Standard SNMP module definitions.",
  zeroDotZero: "Special null OID used when no applicable object identifier is available.",
};

export const builtinRoots = BUILTIN_ROOTS.map(([name, oid]) => ({
  name,
  oid,
  type: "NAMESPACE NODE",
  module: "Built-in OID tree",
  source: "builtin",
  description: BUILTIN_ROOT_DESCRIPTIONS[name],
  syntax: "",
  access: "",
  status: "",
  index: "",
  raw: `${name} → ${oid}`,
}));
