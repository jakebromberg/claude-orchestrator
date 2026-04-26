import type { DashboardDeps, DashboardOptions, DashboardHandle } from "./dashboard-types.js";
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
export declare function createDashboardServer(deps: DashboardDeps, options?: DashboardOptions): Promise<DashboardHandle>;
