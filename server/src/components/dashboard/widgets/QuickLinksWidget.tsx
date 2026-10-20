'use client';

import React from 'react';
import Link from 'next/link';
import { BarChart3, Calendar, ClipboardList, HeartPulse, Monitor, Ticket } from 'lucide-react';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import type { WidgetSize } from '@/lib/dashboards/types';

const LINKS = [
  { id: 'tickets', href: '/msp/tickets', icon: Ticket, labelKey: 'widgets.quickLinks.tickets', labelDefault: 'Tickets' },
  { id: 'projects', href: '/msp/projects', icon: ClipboardList, labelKey: 'widgets.quickLinks.projects', labelDefault: 'Projects' },
  { id: 'schedule', href: '/msp/schedule', icon: Calendar, labelKey: 'widgets.quickLinks.schedule', labelDefault: 'Schedule' },
  { id: 'assets', href: '/msp/assets', icon: Monitor, labelKey: 'widgets.quickLinks.assets', labelDefault: 'Assets' },
  { id: 'reports', href: '/msp/reports', icon: BarChart3, labelKey: 'widgets.quickLinks.reports', labelDefault: 'Reports' },
  { id: 'jobs', href: '/msp/jobs', icon: HeartPulse, labelKey: 'widgets.quickLinks.jobs', labelDefault: 'Jobs' },
] as const;

export function QuickLinksWidget({ instanceId, size }: { instanceId: string; size: WidgetSize }) {
  const { t } = useTranslation('msp/dashboard');
  const columns = size === 'sm' || size === 'md' ? 'grid-cols-2' : 'grid-cols-3';

  return (
    <div className={`grid ${columns} gap-2`}>
      {LINKS.map(({ id, href, icon: Icon, labelKey, labelDefault }) => (
        <Link
          key={id}
          id={`${instanceId}-${id}`}
          href={href}
          className="flex items-center gap-2 rounded-md border border-[rgb(var(--color-border-200))] px-3 py-2 text-sm text-[rgb(var(--color-text-700))] hover:border-[rgb(var(--color-primary-400))] hover:bg-[rgb(var(--color-primary-50))]"
        >
          <Icon className="h-4 w-4 flex-shrink-0 text-[rgb(var(--color-primary-500))]" aria-hidden />
          <span className="truncate">{t(labelKey, { defaultValue: labelDefault })}</span>
        </Link>
      ))}
    </div>
  );
}
