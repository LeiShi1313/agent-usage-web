export type RateWindow = {
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: string | null;
  resetDescription?: string | null;
  nextRegenPercent?: number | null;
};

export type NamedRateWindow = {
  id: string;
  title: string;
  window: RateWindow;
};

export type UsageSnapshot = {
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
  tertiary?: RateWindow | null;
  extraRateWindows?: NamedRateWindow[] | null;
  updatedAt?: string | null;
  identity?: {
    providerID?: string | null;
    accountEmail?: string | null;
    accountOrganization?: string | null;
    loginMethod?: string | null;
  } | null;
};

export type CreditsSnapshot = {
  remaining: number;
  updatedAt?: string | null;
};

export type ProviderError = {
  message?: string;
  description?: string;
  code?: string | number;
};

export type ProviderPayload = {
  provider: string;
  account?: string | null;
  accountKey?: string | null;
  version?: string | null;
  source: string;
  status?: {
    indicator: 'none' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown';
    description?: string | null;
    updatedAt?: string | null;
    url?: string | null;
  } | null;
  usage?: UsageSnapshot | null;
  credits?: CreditsSnapshot | null;
  openaiDashboard?: {
    codeReviewRemainingPercent?: number | null;
    dailyBreakdown?: Array<{
      day: string;
      totalCreditsUsed: number;
    }> | null;
  } | null;
  error?: ProviderError | null;
  stale?: boolean;
};

export type CostPayload = {
  provider: string;
  account?: string | null;
  accountKey?: string | null;
  source: string;
  updatedAt?: string | null;
  sessionTokens?: number | null;
  sessionCostUSD?: number | null;
  last30DaysTokens?: number | null;
  last30DaysCostUSD?: number | null;
  stale?: boolean;
  targetCount?: number;
  error?: ProviderError | null;
};

export type UpstreamIssue = {
  source: string;
  code: string;
  message: string;
  provider?: string | null;
  operation: 'collection' | 'config' | 'cost' | 'poll' | 'refresh' | 'usage';
  occurredAt?: string | null;
  details?: string;
};

export type DashboardPayload = {
  mode: 'live';
  generatedAt: string;
  privacy?: {
    accountDisplay?: 'hidden' | 'label' | 'full';
  };
  freshness?: {
    lastUpdatedAt?: string | null;
    stale: boolean;
    expired: boolean;
    staleAfterSeconds: number;
    expiredAfterSeconds: number;
    sourceCount: number;
    successfulSourceCount: number;
    failedSourceCount: number;
    warning?: string | null;
  };
  usage: ProviderPayload[];
  cost: CostPayload[];
  upstreamIssues: UpstreamIssue[];
  upstreamErrors: string[];
};
