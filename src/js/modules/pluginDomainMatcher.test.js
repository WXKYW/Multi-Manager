const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* global describe, expect, it */

function loadMatcher() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'plugin', 'domain-matcher.js'), 'utf8');
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.ApiMonitorDomainMatcher;
}

describe('browser extension domain matching', () => {
  const matcher = loadMatcher();

  it('prefers the top-level tab over an embedded authentication frame', () => {
    const accounts = [
      { id: 'app', issuer: 'Example', account: 'admin@example.com' },
      { id: 'frame', issuer: 'Auth Provider', account: 'admin@auth-provider.com' },
    ];
    const result = matcher.matchAccounts(accounts, {
      tabUrl: 'https://login.example.co.uk/security',
      frameUrl: 'https://auth-provider.com/challenge',
    });
    expect(result.matches.map(account => account.id)).toEqual(['app']);
    expect(result.context).toEqual({ hostname: 'login.example.co.uk', source: 'tab' });
  });

  it('falls back to the frame only when the top-level site has no match', () => {
    const accounts = [{ id: 'frame', issuer: 'Auth Provider', account: 'user' }];
    const result = matcher.matchAccounts(accounts, {
      tabUrl: 'https://unrelated.example/',
      frameUrl: 'https://login.auth-provider.com/challenge',
    });
    expect(result.matches.map(account => account.id)).toEqual(['frame']);
    expect(result.context.source).toBe('frame');
  });

  it('avoids empty, generic, and substring issuer matches', () => {
    const accounts = [
      { id: 'empty', issuer: '', account: 'user' },
      { id: 'login', issuer: 'Login', account: 'user' },
      { id: 'github', issuer: 'GitHub', account: 'user@example.net' },
      { id: 'tools', issuer: 'GitHub Tools', account: 'user' },
    ];
    expect(matcher.matchAccounts(accounts, { tabUrl: 'https://github.com/login' }).matches)
      .toEqual([accounts[2]]);
  });

  it('matches exact account domains and recognizable brand prefixes', () => {
    const accounts = [
      { id: 'email', issuer: 'Work', account: 'me@service.example.com' },
      { id: 'microsoft', issuer: 'Microsoft', account: 'user' },
    ];
    expect(matcher.matchAccounts(accounts, { tabUrl: 'https://service.example.com' }).matches).toEqual([accounts[0]]);
    expect(matcher.matchAccounts(accounts, { tabUrl: 'https://login.microsoftonline.com' }).matches).toEqual([accounts[1]]);
  });

  it('handles localhost, invalid URLs, and internationalized hosts', () => {
    expect(matcher.hostnameFromUrl('http://localhost:5173/login')).toBe('localhost');
    expect(matcher.hostnameFromUrl('not a url')).toBe('');
    expect(matcher.hostnameFromUrl('https://例子.测试/login')).toBe('xn--fsqu00a.xn--0zwm56d');
  });
});
