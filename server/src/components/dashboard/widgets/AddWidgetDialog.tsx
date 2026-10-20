'use client';

import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@alga-psa/ui/components/Dialog';
import Spinner from '@alga-psa/ui/components/Spinner';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import {
  WIDGET_CATEGORY_ORDER,
  WIDGET_DEFINITIONS,
  type WidgetCategory,
} from '@/lib/dashboards/widgets/definitions';
import { getAddableWidgetIds } from '@/lib/dashboards/widgets/widgetDataActions';

const CATEGORY_LABELS: Record<WidgetCategory, { key: string; fallback: string }> = {
  general: { key: 'widgets.categories.general', fallback: 'General' },
  tickets: { key: 'widgets.categories.tickets', fallback: 'Tickets' },
  assets: { key: 'widgets.categories.assets', fallback: 'Assets' },
  time: { key: 'widgets.categories.time', fallback: 'Time' },
  sla: { key: 'widgets.categories.sla', fallback: 'SLA' },
  surveys: { key: 'widgets.categories.surveys', fallback: 'Surveys' },
  projects: { key: 'widgets.categories.projects', fallback: 'Projects' },
  sales: { key: 'widgets.categories.sales', fallback: 'Sales' },
};

/** Widget catalog, limited to widgets whose data the caller can read. */
export function AddWidgetDialog({
  isOpen,
  onClose,
  onAdd,
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (widgetId: string) => void;
}) {
  const { t } = useTranslation('msp/dashboard');
  const [allowed, setAllowed] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!isOpen || allowed) return;
    let cancelled = false;
    getAddableWidgetIds(WIDGET_DEFINITIONS.map((definition) => definition.id))
      .then((ids) => {
        if (!cancelled) setAllowed(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setAllowed(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, allowed]);

  const visible = WIDGET_DEFINITIONS.filter((definition) => allowed?.has(definition.id));

  return (
    <Dialog
      id="dashboard-add-widget-dialog"
      isOpen={isOpen}
      onClose={onClose}
      title={t('widgets.addDialog.title', { defaultValue: 'Add a widget' })}
      className="max-w-2xl"
    >
      <DialogContent>
        {!allowed ? (
          <div className="flex justify-center py-6"><Spinner size="sm" /></div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-[rgb(var(--color-text-500))]">
            {t('widgets.addDialog.none', { defaultValue: 'No widgets are available to you.' })}
          </p>
        ) : (
          <div className="space-y-5">
            {WIDGET_CATEGORY_ORDER.map((category) => {
              const inCategory = visible.filter((definition) => definition.category === category);
              if (inCategory.length === 0) return null;
              const label = CATEGORY_LABELS[category];
              return (
                <section key={category}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[rgb(var(--color-text-500))]">
                    {t(label.key, { defaultValue: label.fallback })}
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {inCategory.map((definition) => (
                      <button
                        key={definition.id}
                        id={`dashboard-add-widget-${definition.id}`}
                        type="button"
                        onClick={() => onAdd(definition.id)}
                        className="rounded-md border border-[rgb(var(--color-border-200))] p-3 text-left hover:border-[rgb(var(--color-primary-400))] hover:bg-[rgb(var(--color-primary-50))]"
                      >
                        <div className="text-sm font-medium text-[rgb(var(--color-text-900))]">
                          {t(definition.titleKey, { defaultValue: definition.titleDefault })}
                        </div>
                        <div className="mt-1 text-xs text-[rgb(var(--color-text-500))]">
                          {t(definition.descriptionKey, { defaultValue: definition.descriptionDefault })}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
