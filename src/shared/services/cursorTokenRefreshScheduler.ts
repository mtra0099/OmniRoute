/**
 * Periodically refresh accessTokens for OAuth-imported Cursor connections.
 *
 * Mechanism: Cursor's session access tokens expire in 24-72h. The user's
 * cursor-agent CLI knows how to refresh them transparently when invoked.
 * For each OAuth Cursor connection we kept a persistent `HOME` from the
 * original login (path stored in `providerSpecificData.cursorAgentHomeDir`),
 * we spawn `cursor-agent status` against that HOME on a timer. cursor-agent
 * reads its auth.json, refreshes if the accessToken is near expiry, and
 * writes the rotated token back. We then re-read auth.json and sync the new
 * accessToken into OmniRoute's DB.
 *
 * No public Cursor refresh endpoint exists — this is the cleanest path that
 * works with what cursor-agent already does for itself.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getProviderConnections, updateProviderConnection } from "@/models";

type Conn = {
  id: string;
  provider: string;
  authType?: string | null;
  accessToken?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
};

const HOMES_ROOT =
  process.env.CURSOR_AGENT_HOMES_DIR || "/app/data/cursor-agent-homes";

const REFRESH_INTERVAL_MS = (() => {
  const raw = Number(process.env.CURSOR_TOKEN_REFRESH_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
})();

const INITIAL_DELAY_MS = 30_000;

function homeDirFor(conn: Conn): string | null {
  const psd =
    (conn.providerSpecificData as { cursorAgentHomeDir?: unknown } | null | undefined) ?? null;
  const raw = psd?.cursorAgentHomeDir;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readAuthFile(
  homeDir: string
): { accessToken?: string; expiresIn?: number } | null {
  const p = join(homeDir, ".config", "cursor", "auth.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as {
      accessToken?: string;
      expiresIn?: number;
    };
  } catch {
    return null;
  }
}

async function refreshOne(conn: Conn): Promise<void> {
  const homeDir = homeDirFor(conn);
  if (!homeDir || !existsSync(homeDir)) return;

  // `cursor-agent status` reads auth.json, refreshes if needed, writes back.
  // We use --no-color to keep stdout small; status output itself is discarded.
  const result = spawnSync("cursor-agent", ["status"], {
    env: {
      ...process.env,
      HOME: homeDir,
      NO_OPEN_BROWSER: "1",
      CURSOR_NO_COLOR: "1",
    },
    timeout: 30_000,
    stdio: "ignore",
  });
  if (result.error || (result.status !== 0 && result.status !== null)) {
    console.warn(
      `[CursorRefresh] cursor-agent status non-zero (status=${result.status} signal=${result.signal}) for ${conn.id}`
    );
    // Continue: auth.json might still have been refreshed before failure
  }

  const auth = readAuthFile(homeDir);
  if (!auth?.accessToken) return;
  if (auth.accessToken === conn.accessToken) return;

  const expiresInSec =
    typeof auth.expiresIn === "number" && auth.expiresIn > 0 ? auth.expiresIn : 86400;

  await updateProviderConnection(conn.id, {
    accessToken: auth.accessToken,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    tokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    testStatus: "active",
  });
  console.log(
    `[CursorRefresh] Rotated accessToken for connection ${conn.id} (expires in ${expiresInSec}s)`
  );
}

async function tick(): Promise<void> {
  let conns: Conn[] = [];
  try {
    conns = (await getProviderConnections({ provider: "cursor" })) as Conn[];
  } catch (e) {
    console.warn("[CursorRefresh] failed to load connections:", e);
    return;
  }
  for (const conn of conns) {
    if (conn.authType !== "oauth") continue;
    try {
      await refreshOne(conn);
    } catch (e) {
      console.warn(`[CursorRefresh] refresh failed for ${conn.id}:`, e);
    }
  }
}

export function startCursorTokenRefreshScheduler(): void {
  try {
    mkdirSync(HOMES_ROOT, { recursive: true });
  } catch {
    // best-effort
  }
  setTimeout(() => {
    void tick();
  }, INITIAL_DELAY_MS);
  setInterval(() => {
    void tick();
  }, REFRESH_INTERVAL_MS);
  const hours = Math.round(REFRESH_INTERVAL_MS / 3_600_000);
  console.log(`[CursorRefresh] Scheduler started — interval: ${hours}h`);
}
