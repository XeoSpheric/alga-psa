'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Check,
  ChevronDown,
  Copy,
  Home,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import { Button } from '@alga-psa/ui/components/Button';
import { Badge } from '@alga-psa/ui/components/Badge';
import { ConfirmationDialog } from '@alga-psa/ui/components/ConfirmationDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@alga-psa/ui/components/DropdownMenu';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import { getErrorMessage, isActionMessageError, isActionPermissionError } from '@alga-psa/ui/lib/errorHandling';
import type { DashboardCollection, DashboardDetail, DashboardRole, DashboardSummary } from '@/lib/dashboards/types';
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  leaveDashboard,
  setLandingDashboard,
  updateDashboard,
} from '@/lib/dashboards/dashboardActions';
import { dashboardHref } from '@/lib/dashboards/widgets/links';
import { DashboardNameDialog } from './DashboardNameDialog';
import { WidgetDashboard } from './WidgetDashboard';

interface DashboardPageShellProps {
  collection: DashboardCollection;
  /** The selected widget dashboard; null shows Home. */
  active: DashboardDetail | null;
  /** The URL named a dashboard the caller cannot see. */
  notFound: boolean;
  /** Server-rendered Home dashboard (today's welcome page, unchanged). */
  home: React.ReactNode;
}

function failed(result: unknown): boolean {
  if (isActionMessageError(result) || isActionPermissionError(result)) {
    toast.error(getErrorMessage(result));
    return true;
  }
  return false;
}

/**
 * Dashboard switcher + the selected dashboard. Home stays the default and
 * renders exactly as before; widget dashboards are additive.
 */
export function DashboardPageShell({ collection, active, notFound, home }: DashboardPageShellProps) {
  const { t } = useTranslation('msp/dashboard');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  const roleLabel = (role: DashboardRole) => {
    switch (role) {
      case 'owner':
        return t('dashboards.roles.owner', { defaultValue: 'Owner' });
      case 'edit':
        return t('dashboards.roles.edit', { defaultValue: 'Can edit' });
      default:
        return t('dashboards.roles.view', { defaultValue: 'View only' });
    }
  };

  const go = (dashboardId: string | null) => router.push(dashboardHref(dashboardId));

  const isLanding = active
    ? collection.landingDashboardId === active.dashboard_id
    : collection.landingDashboardId === null;

  const handleCreate = (name: string) => {
    startTransition(async () => {
      const result = await createDashboard({ name });
      if (failed(result)) return;
      const created = result as DashboardDetail;
      setCreateOpen(false);
      setJustCreatedId(created.dashboard_id);
      go(created.dashboard_id);
    });
  };

  const handleRename = (name: string) => {
    if (!active) return;
    startTransition(async () => {
      const result = await updateDashboard(active.dashboard_id, { name, expectedUpdatedAt: active.updated_at });
      if (failed(result)) return;
      setRenameOpen(false);
      router.refresh();
    });
  };

  const handleDuplicate = () => {
    if (!active) return;
    startTransition(async () => {
      const result = await duplicateDashboard(active.dashboard_id);
      if (failed(result)) return;
      toast.success(t('dashboards.duplicated', { defaultValue: 'Copied to your dashboards.' }));
      go((result as DashboardDetail).dashboard_id);
    });
  };

  const handleDelete = () => {
    if (!active) return;
    startTransition(async () => {
      const result = await deleteDashboard(active.dashboard_id);
      if (failed(result)) return;
      setDeleteOpen(false);
      go(null);
    });
  };

  const handleLeave = () => {
    if (!active) return;
    startTransition(async () => {
      const result = await leaveDashboard(active.dashboard_id);
      if (failed(result)) return;
      setLeaveOpen(false);
      go(null);
    });
  };

  const handleToggleLanding = () => {
    startTransition(async () => {
      const target = active && !isLanding ? active.dashboard_id : null;
      const result = await setLandingDashboard(target);
      if (failed(result)) return;
      toast.success(target
        ? t('dashboards.landingSet', { defaultValue: 'This dashboard now opens first.' })
        : t('dashboards.landingCleared', { defaultValue: 'Home now opens first.' }));
      router.refresh();
    });
  };

  const renderItem = (dashboard: DashboardSummary) => (
    <DropdownMenuItem
      key={dashboard.dashboard_id}
      id={`dashboard-switch-${dashboard.dashboard_id}`}
      onSelect={() => go(dashboard.dashboard_id)}
      className="gap-2"
    >
      <span className="w-4 flex-shrink-0">
        {active?.dashboard_id === dashboard.dashboard_id ? <Check className="h-4 w-4" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{dashboard.name}</span>
      {dashboard.role !== 'owner' ? (
        <span className="truncate text-xs text-[rgb(var(--color-text-400))]">{dashboard.owner_name}</span>
      ) : dashboard.is_shared ? (
        <Users className="h-3.5 w-3.5 text-[rgb(var(--color-text-400))]" aria-label={t('dashboards.shared', { defaultValue: 'Shared' })} />
      ) : null}
      {collection.landingDashboardId === dashboard.dashboard_id ? (
        <Star className="h-3.5 w-3.5 fill-current text-amber-500" aria-hidden />
      ) : null}
    </DropdownMenuItem>
  );

  const currentName = active ? active.name : t('dashboards.home', { defaultValue: 'Home' });
  const caps = active?.capabilities;

  return (
    <div>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-6 pt-6">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button id="dashboard-switcher" variant="outline" size="sm" className="max-w-xs gap-2">
              {active ? null : <Home className="h-4 w-4 flex-shrink-0" />}
              <span className="truncate">{currentName}</span>
              <ChevronDown className="h-4 w-4 flex-shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 max-h-[70vh] overflow-y-auto">
            <DropdownMenuItem id="dashboard-switch-home" onSelect={() => go(null)} className="gap-2">
              <span className="w-4 flex-shrink-0">{active ? null : <Check className="h-4 w-4" />}</span>
              <Home className="h-4 w-4" />
              <span className="flex-1">{t('dashboards.home', { defaultValue: 'Home' })}</span>
              {collection.landingDashboardId === null ? (
                <Star className="h-3.5 w-3.5 fill-current text-amber-500" aria-hidden />
              ) : null}
            </DropdownMenuItem>
            {collection.owned.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-[rgb(var(--color-text-500))]">
                  {t('dashboards.mine', { defaultValue: 'My dashboards' })}
                </DropdownMenuLabel>
                {collection.owned.map(renderItem)}
              </>
            ) : null}
            {collection.sharedWithMe.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-[rgb(var(--color-text-500))]">
                  {t('dashboards.sharedWithMe', { defaultValue: 'Shared with me' })}
                </DropdownMenuLabel>
                {collection.sharedWithMe.map(renderItem)}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem id="dashboard-new" onSelect={() => setCreateOpen(true)} className="gap-2">
              <span className="w-4" />
              <Plus className="h-4 w-4" />
              {t('dashboards.new', { defaultValue: 'New dashboard' })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {active && active.role !== 'owner' ? (
          <Badge variant="default-muted" size="sm">
            {roleLabel(active.role)} · {active.owner_name}
          </Badge>
        ) : null}

        <Button
          id="dashboard-toggle-landing"
          variant="ghost"
          size="sm"
          onClick={handleToggleLanding}
          disabled={isPending || (!active && isLanding)}
          aria-pressed={isLanding}
          title={isLanding
            ? t('dashboards.landingCurrent', { defaultValue: 'Opens first when you visit the dashboard' })
            : t('dashboards.setLanding', { defaultValue: 'Open this dashboard first' })}
        >
          <Star className={`h-4 w-4 ${isLanding ? 'fill-current text-amber-500' : ''}`} />
        </Button>

        {active ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                id="dashboard-more-actions"
                variant="ghost"
                size="sm"
                aria-label={t('dashboards.moreActions', { defaultValue: 'More dashboard actions' })}
                disabled={isPending}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {caps?.canEdit ? (
                <DropdownMenuItem id="dashboard-rename" onSelect={() => setRenameOpen(true)} className="gap-2">
                  <Pencil className="h-4 w-4" />
                  {t('dashboards.rename', { defaultValue: 'Rename' })}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem id="dashboard-duplicate" onSelect={handleDuplicate} className="gap-2">
                <Copy className="h-4 w-4" />
                {t('dashboards.duplicate', { defaultValue: 'Duplicate' })}
              </DropdownMenuItem>
              {caps?.canLeave ? (
                <DropdownMenuItem id="dashboard-leave" onSelect={() => setLeaveOpen(true)} className="gap-2">
                  <LogOut className="h-4 w-4" />
                  {t('dashboards.leave', { defaultValue: 'Leave dashboard' })}
                </DropdownMenuItem>
              ) : null}
              {caps?.canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    id="dashboard-delete"
                    onSelect={() => setDeleteOpen(true)}
                    className="gap-2 text-[rgb(var(--color-accent-600))]"
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('dashboards.delete', { defaultValue: 'Delete dashboard' })}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {notFound ? (
        <div className="mx-auto max-w-7xl px-6 pt-4">
          <div
            id="dashboard-not-found"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
          >
            {t('dashboards.notFound', {
              defaultValue: 'That dashboard is private or no longer exists. Showing Home instead.',
            })}
          </div>
        </div>
      ) : null}

      {active ? (
        <div className="mx-auto max-w-7xl p-6">
          <WidgetDashboard
            key={active.dashboard_id}
            dashboard={active}
            startEditing={justCreatedId === active.dashboard_id}
          />
        </div>
      ) : (
        home
      )}

      <DashboardNameDialog
        id="dashboard-create-dialog"
        isOpen={createOpen}
        title={t('dashboards.createTitle', { defaultValue: 'New dashboard' })}
        submitLabel={t('actions.create', { defaultValue: 'Create' })}
        isSubmitting={isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
      />
      {active ? (
        <>
          <DashboardNameDialog
            id="dashboard-rename-dialog"
            isOpen={renameOpen}
            title={t('dashboards.renameTitle', { defaultValue: 'Rename dashboard' })}
            submitLabel={t('actions.save', { defaultValue: 'Save' })}
            initialName={active.name}
            isSubmitting={isPending}
            onClose={() => setRenameOpen(false)}
            onSubmit={handleRename}
          />
          <ConfirmationDialog
            id="dashboard-delete-confirm"
            isOpen={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onConfirm={handleDelete}
            isConfirming={isPending}
            title={t('dashboards.deleteTitle', { defaultValue: 'Delete dashboard?' })}
            message={active.is_shared
              ? t('dashboards.deleteSharedMessage', {
                defaultValue: '"{{name}}" will be removed for you and everyone it is shared with.',
                name: active.name,
              })
              : t('dashboards.deleteMessage', { defaultValue: '"{{name}}" will be removed.', name: active.name })}
            confirmLabel={t('dashboards.delete', { defaultValue: 'Delete dashboard' })}
          />
          <ConfirmationDialog
            id="dashboard-leave-confirm"
            isOpen={leaveOpen}
            onClose={() => setLeaveOpen(false)}
            onConfirm={handleLeave}
            isConfirming={isPending}
            title={t('dashboards.leaveTitle', { defaultValue: 'Leave dashboard?' })}
            message={t('dashboards.leaveMessage', {
              defaultValue: '"{{name}}" will no longer appear in your list unless {{owner}} shares it again.',
              name: active.name,
              owner: active.owner_name,
            })}
            confirmLabel={t('dashboards.leave', { defaultValue: 'Leave dashboard' })}
          />
        </>
      ) : null}
    </div>
  );
}
