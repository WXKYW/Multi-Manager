(function exposeDomainMatcher(root) {
  'use strict';

  const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
    'ac', 'co', 'com', 'edu', 'gov', 'net', 'org',
  ]);
  const IGNORED_LABELS = new Set([
    'account', 'accounts', 'auth', 'authentication', 'id', 'login', 'mfa',
    'oauth', 'otp', 'secure', 'security', 'signin', 'sso', 'verify', 'www',
    ...COMMON_SECOND_LEVEL_SUFFIXES,
  ]);

  function normalizeHostname(value) {
    const hostname = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!hostname || hostname.includes(' ') || hostname.includes('/')) return '';
    return hostname;
  }

  function hostnameFromUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return normalizeHostname(url.hostname);
    } catch {
      return '';
    }
  }

  function isIpAddress(hostname) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  }

  function registrableDomain(hostname) {
    const host = normalizeHostname(hostname);
    if (!host || host === 'localhost' || isIpAddress(host)) return host;
    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return host;
    const secondLevel = labels[labels.length - 2];
    const countryCodeTld = labels[labels.length - 1].length === 2;
    const suffixLength = countryCodeTld && COMMON_SECOND_LEVEL_SUFFIXES.has(secondLevel) ? 3 : 2;
    return labels.slice(-suffixLength).join('.');
  }

  function normalizeComparable(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function compact(value) {
    return normalizeComparable(value).replace(/\s+/g, '');
  }

  function domainIdentity(hostname) {
    const host = normalizeHostname(hostname);
    const registered = registrableDomain(host);
    const labels = host.split('.').filter(label => label.length >= 3 && !IGNORED_LABELS.has(label));
    const registeredLabel = registered.split('.')[0] || '';
    return {
      host,
      registered,
      hostCompact: compact(host),
      registeredCompact: compact(registered),
      brandLabels: [...new Set([registeredLabel, ...labels].filter(label => label.length >= 3))],
    };
  }

  function exactDomainCandidates(value) {
    const text = String(value || '').trim();
    const candidates = new Set();
    const emailHost = text.match(/@([^\s/@:]+(?:\.[^\s/@:]+)+)$/i)?.[1];
    const urlHost = hostnameFromUrl(text);
    for (const candidate of [emailHost, urlHost]) {
      const normalized = normalizeHostname(candidate);
      if (normalized) candidates.add(normalized);
    }
    return candidates;
  }

  function scoreAccount(account, identity) {
    const issuer = normalizeComparable(account?.issuer);
    const accountName = normalizeComparable(account?.account);
    const issuerCompact = compact(account?.issuer);
    if (!issuer && !accountName) return 0;

    const exactDomains = new Set([
      ...exactDomainCandidates(account?.issuer),
      ...exactDomainCandidates(account?.account),
    ]);
    for (const candidate of exactDomains) {
      if (candidate === identity.host) return 100;
      if (registrableDomain(candidate) === identity.registered) return 90;
    }

    if (issuerCompact.length >= 3) {
      if (issuerCompact === identity.hostCompact || issuerCompact === identity.registeredCompact) return 80;
      if (identity.brandLabels.some(label => compact(label) === issuerCompact)) return 70;
      if (issuerCompact.length >= 4 && identity.brandLabels.some(label => compact(label).startsWith(issuerCompact))) return 60;
    }

    const accountTokens = new Set(accountName.split(/\s+/).filter(token => token.length >= 3));
    if (identity.brandLabels.some(label => accountTokens.has(normalizeComparable(label)))) return 50;
    return 0;
  }

  function matchForHostname(accounts, hostname) {
    const identity = domainIdentity(hostname);
    if (!identity.host) return [];
    return (Array.isArray(accounts) ? accounts : [])
      .map((account, index) => ({ account, index, score: scoreAccount(account, identity) }))
      .filter(result => result.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(result => result.account);
  }

  function matchAccounts(accounts, urls = {}) {
    const candidates = [
      { source: 'tab', hostname: hostnameFromUrl(urls.tabUrl) },
      { source: 'frame', hostname: hostnameFromUrl(urls.frameUrl) || normalizeHostname(urls.frameHostname) },
    ].filter((candidate, index, list) => candidate.hostname && list.findIndex(item => item.hostname === candidate.hostname) === index);

    for (const candidate of candidates) {
      const matches = matchForHostname(accounts, candidate.hostname);
      if (matches.length > 0) return { matches, context: candidate };
    }

    return {
      matches: [],
      context: candidates[0] || { source: 'none', hostname: '' },
    };
  }

  root.ApiMonitorDomainMatcher = {
    hostnameFromUrl,
    matchAccounts,
    normalizeHostname,
    registrableDomain,
  };
})(globalThis);
