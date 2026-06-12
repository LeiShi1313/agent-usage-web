# Split Collection Exporters From Web Aggregation

We split local provider collection into token-protected exporters and keep the web dashboard as an aggregator only. This lets each machine expose usage and cost over HTTP while the public dashboard avoids mounting agent credentials or local agent caches. The trade-off is a slightly more complex deployment with two roles instead of one combined container.
