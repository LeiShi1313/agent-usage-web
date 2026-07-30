import { AlertTriangle, ChevronDown } from 'lucide-react';
import { formatTime } from '../lib/format';
import { providerLabel } from '../lib/providers';
import type { UpstreamIssue } from '../types';

export function ExporterIssues({ issues }: { issues: UpstreamIssue[] }) {
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
