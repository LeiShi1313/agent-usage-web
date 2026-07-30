import { resolveProviderPresentation } from '../lib/providers';
import type { ProviderPayload } from '../types';

export function ProviderTab({
  provider,
  active,
  onClick
}: {
  provider: ProviderPayload;
  active: boolean;
  onClick: () => void;
}) {
  const meta = resolveProviderPresentation(provider.provider);
  const Icon = meta.icon;
  const hasIncident = Boolean(
    provider.error ||
    provider.stale ||
    (provider.status?.indicator && provider.status.indicator !== 'none')
  );
  const isWaiting = !hasIncident && !provider.usage && !provider.credits;
  const status = provider.error ? 'Issue' : provider.stale ? 'Stale' : hasIncident ? 'Incident' : isWaiting ? 'Waiting' : 'Active';
  const statusClass = hasIncident ? 'provider-tab-status-warning' : isWaiting ? 'provider-tab-status-waiting' : '';
  const plan = provider.usage?.identity?.loginMethod ?? null;

  return (
    <button
      aria-pressed={active}
      className={`provider-tab ${active ? 'provider-tab-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className="provider-tab-mark" style={{ backgroundColor: meta.tint }}>
        <Icon aria-hidden="true" size={20} strokeWidth={2} />
      </span>
      <span className="provider-tab-copy">
        <span className="provider-tab-name">{meta.label}</span>
        <span className={`provider-tab-status ${statusClass}`}>
          <span aria-hidden="true" className="provider-status-dot" />
          {status}
          {plan ? <span className="provider-tab-plan">{plan}</span> : null}
        </span>
      </span>
    </button>
  );
}
