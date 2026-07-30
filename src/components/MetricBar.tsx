import { motion } from 'framer-motion';
import { clampPercent, formatPercent, formatReset, remainingPercent, usageColor } from '../lib/format';
import type { RateWindow } from '../types';

export function MetricBar({ label, window }: { label: string; window: RateWindow }) {
  const used = clampPercent(window.usedPercent);
  const remain = remainingPercent(window);
  const tint = usageColor(used);

  return (
    <section className="metric-block">
      <div className="metric-heading">
        <h3 className="metric-title">{label}</h3>
        <span className="soft-label">{formatReset(window.resetsAt)}</span>
      </div>
      <div
        aria-label={`${label} ${formatPercent(remain)} left`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(remain)}
        className="progress-track"
        role="progressbar"
      >
        <motion.div
          className="progress-fill"
          style={{ backgroundColor: tint }}
          initial={{ width: 0 }}
          animate={{ width: `${remain}%` }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      <div className="metric-values">
        <span className="metric-used">{formatPercent(used)} used</span>
        <span className="metric-remaining">
          <strong>{formatPercent(remain)}</strong>
          <span>left</span>
        </span>
      </div>
    </section>
  );
}
