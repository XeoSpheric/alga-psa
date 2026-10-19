import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';
import { getAuthOptions } from '../lib/nextAuthOptions';

// NextAuth resolves this config on every server-side auth() call, and building
// it reads ~10 OAuth secrets through the secret provider chain (filesystem
// reads by default). Reuse the built options briefly; secret rotation is
// picked up once the TTL lapses.
const AUTH_OPTIONS_TTL_MS = 30_000;
let cachedOptions: { value: Promise<NextAuthConfig>; expiresAt: number } | null = null;

function getCachedAuthOptions(): Promise<NextAuthConfig> {
  const now = Date.now();
  if (!cachedOptions || cachedOptions.expiresAt <= now) {
    const value = getAuthOptions();
    cachedOptions = { value, expiresAt: now + AUTH_OPTIONS_TTL_MS };
    value.catch(() => {
      if (cachedOptions?.value === value) cachedOptions = null;
    });
  }
  return cachedOptions.value;
}

// Full Node.js handlers with providers and callbacks
const full = (NextAuth as any)(async () => {
  const options = await getCachedAuthOptions();
  return { ...options, trustHost: true };
});

// Export auth from the full configuration to get proper session data
export const { auth, handlers, signIn, signOut } = full;
