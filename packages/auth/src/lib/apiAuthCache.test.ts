import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearApiAuthCache, getApiAuthCacheTtlMs, memoizeApiAuth } from './apiAuthCache';

describe('apiAuthCache', () => {
  beforeEach(() => {
    vi.stubEnv('API_AUTH_CACHE_TTL_MS', '10000');
    clearApiAuthCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    clearApiAuthCache();
  });

  it('defaults to 10s, is off under NODE_ENV=test, and treats 0 or junk as off', () => {
    vi.stubEnv('API_AUTH_CACHE_TTL_MS', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(getApiAuthCacheTtlMs()).toBe(10_000);
    vi.stubEnv('NODE_ENV', 'test');
    expect(getApiAuthCacheTtlMs()).toBe(0);
    vi.stubEnv('API_AUTH_CACHE_TTL_MS', '0');
    expect(getApiAuthCacheTtlMs()).toBe(0);
    vi.stubEnv('API_AUTH_CACHE_TTL_MS', 'nope');
    expect(getApiAuthCacheTtlMs()).toBe(0);
  });

  it('reuses a loaded value until the TTL lapses', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => 'value');

    expect(await memoizeApiAuth('k', load)).toBe('value');
    expect(await memoizeApiAuth('k', load)).toBe('value');
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    await memoizeApiAuth('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('always loads when the TTL is 0', async () => {
    vi.stubEnv('API_AUTH_CACHE_TTL_MS', '0');
    const load = vi.fn(async () => 'value');
    await memoizeApiAuth('k', load);
    await memoizeApiAuth('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => { resolve = r; }));

    const first = memoizeApiAuth('k', load);
    const second = memoizeApiAuth('k', load);
    resolve('value');

    await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not store rejections or results cacheIf refuses', async () => {
    const failing = vi.fn(async () => { throw new Error('db down'); });
    await expect(memoizeApiAuth('fail', failing)).rejects.toThrow('db down');
    await expect(memoizeApiAuth('fail', failing)).rejects.toThrow('db down');
    expect(failing).toHaveBeenCalledTimes(2);

    const missing = vi.fn(async () => null);
    await memoizeApiAuth('missing', missing, { cacheIf: (v) => v !== null });
    await memoizeApiAuth('missing', missing, { cacheIf: (v) => v !== null });
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it('never keeps an entry past notAfter', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ({ expiresAt: Date.now() + 2_000 }));

    await memoizeApiAuth('k', load, { notAfter: (v) => v.expiresAt });
    vi.advanceTimersByTime(1_000);
    await memoizeApiAuth('k', load, { notAfter: (v) => v.expiresAt });
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);
    await memoizeApiAuth('k', load, { notAfter: (v) => v.expiresAt });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('clear() drops entries and discards loads that were in flight', async () => {
    const load = vi.fn(async () => 'value');
    await memoizeApiAuth('k', load);
    clearApiAuthCache();
    await memoizeApiAuth('k', load);
    expect(load).toHaveBeenCalledTimes(2);

    let resolve!: (value: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const pending = memoizeApiAuth('slow', slow);
    clearApiAuthCache();
    resolve('stale');
    await pending;
    await memoizeApiAuth('slow', async () => 'fresh').then((v) => expect(v).toBe('fresh'));
  });
});
