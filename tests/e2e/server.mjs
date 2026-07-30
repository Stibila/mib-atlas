import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const host = "127.0.0.1";
const port = 4173;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mib": "text/plain; charset=utf-8",
};

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

const providedDefinition = {
  id: 1,
  moduleId: 1,
  name: "providedRoot",
  type: "MODULE-IDENTITY",
  oid: "1.3.6.1.4.1.55555",
  parentOid: "1.3.6.1.4.1",
  treeParentOid: "",
  module: "PROVIDED-TEST-MIB",
  fileName: "PROVIDED-TEST-MIB.mib",
  provider: "Test provider",
  downloadable: true,
  detailsAvailable: true,
  hasChildren: false,
  description: "",
};

function handleApi(url, response) {
  if (url.pathname === "/api/modules.php") {
    sendJson(response, {
      schemaVersion: 2,
      modules: [{
        id: 1,
        name: "PROVIDED-TEST-MIB",
        module: "PROVIDED-TEST-MIB",
        provider: "Test provider",
        definitionCount: 1,
        downloadable: true,
      }],
      moduleCount: 1,
      definitionCount: 1,
      resolvedCount: 1,
    });
    return true;
  }
  if (url.pathname === "/api/search.php") {
    const definitions = url.searchParams.get("q") ? [] : [providedDefinition];
    sendJson(response, {
      definitions,
      total: definitions.length,
      resolved: definitions.length,
      unresolved: 0,
      hasMore: false,
    });
    return true;
  }
  if (url.pathname === "/api/tree.php") {
    sendJson(response, { definitions: [] });
    return true;
  }
  if (url.pathname === "/api/definition.php") {
    sendJson(response, { error: "Definition not found." }, 404);
    return true;
  }
  return false;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (handleApi(url, response)) return;

  const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = resolve(projectRoot, relativePath);
  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": fileStat.size,
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`MIB Atlas test server listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
