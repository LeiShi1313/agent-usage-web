import { firstString } from './util.js';

export function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function providerFromRow(row) {
  return firstString(row?.provider, row?.usage?.identity?.providerID, row?.identity?.providerID, 'unknown').toLowerCase();
}

/**
 * Derive the Provider Account envelope for a CodexBar row.
 * The Account Key prefers the provider's stable operational id over display
 * email (CONTEXT.md: email is presentation metadata unless it is the only
 * identity the provider exposes).
 */
export function deriveAccount(row, provider, fallback) {
  const accountObject = typeof row?.account === 'object' && row.account ? row.account : null;
  const identity = row?.usage?.identity ?? row?.identity ?? {};
  const rawAccount = typeof row?.account === 'string' ? row.account : null;
  const email = firstString(
    row?.accountEmail,
    row?.email,
    accountObject?.email,
    identity?.accountEmail,
    identity?.email
  ) ?? (looksLikeEmail(rawAccount) ? rawAccount : null);
  const rawId = firstString(
    row?.accountKey,
    row?.accountId,
    row?.accountID,
    row?.providerAccountId,
    accountObject?.key,
    accountObject?.id,
    accountObject?.accountId,
    identity?.accountKey,
    identity?.accountId,
    identity?.accountID,
    identity?.providerAccountId
  );
  const label = firstString(
    rawAccount,
    row?.accountName,
    row?.label,
    accountObject?.label,
    accountObject?.name,
    identity?.accountName,
    email,
    rawId,
    fallback?.label
  );
  const organization = firstString(
    row?.accountOrganization,
    row?.organization,
    accountObject?.organization,
    identity?.accountOrganization,
    identity?.organization,
    fallback?.organization
  );
  const key = firstString(rawId, email, rawAccount, fallback?.key);

  return {
    key: key ?? 'unknown:local',
    label: label ?? (key ? `${provider} account` : null),
    email: email ?? fallback?.email ?? null,
    organization: organization ?? fallback?.organization ?? null,
    identitySource: key ? 'codexbar' : (fallback?.identitySource ?? 'unknown')
  };
}
