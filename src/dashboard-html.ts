/**
 * Renders a self-contained HTML dashboard page with inline CSS and JS.
 * The page connects to /api/events via SSE for live status updates.
 */
export function renderDashboardHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(name)} — Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { font-size: 1.4rem; margin-bottom: 16px; color: #f0f6fc; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; font-size: 0.9rem; }
  .summary .badge { padding: 4px 10px; border-radius: 4px; font-weight: 600; }
  .succeeded { background: #1b4332; color: #2dd4bf; }
  .failed { background: #4c1d1d; color: #f87171; }
  .running { background: #3b2f00; color: #fbbf24; }
  .pending-badge { background: #1e293b; color: #94a3b8; }
  .skipped { background: #1e293b; color: #64748b; }

  .waves { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
  .wave { min-width: 260px; }
  .wave h2 { font-size: 0.85rem; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }

  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; margin-bottom: 10px; transition: border-color 0.3s; }
  .card.status-succeeded { border-left: 3px solid #2dd4bf; }
  .card.status-failed { border-left: 3px solid #f87171; }
  .card.status-running { border-left: 3px solid #fbbf24; }
  .card.status-pending { border-left: 3px solid #30363d; }
  .card.status-skipped { border-left: 3px solid #64748b; }
  .card.status-interrupted { border-left: 3px solid #fb923c; }

  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .card-number { font-weight: 700; color: #58a6ff; }
  .card-status { font-size: 0.75rem; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
  .card-desc { font-size: 0.85rem; color: #8b949e; margin-bottom: 6px; }
  .card-meta { font-size: 0.75rem; color: #484f58; }
  .card-meta a { color: #58a6ff; text-decoration: none; }
  .card-meta a:hover { text-decoration: underline; }

  .log-toggle { font-size: 0.75rem; color: #58a6ff; cursor: pointer; border: none; background: none; margin-top: 6px; }
  .log-toggle:hover { text-decoration: underline; }
  .log-content { display: none; margin-top: 8px; padding: 8px; background: #0d1117; border-radius: 4px; font-size: 0.75rem; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; color: #8b949e; }

  .connected { color: #2dd4bf; }
  .disconnected { color: #f87171; }
  .conn-status { position: fixed; top: 12px; right: 24px; font-size: 0.75rem; }
</style>
</head>
<body>
<h1>${escapeHtml(name)}</h1>
<div class="summary" id="summary"></div>
<div class="conn-status" id="conn-status"></div>
<div class="waves" id="waves"></div>

<script>
(function() {
  let issues = [];
  let config = {};
  let statusMap = {};
  let metadataMap = {};

  function escHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function statusClass(s) {
    return "status-" + (s || "pending");
  }

  function statusBadgeClass(s) {
    if (s === "pending") return "pending-badge";
    return s || "pending-badge";
  }

  function render() {
    // Group by wave
    const waves = {};
    for (const issue of issues) {
      const w = issue.wave || 1;
      if (!waves[w]) waves[w] = [];
      waves[w].push(issue);
    }

    // Summary counts
    const counts = { succeeded: 0, failed: 0, running: 0, pending: 0, skipped: 0, interrupted: 0 };
    for (const issue of issues) {
      const s = statusMap[issue.number] || "pending";
      counts[s] = (counts[s] || 0) + 1;
    }

    document.getElementById("summary").innerHTML =
      '<span class="badge succeeded">Succeeded: ' + counts.succeeded + '</span>' +
      '<span class="badge failed">Failed: ' + counts.failed + '</span>' +
      '<span class="badge running">Running: ' + counts.running + '</span>' +
      '<span class="badge pending-badge">Pending: ' + counts.pending + '</span>' +
      '<span class="badge skipped">Skipped: ' + counts.skipped + '</span>' +
      '<span>Total: ' + issues.length + '</span>';

    const container = document.getElementById("waves");
    container.innerHTML = "";

    const sortedWaves = Object.keys(waves).map(Number).sort((a, b) => a - b);
    for (const w of sortedWaves) {
      const div = document.createElement("div");
      div.className = "wave";
      div.innerHTML = "<h2>Wave " + w + "</h2>";

      for (const issue of waves[w]) {
        const s = statusMap[issue.number] || "pending";
        const meta = metadataMap[issue.number] || {};
        const card = document.createElement("div");
        card.className = "card " + statusClass(s);
        card.id = "card-" + issue.number;

        let metaHtml = "";
        if (meta.prUrl) {
          metaHtml += '<a href="' + escHtml(meta.prUrl) + '" target="_blank">PR</a> ';
        }
        if (meta.startedAt) {
          metaHtml += "Started: " + new Date(meta.startedAt).toLocaleTimeString() + " ";
        }
        if (meta.retryCount) {
          metaHtml += "Retries: " + meta.retryCount + " ";
        }

        card.innerHTML =
          '<div class="card-header">' +
            '<span class="card-number">#' + issue.number + ' ' + escHtml(issue.slug) + '</span>' +
            '<span class="card-status ' + statusBadgeClass(s) + '">' + s.toUpperCase() + '</span>' +
          '</div>' +
          '<div class="card-desc">' + escHtml(issue.description) + '</div>' +
          '<div class="card-meta">' + metaHtml + '</div>' +
          '<button class="log-toggle" onclick="toggleLog(' + issue.number + ')">Show log</button>' +
          '<pre class="log-content" id="log-' + issue.number + '"></pre>';

        div.appendChild(card);
      }
      container.appendChild(div);
    }
  }

  window.toggleLog = function(issueNumber) {
    const el = document.getElementById("log-" + issueNumber);
    if (!el) return;
    if (el.style.display === "block") {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.textContent = "Loading...";
    fetch("/api/logs/" + issueNumber)
      .then(function(r) { return r.text(); })
      .then(function(t) { el.textContent = t || "(no log output)"; })
      .catch(function() { el.textContent = "(failed to load)"; });
  };

  // Initial load
  fetch("/api/config")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      config = data;
      issues = data.issues || [];
      return fetch("/api/status");
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      for (const entry of data) {
        statusMap[entry.number] = entry.status;
        metadataMap[entry.number] = entry.metadata || {};
      }
      render();
    })
    .catch(function(err) { console.error("Init failed:", err); });

  // SSE
  const connEl = document.getElementById("conn-status");
  const es = new EventSource("/api/events");
  es.onopen = function() { connEl.innerHTML = '<span class="connected">\\u25cf connected</span>'; };
  es.onerror = function() { connEl.innerHTML = '<span class="disconnected">\\u25cf disconnected</span>'; };
  es.addEventListener("status", function(e) {
    const data = JSON.parse(e.data);
    for (const entry of data) {
      statusMap[entry.number] = entry.status;
      if (entry.metadata) metadataMap[entry.number] = entry.metadata;
    }
    render();
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
