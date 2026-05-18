import { NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { CursorService } from "@/lib/oauth/services/cursor";
import { createProviderConnection, isCloudEnabled, resolveProxyForProvider } from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { isAuthRequired, isAuthenticated } from "@/shared/utils/apiAuth";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";

/**
 * Driver for the "Login with Cursor" flow. Spawns `cursor-agent login` under
 * an isolated HOME so multiple accounts can be added without clobbering each
 * other's auth.json. Parses the login URL from stdout, surfaces it to the
 * dashboard, then waits for the CLI to write auth.json — at which point the
 * existing CursorService import logic is reused to persist the connection.
 *
 * Multi-account note: each session gets its own tempdir HOME. After login,
 * the token is copied into OmniRoute's DB and the tempdir is removed, so the
 * "single auth.json" constraint of cursor-agent never bites us.
 */

const URL_PREFIX = "Open a browser and navigate to this link: ";
const SESSION_TTL_MS = 5 * 60 * 1000;
const URL_WAIT_MS = 15 * 1000;

type SessionStatus = "pending" | "success" | "error";

type Session = {
  id: string;
  status: SessionStatus;
  loginUrl?: string;
  homeDir: string;
  child: ChildProcess | null;
  createdAt: number;
  error?: string;
  connection?: { id: string; provider: string; email: string | null };
};

const sessions: Map<string, Session> = new Map();

function reapExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      try {
        s.child?.kill("SIGTERM");
      } catch {}
      rm(s.homeDir, { recursive: true, force: true }).catch(() => {});
      sessions.delete(id);
    }
  }
}

async function requireAuth(request: Request): Promise<NextResponse | null> {
  if (!(await isAuthRequired(request))) return null;
  if (await isAuthenticated(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function persistFromAuthJson(session: Session): Promise<void> {
  const authPath = join(session.homeDir, ".config", "cursor", "auth.json");
  const raw = await readFile(authPath, "utf-8");
  const auth = JSON.parse(raw);
  if (typeof auth.accessToken !== "string" || auth.accessToken.length < 50) {
    throw new Error("cursor-agent wrote auth.json without a valid accessToken");
  }

  const service = new CursorService();
  const proxy = await resolveProxyForProvider("cursor");

  const tokenData = await runWithProxyContext(proxy, () =>
    service.validateImportToken(auth.accessToken, undefined)
  );

  const jwtInfo = service.extractUserInfo(tokenData.accessToken);
  const profile = jwtInfo?.userId
    ? await runWithProxyContext(proxy, () =>
        service.fetchUserInfo(tokenData.accessToken, jwtInfo.userId)
      )
    : null;
  const email = profile?.email || jwtInfo?.email || null;

  const conn: any = await createProviderConnection({
    provider: "cursor",
    authType: "oauth",
    accessToken: tokenData.accessToken,
    refreshToken: null,
    expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000).toISOString(),
    email,
    providerSpecificData: {
      machineId: null,
      authMethod: "cursor-agent",
      provider: "cursor-agent-login",
      userId: jwtInfo?.userId,
    },
    testStatus: "active",
  });

  session.connection = { id: conn.id, provider: conn.provider, email: conn.email };
  session.status = "success";

  try {
    if (await isCloudEnabled()) {
      const mid = await getConsistentMachineId();
      await syncToCloud(mid);
    }
  } catch {}
}

/**
 * POST /api/oauth/cursor/login
 * Starts a login session. Returns { sessionId, loginUrl } once cursor-agent
 * has printed the URL (typically <1s).
 */
export async function POST(request: Request) {
  const authErr = await requireAuth(request);
  if (authErr) return authErr;

  reapExpired();

  const sessionId = randomUUID();
  const homeDir = await mkdtemp(join(tmpdir(), `cursor-login-${sessionId}-`));

  let child: ChildProcess;
  try {
    child = spawn("cursor-agent", ["login"], {
      env: { ...process.env, HOME: homeDir, NO_OPEN_BROWSER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    await rm(homeDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json(
      {
        error: `Failed to spawn cursor-agent: ${e?.message || "unknown"}. Is cursor-agent installed and on PATH?`,
      },
      { status: 500 }
    );
  }

  const session: Session = {
    id: sessionId,
    status: "pending",
    homeDir,
    child,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf-8");
    if (!session.loginUrl) {
      const idx = stdoutBuffer.indexOf(URL_PREFIX);
      if (idx >= 0) {
        const rest = stdoutBuffer.slice(idx + URL_PREFIX.length);
        const end = rest.search(/\s/);
        const candidate = end >= 0 ? rest.slice(0, end) : rest;
        if (candidate.startsWith("http")) session.loginUrl = candidate;
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    session.error = (session.error || "") + chunk.toString("utf-8");
  });

  child.on("error", (err) => {
    session.status = "error";
    session.error = (session.error || "") + `\nspawn error: ${err.message}`;
  });

  child.on("exit", async (code, signal) => {
    if (session.status !== "pending") return;
    try {
      await persistFromAuthJson(session);
    } catch (e: any) {
      session.status = "error";
      const detail = e?.message || String(e);
      session.error = session.error
        ? `${session.error}\n${detail}`
        : `cursor-agent exited (code=${code}, signal=${signal}): ${detail}`;
    } finally {
      rm(session.homeDir, { recursive: true, force: true }).catch(() => {});
      session.child = null;
    }
  });

  await new Promise<void>((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (session.loginUrl || session.status !== "pending") return resolve();
      if (Date.now() - start >= URL_WAIT_MS) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });

  if (!session.loginUrl) {
    try {
      session.child?.kill("SIGTERM");
    } catch {}
    session.status = "error";
    if (!session.error) session.error = "cursor-agent did not print a login URL within timeout";
    rm(session.homeDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json({ error: session.error }, { status: 500 });
  }

  return NextResponse.json({
    sessionId,
    loginUrl: session.loginUrl,
    expiresInMs: SESSION_TTL_MS,
  });
}

/**
 * GET /api/oauth/cursor/login?sessionId=...
 * Poll the status of an in-flight login session.
 */
export async function GET(request: Request) {
  const authErr = await requireAuth(request);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ status: "error", error: "sessionId required" }, { status: 400 });
  }

  reapExpired();
  const s = sessions.get(sessionId);
  if (!s) {
    return NextResponse.json(
      { status: "error", error: "session not found or expired" },
      { status: 404 }
    );
  }

  if (s.status === "success") {
    return NextResponse.json({ status: "success", connection: s.connection });
  }
  if (s.status === "error") {
    return NextResponse.json({ status: "error", error: s.error || "unknown error" });
  }
  return NextResponse.json({ status: "pending", loginUrl: s.loginUrl });
}

/**
 * DELETE /api/oauth/cursor/login?sessionId=...
 * Cancel a pending session (user closed the modal before completing).
 */
export async function DELETE(request: Request) {
  const authErr = await requireAuth(request);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  const s = sessions.get(sessionId);
  if (!s) return NextResponse.json({ ok: true });
  try {
    s.child?.kill("SIGTERM");
  } catch {}
  rm(s.homeDir, { recursive: true, force: true }).catch(() => {});
  sessions.delete(sessionId);
  return NextResponse.json({ ok: true });
}
