/**
 * ChatGPT subscription quota and DeepSeek balance in pi's own footer.
 *
 * ctx.ui.setStatus() appends a line below pi's built-in footer stats, so this
 * sits next to the token/cost/model line instead of replacing the footer.
 *
 * Nothing is rendered when the account has no paid ChatGPT plan, or when a
 * credential is missing or rejected: an absent provider is not an error.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "subscription";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const PLAN_LABELS: Record<string, string> = {
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

interface RateWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readAuth(): Record<string, unknown> {
  const path = join(agentDir(), "auth.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    let body: any;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatResetsIn(window: RateWindow): string {
  let seconds = window.reset_after_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    seconds = typeof window.reset_at === "number" ? window.reset_at - Date.now() / 1000 : Number.NaN;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 3600) return `↺${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `↺${Math.round(seconds / 3600)}h`;
  return `↺${Math.round(seconds / 86_400)}d`;
}

function windowPart(name: string, window: RateWindow | null): string | null {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) {
    return null;
  }
  const used = Math.min(100, Math.max(0, window.used_percent));
  const resets = formatResetsIn(window);
  return `${name} ${Math.round(used)}%${resets ? ` ${resets}` : ""}`;
}

/** A rolling (< weekly) window and the weekly window, by declared duration. */
function splitCodexWindows(rateLimit: any): { rolling: RateWindow | null; weekly: RateWindow | null } {
  const windows = [rateLimit?.primary_window, rateLimit?.secondary_window].filter(
    (w: unknown): w is RateWindow => !!w && typeof w === "object",
  );
  const isWeekly = (w: RateWindow) =>
    typeof w.limit_window_seconds === "number" && Math.abs(w.limit_window_seconds - WEEK_SECONDS) <= 86_400;
  const isRolling = (w: RateWindow) =>
    typeof w.limit_window_seconds === "number" &&
    w.limit_window_seconds > 0 &&
    w.limit_window_seconds < WEEK_SECONDS - 86_400;

  const rolling = windows.find(isRolling) ?? null;
  const weekly = windows.find(isWeekly) ?? null;
  // Responses without duration metadata carry a single window: treat it as weekly.
  if (!rolling && !weekly && windows.length > 0) return { rolling: null, weekly: windows[0]! };
  return { rolling, weekly };
}

async function chatgptPart(): Promise<string | null> {
  const entry = readAuth()["openai-codex"] as
    | { type?: string; access?: string; accountId?: string; account_id?: string }
    | undefined;
  const accountId = entry?.accountId ?? entry?.account_id;
  if (entry?.type !== "oauth" || typeof entry.access !== "string" || !entry.access) return null;
  if (typeof accountId !== "string" || !accountId) return null;

  const res = await getJson(CODEX_USAGE_URL, {
    accept: "application/json",
    authorization: `Bearer ${entry.access}`,
    "chatgpt-account-id": accountId,
  });
  // 401/403 mean an expired login: stay quiet instead of showing a broken line.
  if (!res || res.status !== 200 || !res.body) return null;

  const plan = typeof res.body.plan_type === "string" ? res.body.plan_type.toLowerCase() : "";
  if (!plan || plan === "free") return null;

  const { rolling, weekly } = splitCodexWindows(res.body.rate_limit);
  const parts = [windowPart("5h", rolling), windowPart("wk", weekly)].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) return null;

  const banked = res.body.rate_limit_reset_credits?.available_count;
  const grants = typeof banked === "number" && banked > 0 ? ` +${banked}r` : "";
  return `ChatGPT ${PLAN_LABELS[plan] ?? plan} ${parts.join(" · ")}${grants}`;
}

function deepseekKey(): string | null {
  const fromEnv = process.env.PI_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv;
  const stored = (readAuth().deepseek as { key?: string } | undefined)?.key;
  return typeof stored === "string" && stored ? stored : null;
}

async function deepseekPart(): Promise<string | null> {
  const key = deepseekKey();
  if (!key) return null;

  const res = await getJson(DEEPSEEK_BALANCE_URL, {
    accept: "application/json",
    authorization: `Bearer ${key}`,
  });
  if (!res || res.status !== 200 || !res.body) return null;

  const info = Array.isArray(res.body.balance_infos) ? res.body.balance_infos[0] : undefined;
  if (!info) return null;
  if (res.body.is_available === false) return "DeepSeek ⚠ unavailable";

  // The balance API reports the currency: DeepSeek USD accounts exist, so never hardcode ¥.
  const symbol = info.currency === "USD" ? "$" : info.currency === "CNY" ? "¥" : `${info.currency ?? ""} `;
  const amount = Number(info.total_balance);
  if (!Number.isFinite(amount)) return null;
  return `DeepSeek ${symbol}${amount.toFixed(2)}`;
}

export default function register(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFetchedAt = 0;
  let lastText = "";
  let refreshing = false;
  let stopped = false;

  async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
    if (ctx.mode !== "tui" || stopped || refreshing) return;
    if (!force && Date.now() - lastFetchedAt < MIN_REFRESH_MS) return;

    refreshing = true;
    try {
      const [chatgpt, deepseek] = await Promise.all([chatgptPart(), deepseekPart()]);
      lastFetchedAt = Date.now();
      if (stopped) return;
      const parts = [chatgpt, deepseek].filter((part): part is string => part !== null);
      // Never remove an existing line: a footer that changes height shifts the
      // whole transcript and leaves blank rows behind.
      if (parts.length === 0) return;
      // Match the footer's own stats line, which is rendered entirely with theme.fg("dim").
      const text = ctx.ui.theme.fg("dim", parts.join("  "));
      if (text === lastText) return;
      lastText = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // A usage lookup must never break the session.
    } finally {
      refreshing = false;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopped = false;
    if (timer) clearInterval(timer);
    void refresh(ctx, true);
    timer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
  });

  // Refresh at the start of a run, not at agent_end: writing the status while
  // the final frame is being drawn resizes the footer and leaves blank rows.
  pi.on("agent_start", (_event, ctx) => void refresh(ctx));
  pi.on("model_select", (_event, ctx) => void refresh(ctx));

  pi.on("session_shutdown", () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
