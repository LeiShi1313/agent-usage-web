import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Command,
  Cpu,
  Gauge,
  KeyRound,
  RefreshCcw,
  Server,
  Sparkles,
  Terminal
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchDashboard, refreshDashboard } from './api';
import type { CostPayload, DashboardPayload, ProviderPayload, RateWindow, UpstreamIssue } from './types';

const providerMeta: Record<string, { label: string; tint: string; icon: typeof Command }> = {
  codex: { label: 'Codex', tint: '#49a3b0', icon: Command },
  claude: { label: 'Claude', tint: '#d18652', icon: Sparkles },
  cursor: { label: 'Cursor', tint: '#7c8393', icon: Cpu },
  openai: { label: 'OpenAI', tint: '#2f8f73', icon: Gauge },
  antigravity: { label: 'Antigravity', tint: '#7c74c9', icon: Sparkles }
};

function providerLabel(provider: string) {
  return providerMeta[provider]?.label ?? provider.replace(/(^|-)([a-z])/g, (_, dash, letter) => `${dash ? ' ' : ''}${letter.toUpperCase()}`);
}

function clampPercent(value: number | undefined | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function remainingPercent(window?: RateWindow | null) {
  return 100 - clampPercent(window?.usedPercent);
}

function usageColor(usedPercent: number | undefined | null) {
  const used = clampPercent(usedPercent);
  if (used >= 85) return '#d94b3d';
  if (used >= 60) return '#d9a441';
  return '#37a66a';
}

function formatPercent(value: number | undefined | null) {
  return `${Math.round(clampPercent(value))}%`;
}

function formatReset(value?: string | null) {
  if (!value) return 'Reset pending';
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return 'Reset pending';
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) return 'Resets soon';
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `Resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${Math.max(1, minutes)}m`;
}

function formatTime(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatTokens(tokens?: number | null) {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

function formatMoney(value?: number | null) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value ?? 0);
}

function costFor(provider: string, costs: CostPayload[], accountKey?: string | null) {
  return (
    costs.find((item) => item.provider === provider && item.accountKey === accountKey && !item.error) ??
    costs.find((item) => item.provider === provider && !item.error)
  );
}

function providerKey(provider: ProviderPayload) {
  return `${provider.provider}:${provider.accountKey ?? provider.account ?? 'default'}`;
}

function providerHealth(provider: ProviderPayload) {
  if (provider.error) return 'Needs attention';
  if (provider.stale) return 'Stale data';
  if (provider.status?.indicator && provider.status.indicator !== 'none') return provider.status.description ?? 'Provider incident';
  if (provider.usage?.primary || provider.usage?.secondary) return 'Updated just now';
  if (provider.credits) return 'Credits only';
  return 'Waiting for data';
}

function MetricBar({
  label,
  window,
  paceLabel
}: {
  label: string;
  window?: RateWindow | null;
  paceLabel?: string;
}) {
  const used = clampPercent(window?.usedPercent);
  const remain = remainingPercent(window);
  const tint = usageColor(used);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="metric-title">{label}</h3>
        <span className="soft-label">{formatReset(window?.resetsAt)}</span>
      </div>
      <div className="progress-track" aria-label={`${label} ${formatPercent(remain)} left`}>
        <motion.div
          className="progress-fill"
          style={{ backgroundColor: tint }}
          initial={{ width: 0 }}
          animate={{ width: `${remain}%` }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      <div className="flex items-center justify-between text-[15px] font-medium text-ink">
        <span>{formatPercent(used)} used</span>
        <span className="text-ink/55">{formatPercent(remain)} left</span>
      </div>
      {paceLabel ? <p className="soft-label">{paceLabel}</p> : null}
    </section>
  );
}

function ProviderTab({
  provider,
  active,
  onClick
}: {
  provider: ProviderPayload;
  active: boolean;
  onClick: () => void;
}) {
  const meta = providerMeta[provider.provider] ?? { label: providerLabel(provider.provider), tint: '#6f7891', icon: Server };
  const Icon = meta.icon;
  const tabUsed = clampPercent(provider.usage?.primary?.usedPercent ?? provider.usage?.secondary?.usedPercent ?? 0);
  const remain = 100 - tabUsed;

  return (
    <button className={`provider-tab ${active ? 'provider-tab-active' : ''}`} onClick={onClick} type="button">
      <Icon size={20} strokeWidth={2.1} />
      <span>{meta.label}</span>
      <span className="tab-meter">
        <span style={{ width: `${remain}%`, backgroundColor: usageColor(tabUsed) }} />
      </span>
    </button>
  );
}

function ProviderDetail({ provider, cost }: { provider: ProviderPayload; cost?: CostPayload }) {
  const meta = providerMeta[provider.provider] ?? { label: providerLabel(provider.provider), tint: '#6f7891', icon: Server };
  const account = provider.account ?? provider.usage?.identity?.accountEmail ?? null;
  const plan = provider.usage?.identity?.loginMethod ?? provider.source;
  const extraWindows = provider.usage?.extraRateWindows ?? [];
  const lastUpdated = provider.usage?.updatedAt ?? provider.credits?.updatedAt;

  return (
    <motion.div
      key={providerKey(provider)}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.99 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="panel"
    >
      <div className="flex items-start justify-between gap-4 border-b border-ink/10 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <span className="provider-mark" style={{ backgroundColor: meta.tint }}>
              <Terminal size={18} />
            </span>
            <h2 className="text-2xl font-semibold tracking-normal text-ink">{meta.label}</h2>
          </div>
          <p className="mt-2 text-[15px] text-ink/60">{providerHealth(provider)}</p>
        </div>
        {account || plan ? (
          <div className="min-w-0 text-right">
            {account ? <p className="truncate text-[15px] font-medium text-ink">{account}</p> : null}
            {plan ? <p className={account ? 'mt-1 text-sm uppercase tracking-[0.12em] text-ink/45' : 'text-sm uppercase tracking-[0.12em] text-ink/45'}>{plan}</p> : null}
          </div>
        ) : null}
      </div>

      {provider.error ? (
        <div className="notice">
          <AlertTriangle size={18} />
          <span>{provider.error.message ?? provider.error.description ?? 'Provider returned an error.'}</span>
        </div>
      ) : null}

      <div className="mt-7 space-y-7">
        <MetricBar label="Session" window={provider.usage?.primary} />
        <MetricBar label="Weekly" window={provider.usage?.secondary} paceLabel="Pace: measured against the current reset window" />
        {extraWindows.map((entry) => (
          <MetricBar key={entry.id} label={entry.title} window={entry.window} />
        ))}
      </div>

      <div className="mt-8 grid gap-4 border-t border-ink/10 pt-6 sm:grid-cols-2">
        <div className="quiet-tile">
          <div className="tile-label">
            <CircleDollarSign size={16} />
            Credits
          </div>
          <p className="tile-value">{provider.credits ? provider.credits.remaining.toFixed(1) : 'Unavailable'}</p>
          <p className="soft-label">Remaining balance</p>
        </div>
        <div className="quiet-tile">
          <div className="tile-label">
            <BarChart3 size={16} />
            Cost
          </div>
          <p className="tile-value">{formatMoney(cost?.last30DaysCostUSD)}</p>
          <p className="soft-label">{formatTokens(cost?.last30DaysTokens)} tokens in 30 days</p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-ink/52">
        <span className="inline-flex items-center gap-2">
          <Clock3 size={15} />
          Last update {formatTime(lastUpdated)}
        </span>
        <span className="inline-flex items-center gap-2">
          <KeyRound size={15} />
          Source {provider.source}
        </span>
      </div>
    </motion.div>
  );
}

function SummaryStrip({ data }: { data: DashboardPayload }) {
  const successful = data.usage.filter((item) => !item.error).length;
  const withLimits = data.usage.filter((item) => item.usage?.primary || item.usage?.secondary).length;
  const totalCost = data.cost.reduce((sum, item) => sum + (item.last30DaysCostUSD ?? 0), 0);
  const sourceCount = data.freshness?.sourceCount ?? 0;
  const successfulSources = data.freshness?.successfulSourceCount ?? 0;

  return (
    <div className="summary-grid">
      <div>
        <p className="summary-label">Sources</p>
        <p className="summary-value">{successfulSources}/{sourceCount}</p>
      </div>
      <div>
        <p className="summary-label">Accounts</p>
        <p className="summary-value">{successful}/{data.usage.length}</p>
      </div>
      <div>
        <p className="summary-label">Windows</p>
        <p className="summary-value">{withLimits}</p>
      </div>
      <div>
        <p className="summary-label">Cost 30d</p>
        <p className="summary-value">{formatMoney(totalCost)}</p>
      </div>
    </div>
  );
}

function ExporterIssues({ issues }: { issues: UpstreamIssue[] }) {
  return (
    <aside aria-label="Exporter issues">
      <details className="issue-disclosure">
        <summary className="issue-summary">
          <span className="issue-summary-label">
            <AlertTriangle aria-hidden="true" size={18} />
            Exporters reported {issues.length} upstream issue{issues.length === 1 ? '' : 's'}.
          </span>
          <ChevronDown className="issue-chevron" aria-hidden="true" size={18} />
        </summary>

        <div className="issue-body">
          <p className="issue-intro">Collector errors reported by each source. Sensitive values are removed by the exporter.</p>
          <ul className="issue-list">
            {issues.map((issue, index) => (
              <li className="issue-item" key={`${issue.source}:${issue.code}:${issue.provider ?? 'exporter'}:${index}`}>
                <div className="issue-item-header">
                  <strong>{issue.source}</strong>
                  <span className="issue-context">
                    {issue.provider ? providerLabel(issue.provider) : 'Exporter'} · {issue.operation}
                  </span>
                </div>
                <p className="issue-message">{issue.message}</p>
                {issue.details && issue.details !== issue.message ? (
                  <p className="issue-details">Collector detail: {issue.details}</p>
                ) : null}
                <div className="issue-item-footer">
                  <code>{issue.code}</code>
                  {issue.occurredAt ? <time dateTime={issue.occurredAt}>{formatTime(issue.occurredAt)}</time> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </aside>
  );
}

export default function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    const controller = new AbortController();
    setRefreshing(true);
    try {
      const next = force ? await refreshDashboard(controller.signal) : await fetchDashboard(controller.signal);
      setData(next);
      setError(null);
      setSelectedKey((current) => {
        if (current && next.usage.some((item) => providerKey(item) === current)) {
          return current;
        }
        const preferred = next.usage.find((item) => item.provider === 'codex' && !item.error) ?? next.usage[0];
        return preferred ? providerKey(preferred) : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setRefreshing(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const selected = useMemo(() => {
    if (!data?.usage.length) return null;
    return data.usage.find((item) => providerKey(item) === selectedKey) ?? data.usage[0];
  }, [data, selectedKey]);

  return (
    <main className="min-h-screen overflow-hidden bg-page px-4 py-6 text-ink sm:px-6 lg:px-8">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <section className="relative mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local AI agent limits</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal sm:text-4xl">Agent Usage</h1>
            <p className="mt-2 text-sm text-ink/55">
              Last update {formatTime(data?.freshness?.lastUpdatedAt)}
              {data?.freshness?.warning ? <span className="ml-2 text-amber-700">{data.freshness.warning}</span> : null}
            </p>
          </div>
          <button className="refresh-button" type="button" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCcw className={refreshing ? 'animate-spin' : ''} size={18} />
            Refresh
          </button>
        </header>

        {error ? (
          <div className="notice">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        ) : null}

        {data ? <SummaryStrip data={data} /> : null}

        <div className="app-shell">
          <nav className="provider-strip" aria-label="Providers">
            {data?.usage.map((provider) => {
              const key = providerKey(provider);
              return (
                <ProviderTab
                  key={key}
                  provider={provider}
                  active={key === selectedKey}
                  onClick={() => setSelectedKey(key)}
                />
              );
            })}
          </nav>

          <AnimatePresence mode="wait">
            {selected ? (
              <ProviderDetail
                key={providerKey(selected)}
                provider={selected}
                cost={costFor(selected.provider, data?.cost ?? [], selected.accountKey)}
              />
            ) : (
              <motion.div className="panel min-h-[480px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <Activity className="text-ink/40" />
                <p className="mt-4 text-lg font-medium">{data ? 'No exporter data yet' : 'Loading usage data'}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {data?.upstreamIssues.length ? <ExporterIssues issues={data.upstreamIssues} /> : null}
      </section>
    </main>
  );
}
