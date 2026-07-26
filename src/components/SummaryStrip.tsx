import { formatMoney } from '../lib/format';
import type { DashboardPayload } from '../types';

export function SummaryStrip({ data }: { data: DashboardPayload }) {
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
