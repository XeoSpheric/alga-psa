import { describe, expect, it } from 'vitest';

import { normalizeDattoBaseUrl } from '@alga-psa/integrations/lib/rmm/datto/dattoApiClient';

describe('normalizeDattoBaseUrl', () => {
  it('expands a platform name to its API URL', () => {
    expect(normalizeDattoBaseUrl('merlot')).toBe('https://merlot-api.centrastage.net/api');
    expect(normalizeDattoBaseUrl(' Pinotage ')).toBe('https://pinotage-api.centrastage.net/api');
  });

  it('accepts a bare host', () => {
    expect(normalizeDattoBaseUrl('merlot-api.centrastage.net')).toBe('https://merlot-api.centrastage.net/api');
  });

  it('accepts full URLs with or without /api and trailing slashes', () => {
    expect(normalizeDattoBaseUrl('https://concord-api.centrastage.net')).toBe('https://concord-api.centrastage.net/api');
    expect(normalizeDattoBaseUrl('https://concord-api.centrastage.net/')).toBe('https://concord-api.centrastage.net/api');
    expect(normalizeDattoBaseUrl('https://concord-api.centrastage.net/api')).toBe('https://concord-api.centrastage.net/api');
    expect(normalizeDattoBaseUrl('https://concord-api.centrastage.net/api///')).toBe('https://concord-api.centrastage.net/api');
  });

  it('drops query strings and fragments', () => {
    expect(normalizeDattoBaseUrl('https://vidal-api.centrastage.net/api?x=1#top')).toBe('https://vidal-api.centrastage.net/api');
  });

  it('throws on empty or invalid input', () => {
    expect(() => normalizeDattoBaseUrl('')).toThrow();
    expect(() => normalizeDattoBaseUrl('   ')).toThrow();
    expect(() => normalizeDattoBaseUrl('https://')).toThrow();
    expect(() => normalizeDattoBaseUrl('ftp://merlot-api.centrastage.net')).toThrow();
  });

  it('rejects plain http except for localhost', () => {
    expect(() => normalizeDattoBaseUrl('http://merlot-api.centrastage.net/api')).toThrow(/https/);
    expect(normalizeDattoBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/api');
    expect(normalizeDattoBaseUrl('http://127.0.0.1:9000/api/')).toBe('http://127.0.0.1:9000/api');
  });
});
