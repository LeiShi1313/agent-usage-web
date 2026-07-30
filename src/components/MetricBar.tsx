import { motion } from 'framer-motion';
import { clampPercent, formatPercent, formatReset, remainingPercent, usageColor } from '../lib/format';
import type { RateWindow } from '../types';

export function MetricBar({ label, window }: { label: string; window: RateWindow }) {
  const used = clampPercent(window.usedPercent);
  const remain = remainingPercent(window);
  const tint = usageColor(used);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="metric-title">{label}</h3>
        <span className="soft-label">{formatReset(window.resetsAt)}</span>
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
    </section>
  );
}
