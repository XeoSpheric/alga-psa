import { describe, expect, it } from 'vitest';
import { normalizeDashboardName, readStoredLayout, validateLayoutForWrite } from '@/lib/dashboards/layout';
import { DASHBOARD_MAX_WIDGETS } from '@/lib/dashboards/types';

const ticketWidget = { instanceId: 'a1', widgetId: 'tickets.open-by-priority', size: 'sm', config: {} };

describe('validateLayoutForWrite', () => {
  it('accepts a known widget at a supported size', () => {
    const result = validateLayoutForWrite({ version: 1, widgets: [ticketWidget] });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['unknown widget', { version: 1, widgets: [{ ...ticketWidget, widgetId: 'nope.widget' }] }, 'unknown widget'],
    ['bad size', { version: 1, widgets: [{ ...ticketWidget, size: 'huge' }] }, 'size'],
    ['duplicate instance', { version: 1, widgets: [ticketWidget, ticketWidget] }, 'duplicate instanceId'],
    ['bad version', { version: 2, widgets: [] }, 'version'],
    ['unsafe instance id', { version: 1, widgets: [{ ...ticketWidget, instanceId: 'a b<' }] }, 'instanceId'],
    ['oversized config', { version: 1, widgets: [{ ...ticketWidget, config: { blob: 'x'.repeat(3000) } }] }, 'too large'],
  ])('rejects %s', (_label, input, fragment) => {
    const result = validateLayoutForWrite(input);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.detail).toContain(fragment);
  });

  it('rejects more than the widget cap', () => {
    const widgets = Array.from({ length: DASHBOARD_MAX_WIDGETS + 1 }, (_, i) => ({ ...ticketWidget, instanceId: `w${i}` }));
    expect(validateLayoutForWrite({ version: 1, widgets }).ok).toBe(false);
  });
});

describe('readStoredLayout', () => {
  it('drops retired widgets and malformed entries instead of failing', () => {
    const layout = readStoredLayout({
      version: 1,
      widgets: [
        ticketWidget,
        { instanceId: 'gone', widgetId: 'retired.widget', size: 'sm', config: {} },
        { garbage: true },
        ticketWidget,
      ],
    });
    expect(layout.widgets.map((widget) => widget.instanceId)).toEqual(['a1']);
  });

  it('parses a JSON string and survives junk', () => {
    expect(readStoredLayout(JSON.stringify({ version: 1, widgets: [ticketWidget] })).widgets).toHaveLength(1);
    expect(readStoredLayout('not json')).toEqual({ version: 1, widgets: [] });
    expect(readStoredLayout(null)).toEqual({ version: 1, widgets: [] });
  });
});

describe('normalizeDashboardName', () => {
  it('trims and collapses whitespace, enforcing 1..100 chars', () => {
    expect(normalizeDashboardName('  Service   Desk ')).toBe('Service Desk');
    expect(normalizeDashboardName('   ')).toBeNull();
    expect(normalizeDashboardName('x'.repeat(101))).toBeNull();
    expect(normalizeDashboardName(42)).toBeNull();
  });
});
