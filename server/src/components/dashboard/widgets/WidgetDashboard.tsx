'use client';

import React, { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LayoutGrid, Plus } from 'lucide-react';
import { Button } from '@alga-psa/ui/components/Button';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import { getErrorMessage, isActionMessageError, isActionPermissionError } from '@alga-psa/ui/lib/errorHandling';
import type { DashboardDetail, DashboardLayout, DashboardWidgetInstance, WidgetSize } from '@/lib/dashboards/types';
import { getWidgetDefinition } from '@/lib/dashboards/widgets/definitions';
import { updateDashboard } from '@/lib/dashboards/dashboardActions';
import { WIDGET_SIZE_CLASSES, WidgetTile } from './WidgetTile';
import { AddWidgetDialog } from './AddWidgetDialog';

function newInstanceId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function SortableWidget(props: {
  instance: DashboardWidgetInstance;
  onResize: (size: WidgetSize) => void;
  onRemove: () => void;
}) {
  const { instance } = props;
  const definition = getWidgetDefinition(instance.widgetId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: instance.instanceId });
  if (!definition) return null;

  // The sortable wrapper becomes the grid item, so it carries the span classes.
  return (
    <div
      ref={setNodeRef}
      className={`${WIDGET_SIZE_CLASSES[instance.size]} ${isDragging ? 'z-10 opacity-70' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <WidgetTile
        instance={instance}
        definition={definition}
        editing
        onResize={props.onResize}
        onRemove={props.onRemove}
        dragHandleProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>}
        fillParent
      />
    </div>
  );
}

interface WidgetDashboardProps {
  dashboard: DashboardDetail;
  /** Opens the dashboard on the Customize view (e.g. right after creation). */
  startEditing?: boolean;
}

export function WidgetDashboard({ dashboard, startEditing = false }: WidgetDashboardProps) {
  const { t } = useTranslation('msp/dashboard');
  const router = useRouter();
  const [editing, setEditing] = useState(startEditing && dashboard.capabilities.canEdit);
  const [draft, setDraft] = useState<DashboardLayout>(dashboard.layout);
  const [addOpen, setAddOpen] = useState(false);
  const [isSaving, startSaving] = useTransition();

  // A fresh server render (after save, refresh or switching dashboards) wins
  // over a stale draft whenever we are not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(dashboard.layout);
  }, [dashboard.layout, dashboard.updated_at, editing]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const widgets = editing ? draft.widgets : dashboard.layout.widgets;

  const updateWidgets = (next: DashboardWidgetInstance[]) => setDraft({ version: 1, widgets: next });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = draft.widgets.findIndex((widget) => widget.instanceId === active.id);
    const to = draft.widgets.findIndex((widget) => widget.instanceId === over.id);
    if (from < 0 || to < 0) return;
    updateWidgets(arrayMove(draft.widgets, from, to));
  };

  const addWidget = (widgetId: string) => {
    const definition = getWidgetDefinition(widgetId);
    if (!definition) return;
    updateWidgets([
      ...draft.widgets,
      { instanceId: newInstanceId(), widgetId, size: definition.defaultSize, config: { ...definition.defaultConfig } },
    ]);
    setAddOpen(false);
  };

  const cancel = () => {
    setDraft(dashboard.layout);
    setEditing(false);
  };

  const save = () => {
    startSaving(async () => {
      const result = await updateDashboard(dashboard.dashboard_id, {
        layout: draft,
        expectedUpdatedAt: dashboard.updated_at,
      });
      if (isActionMessageError(result) || isActionPermissionError(result)) {
        toast.error(getErrorMessage(result));
        return;
      }
      setEditing(false);
      toast.success(t('dashboards.saved', { defaultValue: 'Dashboard saved.' }));
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {dashboard.capabilities.canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {editing ? (
            <>
              <Button id="dashboard-add-widget" variant="outline" size="sm" onClick={() => setAddOpen(true)} disabled={isSaving}>
                <Plus className="mr-1 h-4 w-4" />
                {t('widgets.add', { defaultValue: 'Add widget' })}
              </Button>
              <Button id="dashboard-cancel-edit" variant="ghost" size="sm" onClick={cancel} disabled={isSaving}>
                {t('actions.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button id="dashboard-save-edit" size="sm" onClick={save} disabled={isSaving}>
                {isSaving
                  ? t('actions.saving', { defaultValue: 'Saving…' })
                  : t('actions.done', { defaultValue: 'Done' })}
              </Button>
            </>
          ) : (
            <Button id="dashboard-customize" variant="outline" size="sm" onClick={() => setEditing(true)}>
              <LayoutGrid className="mr-1 h-4 w-4" />
              {t('actions.customize', { defaultValue: 'Customize' })}
            </Button>
          )}
        </div>
      ) : null}

      {widgets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[rgb(var(--color-border-300))] p-10 text-center">
          <p className="mb-3 text-sm text-[rgb(var(--color-text-500))]">
            {dashboard.capabilities.canEdit
              ? t('dashboards.emptyEditable', { defaultValue: 'This dashboard has no widgets yet. Add one to get started.' })
              : t('dashboards.emptyReadOnly', { defaultValue: 'This dashboard has no widgets yet.' })}
          </p>
          {dashboard.capabilities.canEdit ? (
            <Button
              id="dashboard-empty-add-widget"
              size="sm"
              onClick={() => {
                setEditing(true);
                setAddOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              {t('widgets.add', { defaultValue: 'Add widget' })}
            </Button>
          ) : null}
        </div>
      ) : editing ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={draft.widgets.map((widget) => widget.instanceId)} strategy={rectSortingStrategy}>
            <div className="grid grid-flow-row-dense auto-rows-[220px] grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {draft.widgets.map((instance) => (
                <SortableWidget
                  key={instance.instanceId}
                  instance={instance}
                  onResize={(size) => updateWidgets(draft.widgets.map((widget) =>
                    widget.instanceId === instance.instanceId ? { ...widget, size } : widget))}
                  onRemove={() => updateWidgets(draft.widgets.filter((widget) => widget.instanceId !== instance.instanceId))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="grid grid-flow-row-dense auto-rows-[220px] grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {widgets.map((instance) => {
            const definition = getWidgetDefinition(instance.widgetId);
            return definition ? (
              <WidgetTile key={instance.instanceId} instance={instance} definition={definition} editing={false} />
            ) : null;
          })}
        </div>
      )}

      <AddWidgetDialog isOpen={addOpen} onClose={() => setAddOpen(false)} onAdd={addWidget} />
    </div>
  );
}
