# Use CodexBar Config As Provider Configuration

The exporter collects only Codex and Antigravity, while provider-specific settings continue to use CodexBar's native config as the source of truth. Explicit provider-scoped commands prevent unrelated or deprecated probes such as Gemini from affecting a snapshot. The trade-off is that adding another provider now requires an intentional exporter change rather than only a CodexBar toggle.
