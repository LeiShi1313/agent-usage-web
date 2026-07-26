import { clampPercent, usageColor } from '../lib/format';
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
