/**
 * Short-lived, per-process cache for API-key authentication lookups.
 *
 * Every REST call re-resolves the same identity (key record, owner gate,
 * user + roles, tenant product, roles with permissions) before doing any real
 * work: about 14 queries per request. Caching those results for a few seconds
 * removes most of that load.
 *
 * Trade-off: a deactivated user, a role change or a suspended tenant can take
 * up to the TTL to apply to API calls. Key revocation through ApiKeyService
 * clears the cache, so it applies immediately on this process.
 *
 * API_AUTH_CACHE_TTL_MS sets the TTL (default 10s; 0 disables). The default is
 * 0 under NODE_ENV=test so unit tests that swap DB mocks never see stale
 * results. Rejections and loads the caller marks uncacheable are never stored.
 */

const DEFAULT_TTL_MS = 10_000;
const MAX_ENTRIES = 5_000;

type Entry = { value: unknown; expiresAt: number };

type CacheState = {
  entries: Map<string, Entry>;
  inflight: Map<string, Promise<unknown>>;
  generation: number;
};

// Next.js can load this module once per server chunk; keep one shared store so
// clearApiAuthCache() reaches every copy.
const STATE_KEY = Symbol.for('alga-psa.apiAuthCache');
const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: CacheState };

function state(): CacheState {
  return (globalWithState[STATE_KEY] ??= { entries: new Map(), inflight: new Map(), generation: 0 });
}

export function getApiAuthCacheTtlMs(): number {
  const raw = process.env.API_AUTH_CACHE_TTL_MS;
  if (raw === undefined || raw === '') {
    return process.env.NODE_ENV === 'test' ? 0 : DEFAULT_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface MemoizeApiAuthOptions<T> {
  /** Return false to skip caching this result (e.g. not found, usage-limited key). */
  cacheIf?: (value: T) => boolean;
  /** Absolute epoch ms the entry must not outlive (e.g. the key's expires_at). */
  notAfter?: (value: T) => number | null | undefined;
}

export async function memoizeApiAuth<T>(
  key: string,
  load: () => Promise<T>,
  options: MemoizeApiAuthOptions<T> = {},
): Promise<T> {
  const ttl = getApiAuthCacheTtlMs();
  if (ttl <= 0) return load();

  const s = state();
  const now = Date.now();
  const hit = s.entries.get(key);
  if (hit) {
    if (hit.expiresAt > now) return hit.value as T;
    s.entries.delete(key);
  }

  const pending = s.inflight.get(key);
  if (pending) return pending as Promise<T>;

  const generation = s.generation;
  const promise = load()
    .then((value) => {
      // A clear() during the load means the result may predate a revocation.
      if (generation === s.generation && (options.cacheIf?.(value) ?? true)) {
        const notAfter = options.notAfter?.(value);
        const expiresAt = Math.min(now + ttl, notAfter ?? Number.POSITIVE_INFINITY);
        if (expiresAt > Date.now()) {
          if (!s.entries.has(key) && s.entries.size >= MAX_ENTRIES) {
            const oldest = s.entries.keys().next().value;
            if (oldest !== undefined) s.entries.delete(oldest);
          }
          s.entries.set(key, { value, expiresAt });
        }
      }
      return value;
    })
    .finally(() => {
      if (s.inflight.get(key) === promise) s.inflight.delete(key);
    });
  s.inflight.set(key, promise);
  return promise;
}

/** Drop every cached API auth result on this process (call after revocations). */
export function clearApiAuthCache(): void {
  const s = state();
  s.entries.clear();
  s.inflight.clear();
  s.generation += 1;
}
