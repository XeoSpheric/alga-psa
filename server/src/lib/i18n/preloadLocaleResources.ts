import 'server-only';
import { readFile } from 'fs/promises';
import path from 'path';
import { headers } from 'next/headers';
import { getNamespacesForRoute } from '@alga-psa/core/i18n/config';
import type { PreloadedNamespaceResources } from '@alga-psa/ui/lib/i18n/client';

/**
 * Read the JSON translation files for the current route's namespaces off disk
 * so they can be embedded in the initial HTML. This replaces N per-namespace
 * `/locales/{lng}/{ns}.json` HTTP fetches (i18next-http-backend) with zero
 * network round-trips — the client seeds i18next from these resources.
 *
 * Namespaces are resolved from the middleware-stamped `x-pathname` header, so
 * the shared MSP layout preloads exactly what the concrete page needs.
 */
// Locale files are static in production builds; parse each once per process
// rather than re-reading ~10 files on every full page render. Development
// re-reads so translation edits show up without a restart.
const namespaceCache = new Map<string, Promise<Record<string, unknown> | null>>();

async function readNamespaceFile(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNamespace(file: string): Promise<Record<string, unknown> | null> {
  if (process.env.NODE_ENV !== 'production') return readNamespaceFile(file);
  let pending = namespaceCache.get(file);
  if (!pending) {
    pending = readNamespaceFile(file);
    namespaceCache.set(file, pending);
  }
  return pending;
}

export async function preloadLocaleResources(
  locale: string,
): Promise<PreloadedNamespaceResources> {
  let pathname = '/';
  try {
    const headerList = await headers();
    pathname = headerList.get('x-pathname') || headerList.get('x-invoke-path') || '/';
  } catch {
    // headers() unavailable (static context) — fall back to base namespaces.
  }

  // 'common' + the route's namespaces, plus cross-cutting namespaces that the
  // shared MSP shell (quick-create, drawers, pickers, shortcuts) pulls lazily
  // on essentially every page — preloading them here avoids a per-namespace
  // HTTP fetch after hydration.
  const SHELL_NAMESPACES = [
    'common',
    'msp/core',
    'msp/clients',
    'msp/assets',
    'msp/contacts',
    'msp/time-entry',
    'msp/keyboard-shortcuts',
    'msp/surveys',
    'features/projects',
    'features/documents',
  ];
  const namespaces = Array.from(new Set([...SHELL_NAMESPACES, ...getNamespacesForRoute(pathname)]));
  const localesDir = path.join(process.cwd(), 'public', 'locales', locale);

  const entries = await Promise.all(
    namespaces.map(async (namespace) => {
      const data = await readNamespace(path.join(localesDir, `${namespace}.json`));
      // Missing/unreadable namespace file: let the client backend fetch it.
      return data ? ([namespace, data] as const) : null;
    }),
  );

  const resources: PreloadedNamespaceResources = {};
  for (const entry of entries) {
    if (entry) resources[entry[0]] = entry[1];
  }
  return resources;
}
