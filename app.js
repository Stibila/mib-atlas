import { buildRegistry, matchesDefinition, parseMib } from "./parser.js";
import { clearFiles, deleteFile, loadFiles, saveFiles } from "./storage.js";

const elements = {
  search: document.querySelector("#search-input"),
  fileInput: document.querySelector("#file-input"),
  upload: document.querySelector("#upload-button"),
  clear: document.querySelector("#clear-button"),
  dropZone: document.querySelector("#drop-zone"),
  userModuleList: document.querySelector("#user-module-list"),
  userModuleCount: document.querySelector("#user-module-count"),
  serverModuleList: document.querySelector("#server-module-list"),
  serverModuleCount: document.querySelector("#server-module-count"),
  catalogSearch: document.querySelector("#catalog-search"),
  scopeLabel: document.querySelector("#scope-label"),
  scopeTitle: document.querySelector("#scope-title"),
  objectBrowser: document.querySelector("#object-browser"),
  objectStat: document.querySelector("#object-stat"),
  resolvedStat: document.querySelector("#resolved-stat"),
  unresolvedStat: document.querySelector("#unresolved-stat"),
  details: document.querySelector("#details-content"),
  rowTooltip: document.querySelector("#row-tooltip"),
  expand: document.querySelector("#expand-button"),
  theme: document.querySelector("#theme-button"),
  toastRegion: document.querySelector("#toast-region"),
  confirmDialog: document.querySelector("#confirm-dialog"),
};

const API_BASE =
  document.querySelector('meta[name="mib-atlas-api-base"]')?.content.replace(/\/$/, "") ||
  "./api";
const SERVER_PAGE_SIZE = 200;
const MODULE_TREE_PAGE_SIZE = 500;
const LOCAL_RESULT_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 180;
const STORAGE_KEYS = { theme: "mib-atlas-theme" };

const state = {
  files: [],
  userModules: [],
  localRegistry: buildRegistry([]),
  serverCatalog: [],
  serverDefinitionCount: 0,
  serverResolvedCount: 0,
  serverReady: false,
  serverResults: [],
  serverCounts: { total: 0, resolved: 0, unresolved: 0 },
  serverHasMore: false,
  serverLoading: false,
  serverError: "",
  serverRequestId: 0,
  treeDefinitions: new Map(),
  loadedTreeParents: new Set(),
  loadingTreeParents: new Set(),
  definitionDetails: new Map(),
  catalogQuery: "",
  scope: { kind: "none", moduleId: 0, moduleKey: "", name: "" },
  selectedKey: "",
  query: "",
  filter: "all",
  view: "tree",
  viewBeforeSearch: "tree",
  expanded: new Set(["1", "1.3", "1.3.6", "1.3.6.1"]),
};

let searchTimer = 0;
let serverSearchController = null;
let hoveredRow = null;

const icons = {
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="m4 7 8 4 8-4M12 21V11"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
  tree:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v16m0-11h5m-5 7h5m0-10v6m0 0h7m-7 0v6h7"/></svg>',
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function apiUrl(endpoint, parameters = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`, window.location.href);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== "" && value !== null && value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function fetchJson(endpoint, parameters = {}, signal) {
  const response = await fetch(apiUrl(endpoint, parameters), {
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function downloadUrl(moduleId) {
  return apiUrl("download.php", { module_id: moduleId }).toString();
}

function definitionKey(definition) {
  if (definition.source === "server") return `server::${definition.definitionId}`;
  return `${definition.source || "builtin"}::${definition.module}::${definition.name}::${definition.oid}`;
}

function moduleKey(module) {
  return `user::${module.name || module.module}`;
}

function annotateUserModule(module) {
  module.source = "user";
  module.definitions = module.definitions.map((definition) => ({
    ...definition,
    source: "user",
  }));
  return module;
}

function normalizeServerDefinition(definition) {
  return {
    name: definition.name || "",
    type: definition.type || "",
    oid: definition.oid || "",
    parentOid: definition.parentOid || "",
    treeParentOid: definition.treeParentOid || "",
    module: definition.module || "",
    fileName: definition.fileName || "",
    source: "server",
    provider: definition.provider || "",
    definitionId: Number(definition.id),
    moduleId: Number(definition.moduleId),
    downloadable: Boolean(definition.downloadable),
    detailsAvailable: Boolean(definition.detailsAvailable),
    hasChildren: Boolean(definition.hasChildren),
    syntax: definition.syntax || "",
    access: definition.access || "",
    status: definition.status || "",
    index: definition.index || "",
    units: definition.units || "",
    revision: definition.revision || "",
    description: definition.description || "",
    raw: definition.raw || "",
  };
}

function typeCategory(definition) {
  if (definition.type.includes("NOTIFICATION") || definition.type === "TRAP-TYPE") {
    return "notification";
  }
  if (definition.type === "OBJECT-TYPE") return "object";
  return "identity";
}

function typeInitial(definition) {
  const category = typeCategory(definition);
  return category === "notification" ? "N" : category === "object" ? "O" : "I";
}

function renderRowDescription(definition) {
  const description = String(definition.description || "").trim();
  return `<span class="row-description${description ? "" : " empty"}">${escapeHtml(
    description || "No description provided.",
  )}</span>`;
}

function matchesFilter(definition) {
  if (state.filter === "all") return true;
  if (state.filter === "identity") {
    return !["OBJECT-TYPE", "NOTIFICATION-TYPE", "TRAP-TYPE"].includes(definition.type);
  }
  return definition.type === state.filter;
}

function toast(message, isError = false) {
  const item = document.createElement("div");
  item.className = `toast${isError ? " error" : ""}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 3500);
}

function rebuildLocal() {
  state.userModules = state.files.map((file) =>
    annotateUserModule(parseMib(file.content, file.name)),
  );
  state.localRegistry = buildRegistry(state.userModules);
  if (
    state.scope.kind === "user" &&
    !state.userModules.some((module) => moduleKey(module) === state.scope.moduleKey)
  ) {
    state.scope = { kind: "none", moduleId: 0, moduleKey: "", name: "" };
  }
}

function localDefinitions() {
  return state.localRegistry.definitions.filter((definition) => {
    const globalSearch = Boolean(state.query.trim());
    if (!globalSearch && state.scope.kind === "none") return false;
    if (
      !globalSearch &&
      state.scope.kind === "user" &&
      `user::${definition.module}` !== state.scope.moduleKey
    ) {
      return false;
    }
    if (!globalSearch && state.scope.kind === "server") return false;
    return matchesFilter(definition) && matchesDefinition(definition, state.query);
  });
}

function resolvedDefinitionsForUserModule(module) {
  if (!module) return [];
  return state.localRegistry.definitions.filter(
    (definition) => definition.module === module.name,
  );
}

function renderModules() {
  const catalogNeedle = state.catalogQuery.trim().toLowerCase();
  const visibleCatalog = state.serverCatalog.filter((item) => {
    if (!catalogNeedle) return true;
    return `${item.name} ${item.module} ${item.provider}`.toLowerCase().includes(catalogNeedle);
  });

  elements.userModuleCount.textContent = state.userModules.length;
  elements.clear.disabled = state.userModules.length === 0;
  elements.userModuleList.classList.toggle("has-modules", state.userModules.length > 0);
  elements.userModuleList.innerHTML = state.userModules.length
    ? state.userModules
        .map((module) => {
          const key = moduleKey(module);
          const active =
            state.scope.kind === "user" && key === state.scope.moduleKey ? " active" : "";
          return `
            <div class="user-module-row">
              <button class="module-row${active}" data-module="${escapeHtml(key)}" type="button"
                title="${escapeHtml(module.fileName)}">
                <span class="module-glyph">MIB</span>
                <span class="module-name">${escapeHtml(module.name)}</span>
                <span class="module-object-count">${module.definitions.length}</span>
              </button>
              <button class="module-remove" data-remove-file="${escapeHtml(module.fileName)}"
                type="button" title="Remove ${escapeHtml(module.name)}"
                aria-label="Remove ${escapeHtml(module.name)}">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>`;
        })
        .join("")
    : '<p class="user-module-empty">No uploaded MIBs yet.</p>';

  elements.serverModuleCount.textContent = state.serverReady
    ? state.serverCatalog.length
    : state.serverError
      ? "!"
      : "…";
  elements.serverModuleCount.title = state.serverError || "Server-provided MIBs";
  elements.serverModuleList.innerHTML = state.serverError
    ? `<p class="user-module-empty">${escapeHtml(state.serverError)}</p>`
    : visibleCatalog
        .map((item) => {
          const active =
            state.scope.kind === "server" && state.scope.moduleId === item.id ? " active" : "";
          return `
            <div class="server-module-row">
              <button class="module-row${active}" data-server-module="${item.id}"
                type="button" title="${escapeHtml(item.provider)} · ${escapeHtml(item.name)}">
                <span class="module-glyph provided">${escapeHtml(item.provider.slice(0, 1))}</span>
                <span class="module-name">${escapeHtml(item.name)}</span>
                <span class="module-object-count">${item.definitionCount}</span>
              </button>
              ${
                item.downloadable
                  ? `<a class="module-download" href="${escapeHtml(downloadUrl(item.id))}"
                      title="Download original ${escapeHtml(item.name)}"
                      aria-label="Download original ${escapeHtml(item.name)}">${icons.download}</a>`
                  : ""
              }
            </div>`;
        })
        .join("");

}

function visibleParentOid(definition, visibleOids) {
  if (!definition.oid) return "";
  let parent = definition.treeParentOid || definition.parentOid;
  while (parent) {
    if (visibleOids.has(parent)) return parent;
    parent = parent.split(".").slice(0, -1).join(".");
  }
  return "";
}

function hierarchyParentOid(definition, visibleOids) {
  return visibleParentOid(definition, visibleOids);
}

function expandEntireTree(definitions) {
  const resolved = definitions.filter(
    (definition) => definition && typeof definition.oid === "string" && definition.oid,
  );
  state.expanded = new Set(resolved.map((definition) => definition.oid));
  elements.expand.textContent = "Collapse all";
}

function renderTree(definitions, total) {
  if (!definitions.length && !total && !state.serverLoading) return renderEmpty();

  const resolved = definitions.filter((definition) => definition.oid);
  const candidates = resolved;
  const declaredChildren = new Set(
    candidates
      .filter((definition) => definition.hasChildren)
      .map((definition) => definition.oid),
  );
  const roots = candidates.filter((definition, index, all) => {
    return all.findIndex((candidate) => candidate.oid === definition.oid) === index;
  });
  const visibleOids = new Set(roots.map((definition) => definition.oid));
  const children = new Map();

  for (const definition of roots) {
    const parentOid = hierarchyParentOid(definition, visibleOids);
    const bucket = children.get(parentOid) || [];
    bucket.push(definition);
    children.set(parentOid, bucket);
  }

  const renderBranch = (parentOid, level) => {
    const branch = children.get(parentOid) || [];
    return branch
      .map((definition) => {
        const key = definitionKey(definition);
        const hasChildren =
          children.has(definition.oid) ||
          (state.scope.kind !== "server" && declaredChildren.has(definition.oid));
        const expanded = state.expanded.has(definition.oid);
        const selected = state.selectedKey === key;
        return `
          <div>
            <button class="tree-row${expanded ? " expanded" : ""}${selected ? " selected" : ""}"
              data-key="${escapeHtml(key)}" data-oid="${escapeHtml(definition.oid)}"
              style="--tree-indent:${14 + level * 18}px" type="button">
              <span class="tree-node">
                <span class="chevron">${hasChildren ? icons.chevron : ""}</span>
                <span class="node-icon ${typeCategory(definition)}">${typeInitial(definition)}</span>
                <span class="node-main">
                  <span class="node-name">${escapeHtml(definition.name)}</span>
                  <span class="node-meta">${escapeHtml(definition.module)}</span>
                </span>
              </span>
              <span class="node-oid">${escapeHtml(definition.oid)}</span>
              ${renderRowDescription(definition)}
            </button>
            ${
              hasChildren && expanded
                ? `<div class="children open">${renderBranch(definition.oid, level + 1)}</div>`
                : ""
            }
          </div>`;
      })
      .join("");
  };

  const unresolved = definitions.filter((definition) => !definition.oid).slice(0, 100);
  return `${
    state.serverLoading
      ? '<div class="result-notice loading">Building the module tree…</div>'
      : ""
  }
    <div class="tree-group">${renderBranch("", 0)}</div>
    ${
      unresolved.length
        ? `<div class="tree-group">
            <div class="list-header"><span>Unresolved symbol</span><span>Type</span><span>Module</span></div>
            ${unresolved.map(renderListRow).join("")}
          </div>`
        : ""
    }`;
}

function renderListRow(definition) {
  const key = definitionKey(definition);
  return `
    <div class="list-row-shell">
      <button class="list-row${state.selectedKey === key ? " selected" : ""}"
        data-key="${escapeHtml(key)}" data-oid="${escapeHtml(definition.oid)}" type="button">
        <span class="name-cell">${escapeHtml(definition.name)}</span>
        <span class="type-label">${escapeHtml(definition.type)}</span>
        <span class="oid-cell">${escapeHtml(definition.oid || definition.module)}</span>
        ${renderRowDescription(definition)}
      </button>
      ${
        definition.oid
          ? `<button class="row-tree-action" data-row-tree="${escapeHtml(key)}" type="button"
              title="Show ${escapeHtml(definition.name)} in its MIB tree"
              aria-label="Show ${escapeHtml(definition.name)} in its MIB tree">
              ${icons.tree}<span>Show in tree</span>
            </button>`
          : ""
      }
    </div>`;
}

function renderResultNotice(definitions, total) {
  if (state.serverLoading) {
    return `<div class="result-notice loading">${
      state.serverResults.length
        ? "Loading more server results…"
        : "Searching server-provided MIBs…"
    }</div>`;
  }
  if (total <= definitions.length) return "";
  return `<div class="result-notice">
    <span>Showing ${definitions.length} of ${total} matches.</span>
    ${
      state.serverHasMore
        ? '<button class="text-button" data-load-more type="button">Load more</button>'
        : "<span>Refine the search to narrow the result set.</span>"
    }
  </div>`;
}

function renderSearchResultRow(definition) {
  const key = definitionKey(definition);
  const sourceLabel = definition.source === "server"
    ? definition.provider || "Provided"
    : "Uploaded";
  return `
    <div class="search-result-shell">
      <button class="search-result-row${state.selectedKey === key ? " selected" : ""}"
        data-key="${escapeHtml(key)}" data-oid="${escapeHtml(definition.oid)}" type="button">
        <span class="search-result-name">${escapeHtml(definition.name)}</span>
        <span class="search-result-mib">
          <strong>${escapeHtml(definition.module)}</strong>
          <small>${escapeHtml(sourceLabel)}</small>
        </span>
        <span class="type-label">${escapeHtml(definition.type)}</span>
        <span class="search-result-oid">${escapeHtml(definition.oid || "Unresolved")}</span>
        ${renderRowDescription(definition)}
      </button>
      ${
        definition.oid
          ? `<button class="row-tree-action" data-row-tree="${escapeHtml(key)}" type="button"
              title="Show ${escapeHtml(definition.name)} in its MIB tree"
              aria-label="Show ${escapeHtml(definition.name)} in its MIB tree">
              ${icons.tree}<span>Show in tree</span>
            </button>`
          : ""
      }
    </div>`;
}

function renderSearchResults(definitions, total) {
  if (!definitions.length && !state.serverLoading) return renderEmpty();
  return `
    ${renderResultNotice(definitions, total)}
    <div class="search-results-header">
      <span>Symbol</span><span>MIB</span><span>Type</span><span>OID</span>
    </div>
    <div class="search-results">${definitions.map(renderSearchResultRow).join("")}</div>`;
}

function renderList(definitions, total) {
  if (!definitions.length && !state.serverLoading) return renderEmpty();
  return `
    ${renderResultNotice(definitions, total)}
    <div class="list-header"><span>Name</span><span>Type</span><span>OID / Module</span></div>
    ${definitions.map(renderListRow).join("")}`;
}

function renderEmpty() {
  const hasDefinitions =
    state.serverDefinitionCount > 0 || state.localRegistry.definitions.length > 0;
  return `
    <div class="empty-state">
      <div class="empty-state-inner">
        <div class="empty-graphic">${icons.empty}</div>
        <h2>${hasDefinitions ? "No matching objects" : "No MIB data available"}</h2>
        <p>${
          hasDefinitions
            ? "Try a broader search, another type filter, or select a different MIB."
            : "Connect the server database or add your own ASN.1 MIB files."
        }</p>
        <button class="primary-button empty-upload" type="button">Add MIB files</button>
      </div>
    </div>`;
}

function renderLanding() {
  return `
    <div class="empty-state">
      <div class="empty-state-inner">
        <div class="empty-graphic">${icons.empty}</div>
        <h2>Search or select a MIB</h2>
        <p>Use global search above, or choose one uploaded or provided MIB to browse its tree.</p>
        <button class="primary-button empty-search" type="button">Search MIB objects</button>
      </div>
    </div>`;
}

function flatMode() {
  return (
    Boolean(state.query.trim()) ||
    state.view === "list" ||
    state.filter !== "all"
  );
}

function renderBrowser() {
  const globalSearch = Boolean(state.query.trim());
  const neutral = state.scope.kind === "none" && !globalSearch;
  document.querySelectorAll("[data-view], [data-filter]").forEach((control) => {
    control.disabled = neutral;
  });
  if (neutral) {
    elements.scopeLabel.textContent = "MIB browser";
    elements.scopeTitle.textContent = "Search or select a MIB";
    elements.objectStat.textContent = "0";
    elements.resolvedStat.textContent = "0";
    elements.unresolvedStat.textContent = "0";
    elements.expand.disabled = true;
    elements.objectBrowser.innerHTML = renderLanding();
    return;
  }
  const local = localDefinitions();
  const server =
    state.scope.kind === "user" && !globalSearch ? [] : state.serverResults;
  const isFlat = flatMode() || state.scope.kind === "user" && state.view === "list";
  let definitions;
  let total;
  let resolved;
  let unresolved;

  if (isFlat) {
    definitions = [...local.slice(0, LOCAL_RESULT_LIMIT), ...server];
    const includeServerResults = state.scope.kind !== "user" || globalSearch;
    const serverTotal = includeServerResults ? state.serverCounts.total : 0;
    const serverResolved = includeServerResults ? state.serverCounts.resolved : 0;
    total = local.length + serverTotal;
    resolved =
      local.filter((definition) => definition.oid).length + serverResolved;
    unresolved = total - resolved;
  } else {
    const treeServer =
      state.scope.kind === "server"
        ? state.serverResults.filter(matchesFilter)
        : [];
    definitions = [...local, ...treeServer];
    const includeServer = state.scope.kind !== "user";
    total =
      (state.scope.kind === "server"
        ? state.serverCounts.total
        : includeServer
          ? state.serverDefinitionCount
          : 0) + local.length;
    resolved =
      (state.scope.kind === "server"
        ? state.serverCounts.resolved
        : includeServer
          ? state.serverResolvedCount
          : 0) + local.filter((definition) => definition.oid).length;
    unresolved = total - resolved;
  }

  const scopeModule =
    state.scope.kind === "server"
      ? state.serverCatalog.find((module) => module.id === state.scope.moduleId)
      : state.scope.kind === "user"
        ? state.userModules.find((module) => moduleKey(module) === state.scope.moduleKey)
        : null;
  elements.scopeLabel.textContent =
    globalSearch
      ? "Global search"
      : state.scope.kind === "server"
      ? "Provided MIB"
      : state.scope.kind === "user"
        ? "Your MIB"
        : "MIB browser";
  elements.scopeTitle.textContent =
    globalSearch
      ? "Search results"
      : scopeModule?.module || scopeModule?.name || "Search or select a MIB";
  elements.objectStat.textContent = total;
  elements.resolvedStat.textContent = resolved;
  elements.unresolvedStat.textContent = unresolved;
  elements.expand.disabled = isFlat;
  elements.objectBrowser.innerHTML = globalSearch
    ? renderSearchResults(definitions, total)
    : isFlat
      ? renderList(definitions, total)
      : renderTree(definitions, total);
}

function selectedDefinition() {
  if (!state.selectedKey) return null;
  if (state.selectedKey.startsWith("server::")) {
    const id = Number(state.selectedKey.split("::")[1]);
    return (
      state.definitionDetails.get(id) ||
      state.serverResults.find((definition) => definition.definitionId === id) ||
      state.treeDefinitions.get(id) ||
      null
    );
  }
  return state.localRegistry.definitions.find(
    (definition) => definitionKey(definition) === state.selectedKey,
  );
}

function renderDetails() {
  const definition = selectedDefinition();
  if (!definition) {
    elements.details.innerHTML = `
      <div class="details-empty">
        <div>
          ${icons.empty}
          <strong>Select an object</strong>
          <span>Its OID, properties, description, and source information will appear here.</span>
        </div>
      </div>`;
    return;
  }

  const properties = [
    ["Syntax", definition.syntax],
    ["Access", definition.access],
    ["Status", definition.status],
    ["Index", definition.index],
    ["Units", definition.units],
    ["Revision", definition.revision],
  ].filter(([, value]) => value);
  const isServer = definition.source === "server";
  const richLoaded = isServer && state.definitionDetails.has(definition.definitionId);
  const canShowInTree = Boolean(definition.oid) && flatMode();
  let descriptionPanel;
  if (definition.description) {
    descriptionPanel = `
      <section class="details-section description-section">
        <h3>Description</h3>
        <p class="description">${escapeHtml(definition.description)}</p>
      </section>`;
  } else if (isServer && !definition.detailsAvailable) {
    descriptionPanel = `
      <section class="details-section description-section description-unavailable">
        <h3>Description availability</h3>
        <p class="description">
          This module is indexed structurally. Rich transformed text is not stored
          under its redistribution policy.${
            definition.downloadable ? " Download the unmodified original for full details." : ""
          }
        </p>
      </section>`;
  } else if (isServer && definition.detailsAvailable && !richLoaded) {
    descriptionPanel = `
      <section class="details-section description-section description-loading">
        <h3>Description</h3>
        <p class="description">Loading details from the server…</p>
      </section>`;
  } else {
    descriptionPanel = `
      <section class="details-section description-section description-missing">
        <h3>Description</h3>
        <p class="description">No description is included for this definition.</p>
      </section>`;
  }

  elements.details.innerHTML = `
    <div class="details-header">
      <div class="details-badges">
        <span class="details-type">${escapeHtml(definition.type)}</span>
        ${
          definition.source !== "builtin"
            ? `<span class="source-badge">${isServer ? "Provided" : "Uploaded"}</span>`
            : ""
        }
      </div>
      <h2>${escapeHtml(definition.name)}</h2>
      <div class="module-line">
        <span>MIB</span>
        <strong class="module-link">${escapeHtml(definition.module)}</strong>
      </div>
      ${
        canShowInTree || isServer && definition.downloadable
          ? `<div class="details-actions">
              ${
                canShowInTree
                  ? `<button class="details-tree" data-show-in-tree type="button">
                      ${icons.tree} Show in tree
                    </button>`
                  : ""
              }
              ${
                isServer && definition.downloadable
                  ? `<a class="details-download" href="${escapeHtml(downloadUrl(definition.moduleId))}">
                      Download original MIB
                    </a>`
                  : ""
              }
            </div>`
          : ""
      }
    </div>
    <div class="details-body">
      ${descriptionPanel}
      <section class="details-section">
        <h3>Object identifier</h3>
        <div class="oid-box">
          ${escapeHtml(definition.oid || "Unresolved")}
          ${
            definition.oid
              ? `<button class="copy-button" data-copy="${escapeHtml(definition.oid)}"
                  title="Copy OID" type="button">${icons.copy}</button>`
              : ""
          }
        </div>
      </section>
      ${
        properties.length
          ? `<section class="details-section">
              <h3>Properties</h3>
              <dl class="property-list">
                ${properties
                  .map(
                    ([label, value]) =>
                      `<div class="property-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`,
                  )
                  .join("")}
              </dl>
            </section>`
          : ""
      }
      ${
        definition.raw
          ? `<section class="details-section source-section">
              <h3>Source declaration</h3>
              <div class="code-box">${escapeHtml(definition.raw)}</div>
            </section>`
          : ""
      }
    </div>`;
}

function render() {
  renderModules();
  renderBrowser();
  renderDetails();
}

async function loadServerCatalog() {
  try {
    const payload = await fetchJson("modules.php");
    if (Number(payload.schemaVersion) !== 2) {
      throw new Error("The server MIB database schema is incompatible with this client.");
    }
    state.serverCatalog = Array.isArray(payload.modules) ? payload.modules : [];
    state.serverDefinitionCount = Number(payload.definitionCount) || 0;
    state.serverResolvedCount = Number(payload.resolvedCount) || 0;
    state.serverReady = true;
    state.serverError = "";
    render();
    if (state.query.trim()) {
      await refreshServerResults();
    }
  } catch (error) {
    console.error(error);
    state.serverError = error.message;
    state.serverReady = false;
    render();
    toast("Server-provided MIBs are unavailable; uploaded MIBs still work locally.", true);
  }
}

async function refreshServerResults() {
  const requestId = ++state.serverRequestId;
  serverSearchController?.abort();
  serverSearchController = null;
  if (
    (state.scope.kind === "user" || state.scope.kind === "none") &&
    !state.query.trim()
  ) {
    state.serverResults = [];
    state.serverCounts = { total: 0, resolved: 0, unresolved: 0 };
    state.serverHasMore = false;
    state.serverLoading = false;
    renderBrowser();
    return;
  }
  if (!state.serverReady) {
    state.serverResults = [];
    state.serverCounts = { total: 0, resolved: 0, unresolved: 0 };
    state.serverHasMore = false;
    state.serverLoading = false;
    renderBrowser();
    return;
  }
  const moduleTreeMode = state.scope.kind === "server" && !flatMode();
  if (!flatMode() && !moduleTreeMode) {
    state.serverResults = [];
    state.serverCounts = {
      total: state.serverDefinitionCount,
      resolved: state.serverResolvedCount,
      unresolved: state.serverDefinitionCount - state.serverResolvedCount,
    };
    state.serverHasMore = false;
    state.serverLoading = false;
    renderBrowser();
    return;
  }

  state.serverLoading = true;
  state.serverResults = [];
  state.serverCounts = { total: 0, resolved: 0, unresolved: 0 };
  state.serverHasMore = false;
  renderBrowser();
  const controller = new AbortController();
  serverSearchController = controller;
  try {
    const collected = [];
    let offset = 0;
    let payload;
    do {
      payload = await fetchJson("search.php", {
        q: state.query.trim(),
        type: state.filter,
        module_id:
          !state.query.trim() && state.scope.kind === "server" ? state.scope.moduleId : "",
        limit: moduleTreeMode ? MODULE_TREE_PAGE_SIZE : SERVER_PAGE_SIZE,
        offset,
      }, controller.signal);
      if (requestId !== state.serverRequestId) return;
      const page = (payload.definitions || []).map(normalizeServerDefinition);
      collected.push(...page);
      offset += page.length;
      if (!moduleTreeMode || !payload.hasMore || !page.length) break;
    } while (true);

    state.serverResults = collected;
    state.serverCounts = {
      total: Number(payload.total) || 0,
      resolved: Number(payload.resolved) || 0,
      unresolved: Number(payload.unresolved) || 0,
    };
    state.serverHasMore = moduleTreeMode ? false : Boolean(payload.hasMore);
    state.serverLoading = false;
    if (moduleTreeMode) expandEntireTree(state.serverResults);
    renderBrowser();
    renderDetails();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (requestId !== state.serverRequestId) return;
    console.error(error);
    state.serverLoading = false;
    state.serverResults = [];
    state.serverCounts = { total: 0, resolved: 0, unresolved: 0 };
    state.serverHasMore = false;
    renderBrowser();
    toast(`Search failed: ${error.message}`, true);
  }
}

function scheduleServerRefresh() {
  clearTimeout(searchTimer);
  if (state.scope.kind === "user" && !state.query.trim()) {
    void refreshServerResults();
    return;
  }
  state.serverLoading = true;
  state.serverResults = [];
  state.serverCounts = { total: 0, resolved: 0, unresolved: 0 };
  state.serverHasMore = false;
  renderBrowser();
  searchTimer = setTimeout(() => void refreshServerResults(), SEARCH_DEBOUNCE_MS);
}

async function loadMoreServerResults() {
  if (
    state.serverLoading ||
    !state.serverHasMore ||
    state.scope.kind === "user" && !state.query.trim()
  ) {
    return;
  }
  const requestId = ++state.serverRequestId;
  serverSearchController?.abort();
  const controller = new AbortController();
  serverSearchController = controller;
  state.serverLoading = true;
  renderBrowser();
  try {
    const payload = await fetchJson("search.php", {
      q: state.query.trim(),
      type: state.filter,
      module_id:
        !state.query.trim() && state.scope.kind === "server" ? state.scope.moduleId : "",
      limit: SERVER_PAGE_SIZE,
      offset: state.serverResults.length,
    }, controller.signal);
    if (requestId !== state.serverRequestId) return;
    state.serverResults.push(...(payload.definitions || []).map(normalizeServerDefinition));
    state.serverHasMore = Boolean(payload.hasMore);
    state.serverLoading = false;
    renderBrowser();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (requestId !== state.serverRequestId) return;
    console.error(error);
    state.serverLoading = false;
    renderBrowser();
    toast(`Could not load more results: ${error.message}`, true);
  }
}

async function loadTreeChildren(parentOid) {
  if (
    !state.serverReady ||
    state.loadedTreeParents.has(parentOid) ||
    state.loadingTreeParents.has(parentOid)
  ) {
    return;
  }
  state.loadingTreeParents.add(parentOid);
  try {
    const payload = await fetchJson("tree.php", { parent_oid: parentOid });
    for (const definition of payload.definitions || []) {
      const normalized = normalizeServerDefinition(definition);
      state.treeDefinitions.set(normalized.definitionId, normalized);
    }
    state.loadedTreeParents.add(parentOid);
    renderBrowser();
  } catch (error) {
    console.error(error);
    toast(`Could not load OID children: ${error.message}`, true);
  } finally {
    state.loadingTreeParents.delete(parentOid);
  }
}

async function loadDefinitionDetails(definition) {
  if (
    definition.source !== "server" ||
    !definition.detailsAvailable ||
    state.definitionDetails.has(definition.definitionId)
  ) {
    return;
  }
  try {
    const payload = await fetchJson("definition.php", { id: definition.definitionId });
    const detailed = normalizeServerDefinition(payload.definition);
    state.definitionDetails.set(detailed.definitionId, detailed);
    if (state.selectedKey === definitionKey(definition)) renderDetails();
  } catch (error) {
    console.error(error);
    toast(`Could not load definition details: ${error.message}`, true);
  }
}

async function importFiles(fileList) {
  const incoming = [];
  for (const file of [...fileList]) {
    try {
      const content = await file.text();
      if (!content.trim()) {
        toast(`${file.name} is empty and was skipped.`, true);
        continue;
      }
      incoming.push({
        name: file.name,
        content,
        size: file.size,
        modified: file.lastModified,
        addedAt: Date.now(),
      });
    } catch {
      toast(`Could not read ${file.name}.`, true);
    }
  }
  if (!incoming.length) return;

  const byName = new Map(state.files.map((file) => [file.name, file]));
  incoming.forEach((file) => byName.set(file.name, file));
  const nextFiles = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  try {
    await saveFiles(incoming);
  } catch (error) {
    console.error(error);
    toast("MIBs were loaded, but browser persistence is unavailable for this session.", true);
  }
  state.files = nextFiles;
  rebuildLocal();
  render();

  const objectCount = incoming
    .map((file) => parseMib(file.content, file.name).definitions.length)
    .reduce((sum, count) => sum + count, 0);
  toast(`Loaded ${incoming.length} file${incoming.length === 1 ? "" : "s"} with ${objectCount} definitions.`);
  elements.fileInput.value = "";
}

async function removeUploadedFile(fileName) {
  const file = state.files.find((item) => item.name === fileName);
  if (!file) return;
  try {
    await deleteFile(fileName);
    toast(`${fileName} removed.`);
  } catch (error) {
    console.error(error);
    toast(`${fileName} was removed from this view, but browser storage could not be updated.`, true);
  }
  state.files = state.files.filter((item) => item.name !== fileName);
  rebuildLocal();
  render();
}

function setViewMode(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((control) => {
    control.classList.toggle("active", control.dataset.view === view);
  });
}

function setFilterMode(filter) {
  state.filter = filter;
  document.querySelectorAll("[data-filter]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  });
}

function enterTreeMode() {
  clearTimeout(searchTimer);
  elements.search.value = "";
  state.query = "";
  setFilterMode("all");
  setViewMode("tree");
  state.viewBeforeSearch = "tree";
  elements.expand.textContent = "Expand all";
}

function expandPathTo(oid, definitions) {
  if (typeof oid !== "string" || !oid) return;
  const candidates = (definitions || []).filter(
    (definition) =>
      definition &&
      typeof definition.oid === "string" &&
      definition.oid &&
      definition.oid !== oid,
  );
  for (const definition of candidates) {
    if (oid.startsWith(`${definition.oid}.`)) {
      state.expanded.add(definition.oid);
    }
  }
}

function scrollSelectedTreeRowIntoView() {
  requestAnimationFrame(() => {
    elements.objectBrowser
      .querySelector(".tree-row.selected")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

async function showDefinitionInTree(definition) {
  if (typeof definition?.oid !== "string" || !definition.oid) return;
  const key = definitionKey(definition);
  enterTreeMode();

  if (definition.source === "server") {
    const module = state.serverCatalog.find((item) => item.id === definition.moduleId);
    if (!module) {
      toast("The definition's provided MIB is no longer available.", true);
      return;
    }
    state.scope = {
      kind: "server",
      moduleId: module.id,
      moduleKey: "",
      name: module.module,
    };
    state.selectedKey = key;
    renderModules();
    await refreshServerResults();
    if (
      state.scope.kind !== "server" ||
      state.scope.moduleId !== module.id ||
      !state.serverResults.some((item) => definitionKey(item) === key)
    ) {
      return;
    }
    state.expanded = new Set();
    expandPathTo(definition.oid, state.serverResults);
    elements.expand.textContent = "Expand all";
  } else if (definition.source === "user") {
    const module = state.userModules.find((item) => item.name === definition.module);
    if (!module) return;
    state.scope = {
      kind: "user",
      moduleId: 0,
      moduleKey: moduleKey(module),
      name: module.name,
    };
    state.selectedKey = key;
    const definitions = resolvedDefinitionsForUserModule(module);
    state.expanded = new Set();
    expandPathTo(definition.oid, definitions);
    elements.expand.textContent = "Expand all";
    renderModules();
    await refreshServerResults();
  } else {
    return;
  }

  renderBrowser();
  renderDetails();
  scrollSelectedTreeRowIntoView();
}

function definitionForKey(key) {
  if (typeof key !== "string" || !key) return null;
  if (key.startsWith("server::")) {
    const id = Number(key.split("::")[1]);
    return (
      state.definitionDetails.get(id) ||
      state.serverResults.find((definition) => definition.definitionId === id) ||
      state.treeDefinitions.get(id) ||
      null
    );
  }
  return state.localRegistry.definitions.find(
    (definition) => definitionKey(definition) === key,
  );
}

function positionRowTooltip(row) {
  if (elements.rowTooltip.hidden) return;
  const rowBounds = row.getBoundingClientRect();
  const gap = 7;
  const edge = 12;
  const bounds = elements.rowTooltip.getBoundingClientRect();
  let left = rowBounds.right - bounds.width - edge;
  let top = rowBounds.bottom + gap;
  if (left + bounds.width > window.innerWidth - edge) {
    left = window.innerWidth - bounds.width - edge;
  }
  left = Math.max(edge, left);
  if (top + bounds.height > window.innerHeight - edge) {
    top = Math.max(edge, rowBounds.top - bounds.height - gap);
  }
  elements.rowTooltip.style.left = `${left}px`;
  elements.rowTooltip.style.top = `${top}px`;
}

function hideRowTooltip() {
  hoveredRow?.removeAttribute("aria-describedby");
  hoveredRow = null;
  elements.rowTooltip.hidden = true;
}

function showRowTooltip(row) {
  if (hoveredRow === row) return;
  hideRowTooltip();
  const definition = definitionForKey(row.dataset.key);
  if (!definition) return;
  hoveredRow = row;
  const description = definition.description
    ? definition.description
    : definition.source === "server" && definition.detailsAvailable
      ? "Select this row to load its full description."
      : "No description is included for this definition.";
  elements.rowTooltip.innerHTML = `
    <div class="row-tooltip-heading">
      <strong>${escapeHtml(definition.name)}</strong>
      <span>${escapeHtml(definition.type)}</span>
    </div>
    <dl>
      <div><dt>MIB</dt><dd>${escapeHtml(definition.module)}</dd></div>
      <div><dt>OID</dt><dd>${escapeHtml(definition.oid || "Unresolved")}</dd></div>
    </dl>
    <p>${escapeHtml(description)}</p>`;
  elements.rowTooltip.hidden = false;
  row.setAttribute("aria-describedby", "row-tooltip");
  positionRowTooltip(row);
}

function selectDefinition(key, oid) {
  const wasSelected = state.selectedKey === key;
  state.selectedKey = key;
  const definition = definitionForKey(key);

  if (oid && wasSelected) {
    if (state.expanded.has(oid)) {
      state.expanded.delete(oid);
    } else {
      state.expanded.add(oid);
      void loadTreeChildren(oid);
    }
  }
  renderBrowser();
  renderDetails();
  if (definition) void loadDefinitionDetails(definition);
}

elements.upload.addEventListener("click", () => elements.fileInput.click());
elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", (event) => importFiles(event.target.files));

for (const eventName of ["dragenter", "dragover"]) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("drag-over");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("drag-over");
  });
}
document.addEventListener("drop", (event) => importFiles(event.dataTransfer.files));

elements.search.addEventListener("input", (event) => {
  const wasSearching = Boolean(state.query.trim());
  state.query = event.target.value;
  const isSearching = Boolean(state.query.trim());
  if (!wasSearching && isSearching) {
    state.viewBeforeSearch = state.view;
    setViewMode("list");
  } else if (wasSearching && !isSearching) {
    setViewMode(state.viewBeforeSearch);
  }
  scheduleServerRefresh();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== elements.search) {
    event.preventDefault();
    elements.search.focus();
  }
  if (event.key === "Escape" && document.activeElement === elements.search) {
    elements.search.value = "";
    state.query = "";
    elements.search.blur();
    setViewMode(state.viewBeforeSearch);
    scheduleServerRefresh();
  }
});

elements.userModuleList.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-file]");
  if (removeButton) {
    void removeUploadedFile(removeButton.dataset.removeFile);
    return;
  }
  const button = event.target.closest("[data-module]");
  if (!button) return;
  const module = state.userModules.find((candidate) => moduleKey(candidate) === button.dataset.module);
  if (!module) return;
  enterTreeMode();
  state.scope = {
    kind: "user",
    moduleId: 0,
    moduleKey: button.dataset.module,
    name: module.name,
  };
  expandEntireTree(resolvedDefinitionsForUserModule(module));
  render();
  void refreshServerResults();
});

elements.serverModuleList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-server-module]");
  if (!button) return;
  const moduleId = Number(button.dataset.serverModule);
  const module = state.serverCatalog.find((candidate) => candidate.id === moduleId);
  if (!module) return;
  enterTreeMode();
  state.scope = {
    kind: "server",
    moduleId,
    moduleKey: "",
    name: module.module,
  };
  state.selectedKey = "";
  renderModules();
  void refreshServerResults();
});

elements.catalogSearch.addEventListener("input", (event) => {
  state.catalogQuery = event.target.value;
  renderModules();
});

document.querySelector("#filter-chips").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  setFilterMode(button.dataset.filter);
  if (button.dataset.filter !== "all") setViewMode("list");
  void refreshServerResults();
});

document.querySelector(".view-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  setViewMode(button.dataset.view);
  void refreshServerResults();
});

elements.objectBrowser.addEventListener("click", (event) => {
  hideRowTooltip();
  if (event.target.closest("[data-load-more]")) {
    void loadMoreServerResults();
    return;
  }
  const rowTreeButton = event.target.closest("[data-row-tree]");
  if (rowTreeButton) {
    const definition = definitionForKey(rowTreeButton.dataset.rowTree);
    if (definition) void showDefinitionInTree(definition);
    return;
  }
  if (event.target.closest(".empty-upload")) {
    elements.fileInput.click();
    return;
  }
  if (event.target.closest(".empty-search")) {
    elements.search.focus();
    return;
  }
  const button = event.target.closest("[data-key]");
  if (!button) return;
  selectDefinition(button.dataset.key, button.dataset.oid);
});

elements.objectBrowser.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch") return;
  const row = event.target.closest("[data-key]");
  if (row && elements.objectBrowser.contains(row)) showRowTooltip(row);
});

elements.objectBrowser.addEventListener("pointerout", (event) => {
  if (!hoveredRow || hoveredRow.contains(event.relatedTarget)) return;
  hideRowTooltip();
});

elements.objectBrowser.addEventListener("scroll", hideRowTooltip, { passive: true });
window.addEventListener("blur", hideRowTooltip);

elements.details.addEventListener("click", async (event) => {
  if (event.target.closest("[data-show-in-tree]")) {
    await showDefinitionInTree(selectedDefinition());
    return;
  }
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    toast("OID copied to clipboard.");
  } catch {
    toast("Clipboard access is unavailable.", true);
  }
});

elements.expand.addEventListener("click", () => {
  if (state.scope.kind === "none") return;
  const scopedDefinitions =
    state.scope.kind === "server"
      ? state.serverResults
      : state.scope.kind === "user"
        ? localDefinitions()
        : [...state.localRegistry.definitions, ...state.treeDefinitions.values()];
  const definitions = scopedDefinitions.filter((definition) => definition.oid);
  const shouldExpand = elements.expand.textContent === "Expand all";
  if (shouldExpand && definitions.length > 1500) {
    toast("Too many branches to expand at once. Expand a subtree or search instead.", true);
    return;
  }
  state.expanded = shouldExpand
    ? new Set(definitions.map((definition) => definition.oid))
    : new Set();
  elements.expand.textContent = shouldExpand ? "Collapse all" : "Expand all";
  renderBrowser();
});

elements.clear.addEventListener("click", () => {
  if (!state.files.length) {
    toast("The workspace is already empty.");
    return;
  }
  elements.confirmDialog.showModal();
});

elements.confirmDialog.addEventListener("close", async () => {
  if (elements.confirmDialog.returnValue !== "confirm") return;
  try {
    await clearFiles();
    toast("Uploaded MIBs cleared.");
  } catch (error) {
    console.error(error);
    toast("Uploaded MIBs were cleared from this view, but browser storage could not be updated.", true);
  }
  state.files = [];
  state.selectedKey = state.selectedKey.startsWith("user::") ? "" : state.selectedKey;
  rebuildLocal();
  render();
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

elements.theme.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
applyTheme(
  savedTheme ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("Application-shell caching is unavailable.", error);
  });
}

try {
  state.files = await loadFiles();
} catch (error) {
  console.error(error);
  toast("Local storage is unavailable; uploaded files will only last for this tab.", true);
}

rebuildLocal();
render();
await loadServerCatalog();
