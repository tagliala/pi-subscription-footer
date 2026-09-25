/**
 * ChatGPT subscription quota and DeepSeek prepaid balance in pi's own footer.
 *
 * ctx.ui.setStatus() appends a line below pi's built-in footer stats, so this
 * sits next to the token/cost/model line instead of replacing the footer. The
 * whole line is wrapped in the theme's dim colour to match the footer.
 *
 * Nothing is rendered when the account has no paid ChatGPT plan, or when a
 * credential is missing or rejected: an absent provider is not an error.
 *
 * The parsing and formatting helpers below are pure and exported so they can be
 * unit-tested without touching the network, the clock or pi.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "subscription";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

const PLAN_LABELS: Record<string, string> = {
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export interface RateWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export interface RateLimit {
  primary_window?: RateWindow | null;
  secondary_window?: RateWindow | null;
}

export function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}

/** `↺45m`, `↺3h`, `↺2d`, or "" when the response carries no usable reset. */
export function formatResetsIn(window: RateWindow, nowMs: number = Date.now()): string {
  let seconds = window.reset_after_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    seconds = typeof window.reset_at === "number" ? window.reset_at - nowMs / 1000 : Number.NaN;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 3600) return `↺${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < DAY_SECONDS) return `↺${Math.round(seconds / 3600)}h`;
  return `↺${Math.round(seconds / DAY_SECONDS)}d`;
}

/** A rolling (< weekly) window and the weekly window, by declared duration. */
export function splitCodexWindows(rateLimit: RateLimit | null | undefined): {
  rolling: RateWindow | null;
  weekly: RateWindow | null;
} {
  const windows = [rateLimit?.primary_window, rateLimit?.secondary_window].filter(
    (window): window is RateWindow => !!window && typeof window === "object",
  );
  const isWeekly = (window: RateWindow) =>
    typeof window.limit_window_seconds === "number" &&
    Math.abs(window.limit_window_seconds - WEEK_SECONDS) <= DAY_SECONDS;
  const isRolling = (window: RateWindow) =>
    typeof window.limit_window_seconds === "number" &&
    window.limit_window_seconds > 0 &&
    window.limit_window_seconds < WEEK_SECONDS - DAY_SECONDS;

  const rolling = windows.find(isRolling) ?? null;
  const weekly = windows.find(isWeekly) ?? null;
  // Responses without duration metadata carry a single window: treat it as weekly.
  if (!rolling && !weekly && windows.length > 0) return { rolling: null, weekly: windows[0]! };
  return { rolling, weekly };
}

function rollingWindowLabel(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "rolling";
  if (seconds >= DAY_SECONDS && seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.max(1, Math.ceil(seconds / 60))}m`;
}

export function codexWindowPart(
  name: string,
  window: RateWindow | null,
  nowMs: number = Date.now(),
): string | null {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) {
    return null;
  }
  const remaining = 100 - Math.min(100, Math.max(0, window.used_percent));
  const resets = formatResetsIn(window, nowMs);
  return `${name} ${Math.round(remaining)}%${resets ? ` ${resets}` : ""}`;
}

/**
 * The ChatGPT part of the footer line, or null when the account has no paid
 * plan or the payload has no usable quota window.
 */
export function parseChatgptUsage(body: unknown, nowMs: number = Date.now()): string | null {
  const payload = body as {
    plan_type?: unknown;
    rate_limit?: RateLimit | null;
    rate_limit_reset_credits?: { available_count?: unknown } | null;
  } | null;

  const plan = typeof payload?.plan_type === "string" ? payload.plan_type.toLowerCase() : "";
  if (!plan || plan === "free") return null;

  const { rolling, weekly } = splitCodexWindows(payload?.rate_limit);
  const parts = [
    codexWindowPart(rollingWindowLabel(rolling?.limit_window_seconds), rolling, nowMs),
    codexWindowPart("wk", weekly, nowMs),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;

  const banked = payload?.rate_limit_reset_credits?.available_count;
  const grants = typeof banked === "number" && banked > 0 ? ` +${banked}r` : "";
  return `ChatGPT ${planLabel(plan)} ${parts.join(" · ")}${grants}`;
}

/**
 * The DeepSeek part of the footer line, or null when the payload has no balance.
 * The symbol follows the currency the API reports: USD accounts must not show ¥.
 */
export function parseDeepseekBalance(body: unknown): string | null {
  const payload = body as {
    is_available?: unknown;
    balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>;
  } | null;

  if (payload?.is_available === false) return "DeepSeek ⚠ unavailable";
  const balances = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const parts = balances.flatMap((info) => {
    if (!info || (typeof info.total_balance !== "string" && typeof info.total_balance !== "number")) {
      return [];
    }
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount) || (typeof info.total_balance === "string" && !info.total_balance.trim())) {
      return [];
    }
    const symbol =
      info.currency === "USD"
        ? "$"
        : info.currency === "CNY"
          ? "¥"
          : typeof info.currency === "string" && info.currency
            ? `${info.currency} `
            : "";
    return [`${symbol}${amount.toFixed(2)}`];
  });
  return parts.length ? `DeepSeek ${parts.join(" · ")}` : null;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readAuth(): Record<string, unknown> {
  const path = join(agentDir(), "auth.json");
  if (!existsSync(path)) return {};
  try {
    const auth: unknown = JSON.parse(readFileSync(path, "utf8"));
    return auth && typeof auth === "object" && !Array.isArray(auth)
      ? auth as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface CodexCredentials {
  access: string;
  accountId: string;
}

export function readCodexCredentials(): CodexCredentials | null {
  const entry = readAuth()["openai-codex"] as
    | { type?: string; access?: string; accountId?: string; account_id?: string }
    | undefined;
  const accountId = entry?.accountId ?? entry?.account_id;
  if (entry?.type !== "oauth" || typeof entry.access !== "string" || !entry.access) return null;
  if (typeof accountId !== "string" || !accountId) return null;
  return { access: entry.access, accountId };
}

export function resolveDeepseekKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.PI_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv;
  const stored = (readAuth().deepseek as { key?: string } | undefined)?.key;
  return typeof stored === "string" && stored ? stored : null;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status !== 200) return { status: res.status, body: undefined };
    try {
      return { status: res.status, body: await res.json() };
    } catch {
      return { status: res.status, body: undefined };
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatgptPart(nowMs: number = Date.now()): Promise<string | null> {
  const credentials = readCodexCredentials();
  if (!credentials) return null;

  const res = await getJson(CODEX_USAGE_URL, {
    accept: "application/json",
    authorization: `Bearer ${credentials.access}`,
    "chatgpt-account-id": credentials.accountId,
  });
  // 401/403 mean an expired login: stay quiet instead of showing a broken line.
  if (!res || res.status !== 200) return null;
  return parseChatgptUsage(res.body, nowMs);
}

export async function deepseekPart(): Promise<string | null> {
  const key = resolveDeepseekKey();
  if (!key) return null;

  const res = await getJson(DEEPSEEK_BALANCE_URL, {
    accept: "application/json",
    authorization: `Bearer ${key}`,
  });
  if (!res || res.status !== 200) return null;
  return parseDeepseekBalance(res.body);
}

export default function register(pi: ExtensionAPI) {
  type Interval = ReturnType<typeof setInterval> & { unref?: () => void };
  let timer: Interval | null = null;
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
      // Keep the row but never show unverified values after credentials or data disappear.
      if (parts.length === 0 && !lastText) return;
      const content = parts.length ? parts.join("  ") : "Subscription data unavailable";
      const text = ctx.ui.theme.fg("dim", content);
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
    timer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS) as Interval;
    // The refresh timer must never keep the process alive on its own.
    timer.unref?.();
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
