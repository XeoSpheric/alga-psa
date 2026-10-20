'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, Lock, RefreshCw, X } from 'lucide-react';
import { BentoTile } from '@alga-psa/ui/components/bento/BentoTile';
import { Button } from '@alga-psa/ui/components/Button';
import CustomSelect from '@alga-psa/ui/components/CustomSelect';
import { Skeleton } from '@alga-psa/ui/components/Skeleton';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import type { DashboardWidgetInstance, WidgetSize } from '@/lib/dashboards/types';
import type { WidgetDefinition } from '@/lib/dashboards/widgets/definitions';
import type { OpenTicketsByPriorityData, WidgetDataResult } from '@/lib/dashboards/widgets/dataTypes';
import { getDashboardWidgetData } from '@/lib/dashboards/widgets/widgetDataActions';
import { OpenTicketsByPriorityWidget } from './OpenTicketsByPriorityWidget';
import { QuickLinksWidget } from './QuickLinksWidget';

/** Data widgets refresh themselves on this cadence while the page is open. */
const AUTO_REFRESH_MS = 5 * 60_000;

export const WIDGET_SIZE_CLASSES: Record<WidgetSize, string> = {
  sm: '',
  md: 'row-span-2',
  wide: 'md:col-span-2',
  lg: 'md:col-span-2 row-span-2',
};

function renderWidget(instance: DashboardWidgetInstance, data: unknown): React.ReactNode {
  switch (instance.widgetId) {
    case 'tickets.open-by-priority':
      return (
        <OpenTicketsByPriorityWidget
          instanceId={instance.instanceId}
          data={data as OpenTicketsByPriorityData}
          size={instance.size}
        />
      );
    case 'general.quick-links':
      return <QuickLinksWidget instanceId={instance.instanceId} size={instance.size} />;
    default:
      return null;
  }
}

interface WidgetTileProps {
  instance: DashboardWidgetInstance;
  definition: WidgetDefinition;
  editing: boolean;
  onResize?: (size: WidgetSize) => void;
  onRemove?: () => void;
  /** Drag handle props from the sortable wrapper, present only while editing. */
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  /** The parent is the grid item (sortable wrapper) and carries the spans. */
  fillParent?: boolean;
}

export function WidgetTile({ instance, definition, editing, onResize, onRemove, dragHandleProps, fillParent = false }: WidgetTileProps) {
  const { t } = useTranslation('msp/dashboard');
  const [result, setResult] = useState<WidgetDataResult | null>(null);
  const [loading, setLoading] = useState(definition.hasData);
  const requestRef = useRef(0);
  const configKey = JSON.stringify(instance.config);

  const load = useCallback(async (refresh: boolean) => {
    if (!definition.hasData) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await getDashboardWidgetData(instance.widgetId, JSON.parse(configKey), { refresh });
      if (requestId === requestRef.current) setResult(next);
    } catch {
      if (requestId === requestRef.current) {
        setResult({ status: 'error', message: '' });
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [definition.hasData, instance.widgetId, configKey]);

  useEffect(() => {
    void load(false);
    if (!definition.hasData) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, definition.hasData]);

  const title = t(definition.titleKey, { defaultValue: definition.titleDefault });
  const tileId = `dashboard-widget-${instance.instanceId}`;

  const sizeLabels: Record<WidgetSize, string> = {
    sm: t('widgets.sizes.sm', { defaultValue: 'Small' }),
    md: t('widgets.sizes.md', { defaultValue: 'Tall' }),
    wide: t('widgets.sizes.wide', { defaultValue: 'Wide' }),
    lg: t('widgets.sizes.lg', { defaultValue: 'Large' }),
  };

  const action = editing ? (
    <>
      <CustomSelect
        id={`${tileId}-size`}
        size="sm"
        className="w-24"
        value={instance.size}
        options={definition.sizes.map((size) => ({ value: size, label: sizeLabels[size] }))}
        onValueChange={(value) => onResize?.(value as WidgetSize)}
      />
      <Button
        id={`${tileId}-remove`}
        variant="ghost"
        size="xs"
        onClick={onRemove}
        aria-label={t('widgets.remove', { defaultValue: 'Remove widget' })}
      >
        <X className="h-4 w-4" />
      </Button>
    </>
  ) : definition.hasData ? (
    <Button
      id={`${tileId}-refresh`}
      variant="ghost"
      size="xs"
      onClick={() => void load(true)}
      disabled={loading}
      aria-label={t('widgets.refresh', { defaultValue: 'Refresh' })}
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
    </Button>
  ) : null;

  const icon = editing ? (
    <button
      type="button"
      className="cursor-grab touch-none text-[rgb(var(--color-text-400))] active:cursor-grabbing"
      aria-label={t('widgets.dragHandle', { defaultValue: 'Drag to reorder' })}
      {...dragHandleProps}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  ) : undefined;

  let body: React.ReactNode;
  if (!definition.hasData) {
    body = renderWidget(instance, null);
  } else if (!result) {
    body = <Skeleton className="h-full min-h-[100px] w-full" />;
  } else if (result.status === 'no-access') {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-[rgb(var(--color-text-500))]">
        <Lock className="h-5 w-5" aria-hidden />
        {t('widgets.noAccess', { defaultValue: "You don't have access to this widget's data." })}
      </div>
    );
  } else if (result.status === 'ok') {
    body = renderWidget(instance, result.data);
  }

  return (
    <BentoTile
      id={tileId}
      title={title}
      icon={icon}
      action={action}
      className={`h-full ${fillParent ? '' : WIDGET_SIZE_CLASSES[instance.size]} ${editing ? 'rounded-lg ring-1 ring-[rgb(var(--color-primary-300))]' : ''}`}
      error={result?.status === 'error'
        ? t('widgets.loadError', { defaultValue: 'This widget could not be loaded.' })
        : null}
    >
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </BentoTile>
  );
}
