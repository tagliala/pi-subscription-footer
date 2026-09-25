import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDeepseekBalance } from "../extensions/subscription-status.ts";

test("parseDeepseekBalance renders a USD balance with a dollar sign", () => {
  const body = {
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "5.27", topped_up_balance: "5.27" }],
  };
  assert.equal(parseDeepseekBalance(body), "DeepSeek $5.27");
});

test("parseDeepseekBalance keeps the yuan symbol for CNY accounts", () => {
  const body = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12" }] };
  assert.equal(parseDeepseekBalance(body), "DeepSeek ¥12.00");
});

test("parseDeepseekBalance shows every valid currency balance", () => {
  const body = {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "0.00" },
      { currency: "USD", total_balance: "25.00" },
      { currency: "EUR", total_balance: "not a number" },
    ],
  };
  assert.equal(parseDeepseekBalance(body), "DeepSeek ¥0.00 · $25.00");
});

test("parseDeepseekBalance names an unknown currency instead of guessing", () => {
  const body = { is_available: true, balance_infos: [{ currency: "EUR", total_balance: "3.5" }] };
  assert.equal(parseDeepseekBalance(body), "DeepSeek EUR 3.50");
});

test("parseDeepseekBalance omits the symbol when the currency is missing", () => {
  const body = { is_available: true, balance_infos: [{ total_balance: "1.5" }] };
  assert.equal(parseDeepseekBalance(body), "DeepSeek 1.50");
});

test("parseDeepseekBalance flags an unavailable account", () => {
  const body = { is_available: false, balance_infos: [{ currency: "USD", total_balance: "0" }] };
  assert.equal(parseDeepseekBalance(body), "DeepSeek ⚠ unavailable");
  assert.equal(parseDeepseekBalance({ is_available: false, balance_infos: [] }), "DeepSeek ⚠ unavailable");
});

test("parseDeepseekBalance returns null without a usable balance", () => {
  assert.equal(parseDeepseekBalance({ balance_infos: [] }), null);
  assert.equal(parseDeepseekBalance({}), null);
  assert.equal(parseDeepseekBalance(null), null);
  assert.equal(parseDeepseekBalance({ balance_infos: [{ currency: "USD", total_balance: "abc" }] }), null);
  assert.equal(parseDeepseekBalance({ balance_infos: [{ currency: "USD", total_balance: "" }] }), null);
});
