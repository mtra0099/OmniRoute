"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";

type CursorAuthModalProps = {
  isOpen: boolean;
  onSuccess?: () => void;
  onClose: () => void;
  reauthConnection?: unknown;
};

type LoginPhase = "idle" | "starting" | "waiting" | "completed" | "failed";

/**
 * Cursor Auth Modal
 *
 * Primary path: "Login with Cursor" — POSTs /api/oauth/cursor/login which
 * spawns cursor-agent server-side, returns a URL the user opens in a new
 * tab. Server polls and persists the token on completion. Supports multi-
 * account (each successful login = a new connection).
 *
 * Fallback path: paste accessToken (+ optional machineId) from Cursor IDE.
 */
export default function CursorAuthModal({
  isOpen,
  onSuccess,
  onClose,
  reauthConnection: _,
}: CursorAuthModalProps) {
  const t = useTranslations("cursorAuthModal");

  // Login-with-Cursor flow state
  const [loginPhase, setLoginPhase] = useState<LoginPhase>("idle");
  const [loginUrl, setLoginUrl] = useState<string>("");
  const [loginSessionId, setLoginSessionId] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Paste-token fallback state
  const [accessToken, setAccessToken] = useState("");
  const [machineId, setMachineId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const cancelServerSession = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    try {
      await fetch(`/api/oauth/cursor/login?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    } catch {}
  }, []);

  const resetLoginState = useCallback(() => {
    stopPolling();
    setLoginPhase("idle");
    setLoginUrl("");
    setLoginSessionId("");
    setLoginError(null);
  }, [stopPolling]);

  // When the modal closes, cancel any in-flight login session on the server.
  useEffect(() => {
    if (!isOpen && loginSessionId && loginPhase === "waiting") {
      cancelServerSession(loginSessionId);
    }
    if (!isOpen) {
      resetLoginState();
      setAccessToken("");
      setMachineId("");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startLogin = async () => {
    setLoginPhase("starting");
    setLoginError(null);
    try {
      const res = await fetch("/api/oauth/cursor/login", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.loginUrl) {
        throw new Error(data.error || t("loginFailedToStart"));
      }
      setLoginUrl(data.loginUrl);
      setLoginSessionId(data.sessionId);
      setLoginPhase("waiting");
      // Open the URL in a new tab right away so the user doesn't have to click twice.
      window.open(data.loginUrl, "_blank", "noopener,noreferrer");

      pollTimerRef.current = setInterval(async () => {
        try {
          const r = await fetch(
            `/api/oauth/cursor/login?sessionId=${encodeURIComponent(data.sessionId)}`
          );
          const d = await r.json();
          if (d.status === "success") {
            stopPolling();
            setLoginPhase("completed");
            onSuccess?.();
            onClose();
          } else if (d.status === "error") {
            stopPolling();
            setLoginPhase("failed");
            setLoginError(d.error || t("loginFailed"));
          }
          // else: still pending, keep polling
        } catch {
          // transient network error — keep polling
        }
      }, 2000);
    } catch (e: any) {
      setLoginPhase("failed");
      setLoginError(e?.message || t("loginFailedToStart"));
    }
  };

  const handleImportToken = async () => {
    if (!accessToken.trim()) {
      setError(t("errorEnterToken"));
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const body: Record<string, string> = { accessToken: accessToken.trim() };
      if (machineId.trim()) body.machineId = machineId.trim();

      const res = await fetch("/api/oauth/cursor/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("errorImportFailed"));
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t("title")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* --- Login with Cursor (primary path) --- */}
        <div className="border border-border rounded-lg p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">login</span>
            <h3 className="text-base font-semibold">{t("loginSectionTitle")}</h3>
          </div>
          <p className="text-sm text-text-muted">{t("loginSectionDescription")}</p>

          {loginPhase === "idle" && (
            <Button onClick={startLogin} fullWidth>
              {t("loginWithCursor")}
            </Button>
          )}

          {loginPhase === "starting" && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              {t("loginStarting")}
            </div>
          )}

          {loginPhase === "waiting" && (
            <div className="flex flex-col gap-2">
              <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                <p className="text-sm text-blue-800 dark:text-blue-200 mb-2">
                  {t("loginOpenInBrowser")}
                </p>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono break-all text-primary underline"
                >
                  {loginUrl}
                </a>
              </div>
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                {t("loginWaiting")}
              </div>
              <Button
                onClick={async () => {
                  await cancelServerSession(loginSessionId);
                  resetLoginState();
                }}
                variant="ghost"
                fullWidth
              >
                {t("loginCancel")}
              </Button>
            </div>
          )}

          {loginPhase === "failed" && (
            <>
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{loginError}</p>
              </div>
              <Button onClick={resetLoginState} fullWidth>
                {t("loginRetry")}
              </Button>
            </>
          )}
        </div>

        {/* --- Divider --- */}
        <div className="flex items-center gap-2 my-1">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-text-muted uppercase tracking-wide">{t("or")}</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* --- Paste token (fallback path) --- */}
        <details className="border border-border rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
            {t("pasteTokenSectionTitle")}
          </summary>
          <div className="px-4 pb-4 flex flex-col gap-3">
            <p className="text-xs text-text-muted">{t("pasteTokenSectionDescription")}</p>

            <div>
              <label className="block text-sm font-medium mb-2">
                {t("accessToken")} <span className="text-red-500">{t("required")}</span>
              </label>
              <textarea
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={t("accessTokenPlaceholder")}
                rows={3}
                className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                {t("machineId")} <span className="text-text-muted text-xs">{t("optional")}</span>
              </label>
              <Input
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                placeholder={t("machineIdPlaceholder")}
                className="font-mono text-sm"
              />
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleImportToken}
                fullWidth
                disabled={importing || !accessToken.trim()}
              >
                {importing ? t("importing") : t("importToken")}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                {t("cancel")}
              </Button>
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}
