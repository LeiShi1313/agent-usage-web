import { CircleDollarSign, Database, Table2, UserRound } from 'lucide-react';
import { formatMoney } from '../lib/format';
import type { DashboardPayload } from '../types';

export function SummaryStrip({ data }: { data: DashboardPayload }) {
  const successful = data.usage.filter((item) => !item.error).length;
  const withLimits = data.usage.filter((item) => item.usage?.primary || item.usage?.secondary).length;
  const totalCost = data.cost.reduce((sum, item) => sum + (item.last30DaysCostUSD ?? 0), 0);
  const sourceCount = data.freshness?.sourceCount ?? 0;
  const successfulSources = data.freshness?.successfulSourceCount ?? 0;

  const items = [
    { label: 'Sources', value: `${successfulSources}/${sourceCount}`, icon: Database },
    { label: 'Accounts', value: `${successful}/${data.usage.length}`, icon: UserRound },
    { label: 'Windows', value: String(withLimits), icon: Table2 },
    { label: 'Cost 30d', value: formatMoney(totalCost), icon: CircleDollarSign }
  ];

  return (
    <div className="summary-grid">
      {items.map(({ label, value, icon: Icon }) => (
        <div className="summary-item" key={label}>
          <Icon aria-hidden="true" className="summary-icon" size={24} strokeWidth={1.9} />
          <div>
            <p className="summary-label">{label}</p>
            <p className="summary-value">{value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
