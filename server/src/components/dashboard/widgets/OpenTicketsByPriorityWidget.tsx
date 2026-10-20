'use client';

import React from 'react';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import { BentoTileEmpty } from '@alga-psa/ui/components/bento/BentoTile';
import type { OpenTicketsByPriorityData } from '@/lib/dashboards/widgets/dataTypes';
import type { WidgetSize } from '@/lib/dashboards/types';
import { DonutChart, resolveSliceColors } from './charts/DonutChart';

export function OpenTicketsByPriorityWidget({
  instanceId,
  data,
  size,
}: {
  instanceId: string;
  data: OpenTicketsByPriorityData;
  size: WidgetSize;
}) {
  const { t } = useTranslation('msp/dashboard');

  if (data.total === 0) {
    return (
      <BentoTileEmpty id={`${instanceId}-empty`}>
        {t('widgets.ticketsOpenByPriority.empty', { defaultValue: 'No open tickets.' })}
      </BentoTileEmpty>
    );
  }

  const slices = resolveSliceColors(data.slices).map((slice) => ({
    ...slice,
    label: slice.label || t('widgets.ticketsOpenByPriority.noPriority', { defaultValue: 'No priority' }),
  }));

  return (
    <DonutChart
      id={`${instanceId}-donut`}
      slices={slices}
      total={data.total}
      totalHref={data.listHref}
      showLegend={size !== 'sm' || slices.length <= 5}
    />
  );
}
