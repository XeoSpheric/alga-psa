'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

export interface DonutChartSlice {
  key: string;
  label: string;
  count: number;
  color: string;
  href: string | null;
}

interface DonutChartProps {
  id: string;
  slices: DonutChartSlice[];
  total: number;
  /** Link for the center number (e.g. the whole unfiltered list). */
  totalHref?: string | null;
  /** Hide the legend on the smallest tile size. */
  showLegend?: boolean;
}

/**
 * Clickable donut. Each slice and its legend row navigate to the slice's
 * `href`; legend rows are real links so the chart is keyboard reachable.
 * Colors arrive resolved (see `resolveSliceColors`), because SVG presentation
 * attributes cannot read CSS variables.
 */
export function DonutChart({ id, slices, total, totalHref, showLegend = true }: DonutChartProps) {
  const router = useRouter();

  const center = (
    <span className="text-3xl font-semibold tabular-nums text-[rgb(var(--color-text-900))]">{total}</span>
  );

  return (
    <div id={id} className="flex h-full min-h-0 items-center gap-4">
      <div className="relative h-full min-h-[120px] aspect-square max-h-[180px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={slices.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
              onClick={(entry: { payload?: DonutChartSlice }) => {
                const href = entry?.payload?.href;
                if (href) router.push(href);
              }}
            >
              {slices.map((slice) => (
                <Cell
                  key={slice.key}
                  fill={slice.color}
                  style={{ cursor: slice.href ? 'pointer' : 'default', outline: 'none' }}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, name: string) => [value, name]}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {totalHref ? (
            <Link
              id={`${id}-total`}
              href={totalHref}
              className="pointer-events-auto rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--color-primary-500))]"
            >
              {center}
            </Link>
          ) : center}
        </div>
      </div>

      {showLegend ? (
        <ul className="min-w-0 flex-1 space-y-1 overflow-y-auto text-sm">
          {slices.map((slice) => {
            const content = (
              <>
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: slice.color }} aria-hidden />
                <span className="truncate text-[rgb(var(--color-text-700))]">{slice.label}</span>
                <span className="ml-auto tabular-nums text-[rgb(var(--color-text-500))]">{slice.count}</span>
              </>
            );
            return (
              <li key={slice.key}>
                {slice.href ? (
                  <Link
                    id={`${id}-slice-${slice.key}`}
                    href={slice.href}
                    className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-[rgb(var(--color-border-100))]"
                  >
                    {content}
                  </Link>
                ) : (
                  <div className="flex items-center gap-2 px-1 py-0.5">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Categorical fallback palette; readable on light and dark cards. */
export const CHART_PALETTE = [
  '#7C3AED', '#0891B2', '#F59E0B', '#DC2626', '#2563EB', '#16A34A', '#DB2777', '#64748B',
] as const;

/**
 * Use each slice's own color (e.g. a priority's configured color) only when
 * every slice has a distinct one; otherwise a shared default (many tenants
 * leave every priority at the stock gray) would make the slices
 * indistinguishable, so fall back to the palette for all of them.
 */
export function resolveSliceColors<T extends { color: string | null }>(slices: T[]): Array<T & { color: string }> {
  const own = slices.map((slice) => slice.color?.trim().toLowerCase() || null);
  const distinct = own.every((color) => color !== null) && new Set(own).size === own.length;
  return slices.map((slice, index) => ({
    ...slice,
    color: distinct ? (slice.color as string) : CHART_PALETTE[index % CHART_PALETTE.length],
  }));
}
