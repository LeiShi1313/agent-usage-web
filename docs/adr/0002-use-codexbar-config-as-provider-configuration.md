# Use CodexBar Config As Provider Configuration

Exporter provider selection and provider-specific settings use CodexBar's native config as the source of truth. We deliberately avoid an exporter-specific provider DSL because CodexBar already owns source modes, cookie settings, token accounts, API keys, regions, and provider-specific fields. The trade-off is that exporter deployment must understand and mount a CodexBar config file, but this keeps the exporter from translating or duplicating the underlying collector's configuration model.
