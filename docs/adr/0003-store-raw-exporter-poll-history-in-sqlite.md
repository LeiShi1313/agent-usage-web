# Store Raw Exporter Poll History In SQLite

The web aggregator stores every exporter poll attempt in SQLite, including successful raw snapshots and failure records. We chose this over no history or a modeled time-series schema because it gives simple audit/history with minimal design overhead. The trade-off is that the database can grow indefinitely in v1; future or offline historical analysis can query raw JSON, but v1 exposes no history API or UI.
