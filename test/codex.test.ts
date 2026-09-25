import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codexWindowPart,
  formatResetsIn,
  parseChatgptUsage,
  planLabel,
  splitCodexWindows,
} from "../extensions/subscription-status.ts";

const WEEK = 7 * 24 * 60 * 60;

test("planLabel prettifies known plans and passes through unknown ones", () => {
  assert.equal(planLabel("prolite"), "Pro Lite");
  assert.equal(planLabel("plus"), "Plus");
  assert.equal(planLabel("something-new"), "something-new");
});

test("formatResetsIn formats minutes, hours and days", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatResetsIn({ reset_after_seconds: 2700 }, now), "↺45m");
  assert.equal(formatResetsIn({ reset_after_seconds: 3 * 3600 }, now), "↺3h");
  assert.equal(formatResetsIn({ reset_after_seconds: 2 * 24 * 3600 }, now), "↺2d");
});

test("formatResetsIn uses reset_at when reset_after_seconds is absent", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatResetsIn({ reset_at: now / 1000 + 90 * 60 }, now), "↺2h");
});

test("formatResetsIn returns nothing when the reset already passed", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatResetsIn({ reset_at: now / 1000 - 60 }, now), "");
  assert.equal(formatResetsIn({}, now), "");
});

test("splitCodexWindows classifies a weekly window", () => {
  const { rolling, weekly } = splitCodexWindows({
    primary_window: { used_percent: 51, limit_window_seconds: WEEK },
    secondary_window: null,
  });
  assert.equal(rolling, null);
  assert.equal(weekly?.used_percent, 51);
});

test("splitCodexWindows classifies a rolling plus a weekly window", () => {
  const { rolling, weekly } = splitCodexWindows({
    primary_window: { used_percent: 10, limit_window_seconds: 5 * 3600 },
    secondary_window: { used_percent: 60, limit_window_seconds: WEEK },
  });
  assert.equal(rolling?.used_percent, 10);
  assert.equal(weekly?.used_percent, 60);
});

test("splitCodexWindows treats a lone window without metadata as weekly", () => {
  const { rolling, weekly } = splitCodexWindows({ primary_window: { used_percent: 30 } });
  assert.equal(rolling, null);
  assert.equal(weekly?.used_percent, 30);
});

test("codexWindowPart clamps percentages and appends the reset", () => {
  const now = 1_000_000_000_000;
  assert.equal(codexWindowPart("5h", { used_percent: 12.4, reset_after_seconds: 3 * 3600 }, now), "5h 12% ↺3h");
  assert.equal(codexWindowPart("wk", { used_percent: 150 }, now), "wk 100%");
  assert.equal(codexWindowPart("wk", { used_percent: -5 }, now), "wk 0%");
  assert.equal(codexWindowPart("wk", null, now), null);
  assert.equal(codexWindowPart("wk", {} as never, now), null);
});

test("parseChatgptUsage hides free accounts and payloads without a plan", () => {
  assert.equal(parseChatgptUsage({ plan_type: "free", rate_limit: { primary_window: { used_percent: 10 } } }), null);
  assert.equal(parseChatgptUsage({ rate_limit: { primary_window: { used_percent: 10 } } }), null);
  assert.equal(parseChatgptUsage(null), null);
});

test("parseChatgptUsage renders the weekly-only plan with banked resets", () => {
  const now = 1_000_000_000_000;
  const body = {
    plan_type: "prolite",
    rate_limit: {
      primary_window: { used_percent: 51, limit_window_seconds: WEEK, reset_after_seconds: 2 * 24 * 3600 },
      secondary_window: null,
    },
    rate_limit_reset_credits: { available_count: 2 },
  };
  assert.equal(parseChatgptUsage(body, now), "ChatGPT Pro Lite wk 51% ↺2d +2r");
});

test("parseChatgptUsage renders both windows in order", () => {
  const now = 1_000_000_000_000;
  const body = {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 5 * 3600, reset_after_seconds: 3 * 3600 },
      secondary_window: { used_percent: 52, limit_window_seconds: WEEK, reset_after_seconds: 2 * 24 * 3600 },
    },
  };
  assert.equal(parseChatgptUsage(body, now), "ChatGPT Plus 5h 12% ↺3h · wk 52% ↺2d");
});

test("parseChatgptUsage omits the grant suffix without banked resets", () => {
  const body = {
    plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: WEEK } },
    rate_limit_reset_credits: { available_count: 0 },
  };
  assert.equal(parseChatgptUsage(body), "ChatGPT Pro wk 5%");
});

test("parseChatgptUsage returns null when no window carries a percentage", () => {
  assert.equal(parseChatgptUsage({ plan_type: "plus", rate_limit: { primary_window: null } }), null);
});
