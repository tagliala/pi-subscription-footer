# pi-subscription-footer

ChatGPT subscription quota and DeepSeek balance in [pi](https://pi.dev)'s own footer.

The line is added with `ctx.ui.setStatus()`, so it appears **below** pi's built-in
token/cost line rather than replacing the footer. It uses the footer's own `dim`
colour, so it does not compete with the rest of the interface.

```text
~/dev/app (main)
↑72k ↓53k R3.8M CH99.9% $0.108 12.1%/1.0M (auto)      (deepseek) deepseek-flash • high
ChatGPT Pro Lite wk 52% ↺2d +2r DeepSeek $5.27
```

## Install

```sh
pi install npm:pi-subscription-footer
```

Then `/reload`.

## What it shows

| Provider | Source | Shown as |
|---|---|---|
| ChatGPT (Codex) | `GET https://chatgpt.com/backend-api/wham/usage` | `ChatGPT <plan> 5h 12% ↺3h · wk 52% ↺2d +2r` |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | `DeepSeek $5.27` |

- Only the quota windows the plan actually returns are shown: a rolling window
  (`5h`) and/or the weekly window (`wk`). Plans with only a weekly window show a
  single entry.
- `+2r` means two banked rate-limit resets are available.
- The DeepSeek symbol follows the currency reported by the API, so USD accounts
  show `$`, not `¥`.
- **Nothing is shown when the account has no paid ChatGPT plan** (`plan_type`
  is `free`) or when no credential is available. An absent provider is not an
  error.

## Refresh

| Trigger | When |
|---|---|
| start of a session | immediately on start and on `/reload` |
| start of a run | at `agent_start`, at most once a minute |
| model switch | at `model_select`, at most once a minute |
| timer | every 5 minutes |

The footer line is never removed once it has a value, because a footer that
changes height shifts the transcript. Lookups are never made outside the
interactive TUI: `print`, `rpc` and `json` modes do not hit the network.

## Credentials

Nothing is configured by hand; the extension reuses what pi already has.

- **ChatGPT** — the `openai-codex` OAuth entry in `~/.pi/agent/auth.json`,
  written by `/login openai-codex`. Nothing is sent anywhere except
  `chatgpt.com`, with the same bearer token pi uses.
- **DeepSeek** — `PI_DEEPSEEK_API_KEY`, then `DEEPSEEK_API_KEY`, then the
  `deepseek` entry in `~/.pi/agent/auth.json`. The key is only sent to
  `api.deepseek.com`.

The extension reads nothing else and writes nothing to disk.

## Notes

- The extra line makes the footer one row taller. In pi's default `regular` TUI
  mode the footer is not anchored to the bottom of the screen, so after a run
  the reprinted footer can leave blank rows below it. This happens with or
  without this extension; `tuiMode: "fullscreen"` avoids it entirely.
- A rejected or expired credential hides that provider instead of showing an
  error. Re-run `/login openai-codex` to restore the ChatGPT entry.

## License

MIT
