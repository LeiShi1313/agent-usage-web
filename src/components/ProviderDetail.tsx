import { motion } from 'framer-motion';
import { AlertTriangle, BarChart3, CircleDollarSign, Clock3, KeyRound } from 'lucide-react';
import { formatMoney, formatTime, formatTokens } from '../lib/format';
import { providerHealth, providerKey, resolveProviderPresentation, windowLabel } from '../lib/providers';
import type { CostPayload, ProviderPayload, RateWindow } from '../types';
import { MetricBar } from './MetricBar';

type WindowEntry = {
  key: string;
  label: string;
  window: RateWindow;
};

/** Only windows that actually exist in the payload — never fabricate a bar. */
function collectWindows(provider: ProviderPayload): WindowEntry[] {
  const usage = provider.usage;
  const entries: WindowEntry[] = [];
  if (usage?.primary) {
    entries.push({ key: 'primary', label: windowLabel(usage.primary, 'Primary limit'), window: usage.primary });
  }
  if (usage?.secondary) {
    entries.push({ key: 'secondary', label: windowLabel(usage.secondary, 'Secondary limit'), window: usage.secondary });
  }
  if (usage?.tertiary) {
    entries.push({ key: 'tertiary', label: windowLabel(usage.tertiary, 'Tertiary limit'), window: usage.tertiary });
  }
  for (const extra of usage?.extraRateWindows ?? []) {
    if (extra.window) {
      entries.push({ key: `extra:${extra.id}`, label: windowLabel(extra.window, extra.title), window: extra.window });
    }
  }
  return entries;
}

export function ProviderDetail({ provider, cost }: { provider: ProviderPayload; cost?: CostPayload }) {
  const meta = resolveProviderPresentation(provider.provider);
  const Icon = meta.icon;
  const account = provider.account ?? provider.usage?.identity?.accountEmail ?? null;
  const plan = provider.usage?.identity?.loginMethod ?? null;
  const windows = collectWindows(provider);
  const lastUpdated = provider.usage?.updatedAt ?? provider.credits?.updatedAt;
  const hasIncident = Boolean(
    provider.error ||
    provider.stale ||
    (provider.status?.indicator && provider.status.indicator !== 'none')
  );
  const isWaiting = !hasIncident && !provider.usage && !provider.credits;
  const statusDotClass = hasIncident ? 'provider-status-dot-warning' : isWaiting ? 'provider-status-dot-muted' : '';

  return (
    <motion.div
      key={providerKey(provider)}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.99 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="panel provider-panel"
    >
      <div className="provider-header">
        <span className="provider-mark" style={{ backgroundColor: meta.tint }}>
          <Icon aria-hidden="true" size={24} strokeWidth={2} />
        </span>
        <div className="provider-heading-copy">
          <div className="provider-title-row">
            <h2>{meta.label}</h2>
            {plan ? <span className="provider-plan">{plan}</span> : null}
          </div>
          <div className="provider-meta">
            <span
              aria-hidden="true"
              className={`provider-status-dot ${statusDotClass}`}
            />
            {account ? <span className="provider-account">{account}</span> : null}
            {account ? <span aria-hidden="true">·</span> : null}
            <span>{providerHealth(provider)}</span>
          </div>
        </div>
      </div>

      {provider.error ? (
        <div className="notice provider-notice">
          <AlertTriangle size={18} />
          <span>{provider.error.message ?? provider.error.description ?? 'Provider returned an error.'}</span>
        </div>
      ) : null}

      <div className="metric-list">
        {windows.length ? (
          windows.map((entry) => <MetricBar key={entry.key} label={entry.label} window={entry.window} />)
        ) : (
          <p className="soft-label">No rate limit data reported yet.</p>
        )}
      </div>

      <div className="provider-financials">
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
          <p className="tile-value">{cost ? formatMoney(cost.last30DaysCostUSD) : 'No cost data'}</p>
          <p className="soft-label">{cost ? `${formatTokens(cost.last30DaysTokens)} tokens in 30 days` : 'Last 30 days'}</p>
        </div>
      </div>

      <div className="provider-footer">
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
