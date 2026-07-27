import http from "node:http";
import type { DashboardDeps, DashboardOptions, DashboardHandle } from "./dashboard-types.js";
import { renderDashboardHtml } from "./dashboard-html.js";

/**
 * Create a read-only HTTP dashboard server with SSE-based live updates.
 *
 * Routes:
 * - `GET /` — Single-page HTML dashboard
 * - `GET /api/status` — JSON array of issue statuses with metadata
 * - `GET /api/config` — JSON config (issues, waves, name)
 * - `GET /api/logs/:issue` — Last 8KB of log file as text
 * - `GET /api/metadata/:issue` — JSON metadata for an issue
 * - `GET /api/events` — SSE endpoint, polls every 2s and emits on changes
 */
export function createDashboardServer(
  deps: DashboardDeps,
  options: DashboardOptions = {},
): Promise<DashboardHandle> {
  const { statusStore, metadataStore, config, logger, readLogTail } = deps;
  const port = options.port ?? 3000;
  const host = options.host ?? "127.0.0.1";

  const sseClients = new Set<http.ServerResponse>();
  const intervals = new Set<ReturnType<typeof setInterval>>();

  function getStatusSnapshot(): Array<{ number: number; status: string; metadata: Record<string, unknown> }> {
    return config.issues.map((issue) => ({
      number: issue.number,
      slug: issue.slug,
      status: statusStore.get(issue.number),
      metadata: metadataStore.get(issue.number) as Record<string, unknown>,
    }));
  }

  const htmlContent = renderDashboardHtml(config.name);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlContent);
      return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatusSnapshot()));
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: config.name,
        issues: config.issues.map((i) => ({
          number: i.number,
          slug: i.slug,
          description: i.description,
          wave: i.wave,
          deps: i.deps,
        })),
      }));
      return;
    }

    const logsMatch = pathname.match(/^\/api\/logs\/(\d+)$/);
    if (logsMatch && req.method === "GET") {
      const issueNumber = parseInt(logsMatch[1], 10);
      try {
        const logTail = readLogTail(issueNumber, 8192);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(logTail);
      } catch {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("(no log output)");
      }
      return;
    }

    const metaMatch = pathname.match(/^\/api\/metadata\/(\d+)$/);
    if (metaMatch && req.method === "GET") {
      const issueNumber = parseInt(metaMatch[1], 10);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metadataStore.get(issueNumber)));
      return;
    }

    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(":\n\n"); // SSE comment to establish connection

      sseClients.add(res);

      // Poll for changes every 2 seconds
      let lastSnapshot = JSON.stringify(getStatusSnapshot());

      const interval = setInterval(() => {
        const current = JSON.stringify(getStatusSnapshot());
        if (current !== lastSnapshot) {
          lastSnapshot = current;
          res.write(`event: status\ndata: ${current}\n\n`);
        }
      }, 2000);

      intervals.add(interval);

      req.on("close", () => {
        clearInterval(interval);
        intervals.delete(interval);
        sseClients.delete(res);
      });

      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise<DashboardHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      logger.info(`Dashboard running at http://${host}:${port}`);
      resolve({
        port,
        async close() {
          // Clean up SSE intervals
          for (const interval of intervals) {
            clearInterval(interval);
          }
          intervals.clear();

          // Close SSE connections
          for (const client of sseClients) {
            client.end();
          }
          sseClients.clear();

          // Close server
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
