# Agent Usage

This context describes usage and cost visibility across AI agent tools and the provider accounts they use.

## Language

**Provider**:
An upstream service or product whose usage or cost can be observed, such as Codex, Claude, or Antigravity.
_Avoid_: Vendor, integration, agent

**Provider Account**:
An account at a Provider whose usage or cost is being observed.
_Avoid_: Account, login, user

**Account Key**:
A stable provider-local identifier for a Provider Account. A Provider plus an Account Key uniquely identifies the aggregate target for usage and cost.
_Avoid_: Display name as identity, display email as identity unless the Provider exposes email as the stable operational key

**Usage**:
Provider-reported account state such as quota windows, rate limits, credits, or remaining allowance.
_Avoid_: Spend, cost

**Cost**:
Local log-derived token and price estimates for agent activity on a machine.
_Avoid_: Credits, provider billing, quota

**Cost Source**:
A configured Scrape Target that contributes local Cost for a Provider Account. Cost is additive across Cost Sources, but Cost Sources are not exposed in v1.
_Avoid_: Usage source, machine ID, exporter ID

**Exported Report**:
A usage or cost report returned by an Exporter and trusted by the Web Aggregator as a legitimate source for aggregation.
_Avoid_: Untrusted telemetry, raw scrape

**Scrape Target**:
An Exporter endpoint configured in the Web Aggregator by URL and token. It is the source identity for per-machine or per-instance Cost replacement.
_Avoid_: Exporter ID, machine ID
