---
name: token-monitor
description: Display real-time token consumption, prompt cache hit rate, TTFT, and TPS statistics for Antigravity conversations, or open the Token & TPS Monitor sidecar panel.
---

# Token & TPS Monitor Skill

Use this skill when the user asks to view real-time or historical Antigravity Token consumption, Prompt Cache hit rate, TTFT, or TPS (Tokens Per Second), or asks to open the Token & TPS Monitor side pane.

## 1. Open the Sidecar UI Pane

Check whether the `token-monitor/token_dashboard` sidecar is running. If it is enabled and running, include the following clickable pill on its own line in your response so the user can open/toggle the side pane in one click:

```markdown
[Token & TPS Monitor](sidecar://token-monitor/token_dashboard/)
```

If the plugin is disabled or not yet enabled by the user, direct them to enable it via:

```markdown
[Token & TPS Monitor](customization://token-monitor)
```

## 2. Inspect Stats via CLI

To inspect parsed token and TPS metrics directly in the terminal or summarize them in chat, run:

```bash
node ~/.gemini/config/plugins/token-monitor/sidecars/token_dashboard/main.mjs --self-test
```

You can also start a standalone local HTTP dashboard on a custom port (e.g. `4399`) if needed:

```bash
node ~/.gemini/config/plugins/token-monitor/sidecars/token_dashboard/main.mjs --standalone 4399
```
