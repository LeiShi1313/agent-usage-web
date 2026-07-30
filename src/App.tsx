import { AnimatePresence, motion } from 'framer-motion';
import { Activity, AlertTriangle, RefreshCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ExporterIssues } from './components/ExporterIssues';
import { ProviderDetail } from './components/ProviderDetail';
import { ProviderTab } from './components/ProviderTab';
import { SummaryStrip } from './components/SummaryStrip';
import { useDashboard } from './hooks/useDashboard';
import { formatTime } from './lib/format';
import { costFor, providerKey } from './lib/providers';

export default function App() {
  const { data, error, manualRefreshing, refresh } = useDashboard();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setSelectedKey((current) => {
      if (current && data.usage.some((item) => providerKey(item) === current)) {
        return current;
      }
      // The server sorts usage rows by the configured provider order, so
      // prefer the first healthy row rather than a hardcoded provider.
      const preferred = data.usage.find((item) => !item.error) ?? data.usage[0];
      return preferred ? providerKey(preferred) : null;
    });
  }, [data]);

  const selected = useMemo(() => {
    if (!data?.usage.length) return null;
    return data.usage.find((item) => providerKey(item) === selectedKey) ?? data.usage[0];
  }, [data, selectedKey]);

  return (
    <main className="min-h-screen overflow-hidden bg-page px-4 py-5 text-ink sm:px-6 sm:py-6 lg:px-8">
      <section className="relative mx-auto flex w-full max-w-[82.5rem] flex-col gap-3">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local AI agent limits</p>
            <h1 className="mt-1 text-4xl font-semibold tracking-tight sm:text-[2.5rem]">Agent Usage</h1>
            <p className="mt-2 text-sm text-ink/55">
              Last update {formatTime(data?.freshness?.lastUpdatedAt)}
              {data?.freshness?.warning ? <span className="ml-2 text-amber-700">{data.freshness.warning}</span> : null}
            </p>
          </div>
          <button className="refresh-button" type="button" onClick={refresh} disabled={manualRefreshing}>
            <RefreshCcw className={manualRefreshing ? 'animate-spin' : ''} size={18} />
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
              <motion.div className="panel empty-panel" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
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
