/**
 * Auto-link a Cursor OAuth connection with a Cursor-API-key connection when
 * they belong to the same Cursor account. Idempotent — safe to call after any
 * connection-create event.
 *
 * Matching strategy: the API key can be exchanged for the user email via
 * `https://api.cursor.com/v1/me`. We compare that against the OAuth
 * connection's stored email and, on match, write linkage metadata into
 * `providerSpecificData` on both sides so the dashboard pills render.
 */
import {
  getProviderConnections,
  getProviderConnectionById,
  updateProviderConnection,
} from "@/models";

const CURSOR_API_BASE = "https://api.cursor.com";
const CURSOR_BASE_URL_PATTERNS = [/cursor\.com/i, /standardagents\.ai/i];

type Conn = {
  id: string;
  provider: string;
  authType?: string | null;
  email?: string | null;
  apiKey?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
};

function isCursorApiConnection(conn: Conn): boolean {
  if (!conn.provider || !conn.provider.startsWith("openai-compatible-")) return false;
  const baseUrl = String(
    (conn.providerSpecificData as Record<string, unknown> | null | undefined)?.baseUrl ?? ""
  );
  return CURSOR_BASE_URL_PATTERNS.some((re) => re.test(baseUrl));
}

async function fetchCursorMe(
  apiKey: string
): Promise<{ email: string; userId?: number } | null> {
  try {
    const res = await fetch(`${CURSOR_API_BASE}/v1/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const email = typeof data?.userEmail === "string" ? data.userEmail : null;
    if (!email) return null;
    return {
      email,
      userId: typeof data?.userId === "number" ? (data.userId as number) : undefined,
    };
  } catch {
    return null;
  }
}

async function mergePsd(
  connId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const existing = (await getProviderConnectionById(connId)) as Conn | null;
  if (!existing) return;
  const existingPsd =
    (existing.providerSpecificData as Record<string, unknown> | null | undefined) || {};
  await updateProviderConnection(connId, {
    providerSpecificData: { ...existingPsd, ...patch },
  });
}

/**
 * Called after an OAuth Cursor connection is created. Scans all API-key
 * connections whose baseUrl looks like Cursor; for each, fetches its user
 * email and links if it matches the OAuth connection's email.
 */
export async function linkOAuthToApiConnections(oauthConn: Conn): Promise<void> {
  if (!oauthConn?.email) return;
  const all = (await getProviderConnections()) as Conn[];
  for (const api of all.filter(isCursorApiConnection)) {
    if (api.authType !== "apikey" || !api.apiKey) continue;
    const me = await fetchCursorMe(api.apiKey);
    if (!me || me.email.toLowerCase() !== oauthConn.email.toLowerCase()) continue;

    await mergePsd(oauthConn.id, {
      linkedApiConnectionId: api.id,
      linkedApiProvider: api.provider,
      linkedApiKeyPrefix: api.apiKey.slice(0, 12),
    });
    await mergePsd(api.id, {
      linkedOAuthConnectionId: oauthConn.id,
      linkedOAuthProvider: oauthConn.provider,
      cursorEmail: me.email,
      cursorUserId: me.userId != null ? String(me.userId) : undefined,
    });
    // One OAuth account maps to one canonical API key in practice — stop on first match.
    return;
  }
}

/**
 * Called after an API-key connection is created. If the connection looks like
 * a Cursor backend (baseUrl matches), fetches its user email and links to a
 * matching OAuth Cursor connection if present.
 */
export async function linkApiToOAuthConnections(apiConn: Conn): Promise<void> {
  if (!isCursorApiConnection(apiConn) || !apiConn.apiKey) return;
  const me = await fetchCursorMe(apiConn.apiKey);
  if (!me) return;

  const oauthConns = (await getProviderConnections({
    provider: "cursor",
  })) as Conn[];
  for (const oauth of oauthConns) {
    if (oauth.authType !== "oauth" || !oauth.email) continue;
    if (oauth.email.toLowerCase() !== me.email.toLowerCase()) continue;

    await mergePsd(oauth.id, {
      linkedApiConnectionId: apiConn.id,
      linkedApiProvider: apiConn.provider,
      linkedApiKeyPrefix: apiConn.apiKey.slice(0, 12),
    });
    await mergePsd(apiConn.id, {
      linkedOAuthConnectionId: oauth.id,
      linkedOAuthProvider: oauth.provider,
      cursorEmail: me.email,
      cursorUserId: me.userId != null ? String(me.userId) : undefined,
    });
    return;
  }
}
