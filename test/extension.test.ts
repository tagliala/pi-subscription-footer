import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import register, {
  CODEX_USAGE_URL,
  DEEPSEEK_BALANCE_URL,
  STATUS_KEY,
} from "../extensions/subscription-status.ts";

const REAL_FETCH = globalThis.fetch;
const REAL_ENV = { ...process.env };

const WEEK = 7 * 24 * 60 * 60;

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = REAL_FETCH;
  for (const key of ["PI_CODING_AGENT_DIR", "PI_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"]) {
    if (REAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = REAL_ENV[key];
  }
});

function writeAuth(content: Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-footer-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(content));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
}

function codexCredentials(): Record<string, unknown> {
  return { "openai-codex": { type: "oauth", access: "token", accountId: "acct" } };
}

function deepseekCredential(): Record<string, unknown> {
  return { deepseek: { type: "api_key", key: "sk-stored" } };
}

interface Route {
  status?: number;
  body?: unknown;
}

function stubFetch(routes: Route[]): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    const route = routes[calls.length - 1] ?? routes[0] ?? {};
    return {
      status: route.status ?? 200,
      json: async () => route.body,
    };
  }) as typeof fetch;
  return calls;
}

function fakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    events: { on: () => () => {}, emit: () => {} },
  };
}

function fakeCtx(mode: "tui" | "print" = "tui") {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const colors: string[] = [];
  return {
    statuses,
    colors,
    ctx: {
      mode,
      ui: {
        theme: {
          fg(color: string, text: string) {
            colors.push(color);
            return `\u001b[2m${text}\u001b[0m`;
          },
        },
        setStatus(key: string, text?: string) {
          statuses.push({ key, text });
        },
      },
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const codexBody = {
  plan_type: "prolite",
  rate_limit: { primary_window: { used_percent: 51, limit_window_seconds: WEEK } },
};
const deepseekBody = { is_available: true, balance_infos: [{ currency: "USD", total_balance: "5.27" }] };

test("renders both providers into one dim status line", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx, statuses, colors } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.deepEqual(calls, [CODEX_USAGE_URL, DEEPSEEK_BALANCE_URL]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.key, STATUS_KEY);
  assert.equal(statuses[0]!.text, "\u001b[2mChatGPT Pro Lite wk 49%  DeepSeek $5.27\u001b[0m");
  assert.deepEqual(colors, ["dim"]);
});

test("hides ChatGPT for a free account and keeps DeepSeek", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  stubFetch([{ body: { plan_type: "free" } }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.text, "\u001b[2mDeepSeek $5.27\u001b[0m");
});

test("keeps DeepSeek when the ChatGPT login is rejected", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  stubFetch([{ status: 401 }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.text, "\u001b[2mDeepSeek $5.27\u001b[0m");
});

test("skips decoding HTTP error bodies", async () => {
  writeAuth(codexCredentials());
  let decoded = false;
  globalThis.fetch = (async () => ({
    status: 401,
    json: () => { decoded = true; return {}; },
  })) as unknown as typeof fetch;
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses.length, 0);
  assert.equal(decoded, false);
});

test("never writes a status when no provider is available", async () => {
  writeAuth({});
  delete process.env.PI_DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  stubFetch([{ body: {} }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses.length, 0);
});

test("replaces stale values without removing the footer row", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();
  stubFetch([{ status: 401 }, { status: 401 }]);
  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses.length, 2);
  assert.equal(statuses[1]!.text, "\u001b[2mSubscription data unavailable\u001b[0m");
  assert.equal(statuses.filter((status) => status.text === undefined).length, 0);

  stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();
  assert.equal(statuses[2]!.text, statuses[0]!.text);
});

test("removes a rejected provider while retaining a valid one", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();
  stubFetch([{ status: 401 }, { body: deepseekBody }]);
  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses[1]!.text, "\u001b[2mDeepSeek $5.27\u001b[0m");
});

test("drops values after credentials are removed", async () => {
  writeAuth(codexCredentials());
  stubFetch([{ body: codexBody }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();
  writeAuth({});
  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses[1]!.text, "\u001b[2mSubscription data unavailable\u001b[0m");
});

test("ignores a malformed auth file without breaking the refresh", async () => {
  writeAuth({});
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), "null");
  const calls = stubFetch([]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.deepEqual(calls, []);
  assert.equal(statuses.length, 0);
});

test("does not create a footer row when the first lookup fails", async () => {
  writeAuth(codexCredentials());
  stubFetch([{ status: 401 }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();

  assert.equal(statuses.length, 0);
});

test("does not touch the network outside the TUI", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx, statuses } = fakeCtx("print");
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
  await flush();

  assert.deepEqual(calls, []);
  assert.equal(statuses.length, 0);
});

test("throttles event-driven refreshes to one round every two minutes", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();
  await pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
  await pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
  await flush();

  assert.equal(calls.length, 2);
});

test("schedules a skipped activity refresh at the two-minute mark, only once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(1_000_000_000_000) });
  try {
    writeAuth({ ...codexCredentials(), ...deepseekCredential() });
    const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
    const pi = fakePi();
    const { ctx } = fakeCtx();
    register(pi as never);

    pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
    pi.handlers.get("model_select")!({ type: "model_select" }, ctx);
    t.mock.timers.tick(90_000 - 1);
    assert.equal(calls.length, 2);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 4);
    pi.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  } finally {
    t.mock.timers.reset();
  }
});

test("polls after fifteen idle minutes counted from the last lookup", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(1_000_000_000_000) });
  try {
    writeAuth({ ...codexCredentials(), ...deepseekCredential() });
    const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
    const pi = fakePi();
    const { ctx } = fakeCtx();
    register(pi as never);

    pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2 * 60_000);
    pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 4);
    t.mock.timers.tick(15 * 60_000 - 1);
    assert.equal(calls.length, 4);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 6);
    t.mock.timers.tick(15 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 8);
    pi.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  } finally {
    t.mock.timers.reset();
  }
});

test("cancels a scheduled activity refresh on shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(1_000_000_000_000) });
  try {
    writeAuth({ ...codexCredentials(), ...deepseekCredential() });
    const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
    const pi = fakePi();
    const { ctx } = fakeCtx();
    register(pi as never);

    pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
    pi.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    t.mock.timers.tick(16 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
  } finally {
    t.mock.timers.reset();
  }
});

test("stops refreshing after session shutdown", async () => {
  writeAuth({ ...codexCredentials(), ...deepseekCredential() });
  const calls = stubFetch([{ body: codexBody }, { body: deepseekBody }]);
  const pi = fakePi();
  const { ctx } = fakeCtx();
  register(pi as never);

  await pi.handlers.get("session_start")!({ type: "session_start" }, ctx);
  await flush();
  await pi.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  await pi.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
  await flush();

  assert.equal(calls.length, 2);
});
