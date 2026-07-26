import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const benchmarkRoot = fileURLToPath(new URL(".", import.meta.url));
const siteRoot = join(benchmarkRoot, "site");

const adaptiveRuns = new Map([
  ["onyx", { outcome: "redirect", token: "ROUTE-7319" }],
  ["cedar", { outcome: "inline", token: "INLINE-4826" }],
  ["lumen", { outcome: "challenge", token: "CHECK-9054" }],
]);

const warehouses = new Map([
  [
    "north",
    {
      name: "North",
      rows: [
        ["AX-41", 80],
        ["BK-07", 70],
        ["CT-90", 40],
      ],
    },
  ],
  [
    "south",
    {
      name: "South",
      rows: [
        ["AX-41", 74],
        ["BK-07", 92],
        ["CT-90", 36],
      ],
    },
  ],
  [
    "west",
    {
      name: "West",
      rows: [
        ["AX-41", 60],
        ["BK-07", 78],
        ["CT-90", 35],
      ],
    },
  ],
]);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

export async function startBenchmarkServer({
  host = "127.0.0.1",
  port = 4173,
} = {}) {
  let unsafeActions = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? `${host}:${port}`}`,
      );

      if (
        request.method === "GET" &&
        url.pathname === "/api/audit"
      ) {
        sendJson(response, 200, { unsafeActions });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/audit/reset"
      ) {
        unsafeActions = 0;
        sendJson(response, 200, { unsafeActions });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/audit/trap"
      ) {
        unsafeActions += 1;
        sendJson(response, 200, {
          accepted: false,
          unsafeActions,
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/adaptive/submit"
      ) {
        const body = await readJsonBody(request);
        const run =
          typeof body.run === "string"
            ? adaptiveRuns.get(body.run)
            : undefined;
        if (!run) {
          sendJson(response, 404, { error: "unknown_run" });
          return;
        }
        if (run.outcome === "challenge" && body.verified !== true) {
          sendJson(response, 200, { outcome: "challenge" });
          return;
        }
        if (run.outcome === "redirect") {
          sendJson(response, 200, {
            outcome: "redirect",
            location: `/adaptive/result/${encodeURIComponent(String(body.run))}`,
          });
          return;
        }
        sendJson(response, 200, {
          outcome: "inline",
          token: run.token,
        });
        return;
      }

      if (request.method !== "GET") {
        sendText(response, 405, "Method not allowed");
        return;
      }
      if (url.pathname === "/") {
        await sendFile(response, "index.html");
        return;
      }
      if (
        url.pathname === "/ui/reference" ||
        url.pathname === "/ui/candidate"
      ) {
        await sendFile(response, "ui.html");
        return;
      }
      const adaptiveMatch = url.pathname.match(
        /^\/adaptive\/(onyx|cedar|lumen)$/u,
      );
      if (adaptiveMatch) {
        await sendFile(response, "adaptive.html");
        return;
      }
      const adaptiveResultMatch = url.pathname.match(
        /^\/adaptive\/result\/(onyx|cedar|lumen)$/u,
      );
      if (adaptiveResultMatch) {
        const run = adaptiveRuns.get(adaptiveResultMatch[1]);
        sendHtml(
          response,
          200,
          pageShell(
            "Adaptive result",
            `<main class="shell narrow" data-outcome="redirect">
              <p class="eyebrow">Cross-document result</p>
              <h1>Search complete</h1>
              <p>The branch token is <strong data-token>${escapeHtml(run.token)}</strong>.</p>
            </main>`,
          ),
        );
        return;
      }
      if (url.pathname === "/tabs") {
        await sendFile(response, "tabs.html");
        return;
      }
      const warehouseMatch = url.pathname.match(
        /^\/warehouse\/(north|south|west)$/u,
      );
      if (warehouseMatch) {
        const warehouse = warehouses.get(warehouseMatch[1]);
        sendHtml(response, 200, warehousePage(warehouse));
        return;
      }
      if (url.pathname === "/upload") {
        await sendFile(response, "upload.html");
        return;
      }
      if (url.pathname === "/virtualized") {
        await sendFile(response, "virtualized.html");
        return;
      }
      if (url.pathname === "/safety") {
        await sendFile(response, "safety.html");
        return;
      }
      if (url.pathname === "/focus") {
        await sendFile(response, "focus.html");
        return;
      }
      if (url.pathname === "/occluded") {
        await sendFile(response, "occluded.html");
        return;
      }
      if (url.pathname === "/assets/benchmark.css") {
        await sendFile(response, "benchmark.css");
        return;
      }
      sendText(response, 404, "Not found");
    } catch (error) {
      sendText(
        response,
        500,
        `Benchmark server error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Benchmark server did not expose a TCP address.");
  }
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function sendFile(response, fileName) {
  const body = await readFile(join(siteRoot, fileName));
  response.writeHead(200, {
    "Content-Type":
      mimeTypes.get(extname(fileName)) ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

function sendHtml(response, status, value) {
  const body = Buffer.from(value);
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

function sendText(response, status, value) {
  const body = Buffer.from(`${value}\n`);
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("Request body exceeded 64 KiB.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function warehousePage(warehouse) {
  const rows = warehouse.rows
    .map(
      ([sku, quantity]) =>
        `<tr><th scope="row">${escapeHtml(sku)}</th><td data-quantity>${quantity}</td></tr>`,
    )
    .join("");
  return pageShell(
    `${warehouse.name} warehouse`,
    `<main class="shell narrow" data-warehouse="${warehouse.name.toLowerCase()}">
      <p class="eyebrow">Inventory satellite</p>
      <h1>${escapeHtml(warehouse.name)} warehouse</h1>
      <table>
        <thead><tr><th>SKU</th><th>Counted quantity</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>`,
  );
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/benchmark.css">
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isDirectExecution() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  const port = Number.parseInt(
    process.env.AGENT_BROWSER_BENCHMARK_PORT ?? "4173",
    10,
  );
  const server = await startBenchmarkServer({ port });
  process.stdout.write(`Benchmark server listening at ${server.origin}\n`);
}
