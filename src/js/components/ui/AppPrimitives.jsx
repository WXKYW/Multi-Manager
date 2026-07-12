import React, { useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Table } from '@cloudflare/kumo/components/table';
import { LayerCard } from '@cloudflare/kumo';
import { Info } from '../Icons.jsx';

export const pageStackClass = 'flex w-full min-w-0 flex-col gap-3 sm:gap-4';
export const pageToolbarClass = 'flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-kumo-line pb-3 sm:items-center [&>*]:min-w-0';
export const sectionCardHeaderClass = 'flex min-h-[56px] flex-wrap items-start justify-between gap-3 border-b border-kumo-line bg-kumo-recessed/30 px-4 py-3.5 sm:items-center';
export const sectionCardTitleClass = 'inline-flex min-w-0 max-w-full items-center gap-2 text-sm font-bold text-kumo-strong';
export const iconButtonIconClass = 'h-3.5 w-3.5';
export const actionIconClass = 'h-4 w-4';

const cardPaddingClass = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
  xl: 'p-6',
};

const tableDensityClass = {
  comfortable: '',
  compact: '[&_td]:!px-3 [&_td]:!py-2 [&_th]:!px-3 [&_th]:!py-2',
  dense: '[&_td]:!px-2 [&_td]:!py-1.5 [&_th]:!px-2 [&_th]:!py-1.5',
};

const pillToneClass = {
  neutral: 'bg-kumo-recessed text-kumo-subtle border-kumo-line',
  brand: 'bg-kumo-brand/10 text-kumo-brand border-kumo-brand/20',
  info: 'bg-kumo-info/10 text-kumo-info border-kumo-info/20',
  success: 'bg-kumo-success/10 text-kumo-success border-kumo-success/20',
  warning: 'bg-kumo-warning/10 text-kumo-warning border-kumo-warning/20',
  danger: 'bg-kumo-danger/10 text-kumo-danger border-kumo-danger/20',
};

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function PageStack({ className = '', children }) {
  return <div className={cx(pageStackClass, className)}>{children}</div>;
}

export function PageToolbar({ className = '', children }) {
  return <div className={cx(pageToolbarClass, className)}>{children}</div>;
}

export function AppCard({
  className = '',
  padding = 'md',
  interactive = false,
  children,
  ...props
}) {
  return (
    <LayerCard
      {...props}
      className={cx(
        'rounded-lg border border-kumo-line/90 bg-kumo-base shadow-none',
        cardPaddingClass[padding] || cardPaddingClass.md,
        interactive && 'transition-colors hover:border-kumo-brand/60',
        className
      )}
    >
      {children}
    </LayerCard>
  );
}

const insetToneClass = {
  recessed: 'border-kumo-line/80 bg-kumo-recessed/20',
  surface: 'border-kumo-line/70 bg-kumo-surface',
  dashed: 'border-dashed border-kumo-line/70 bg-transparent',
};

const keyValueGridColumnsClass = {
  1: 'grid-cols-1',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
};

export function SectionCard({
  title,
  description,
  icon,
  meta,
  action,
  actions,
  children,
  className = '',
  headerClassName = '',
  bodyClassName = '',
  bodyPadding = 'md',
  titleClassName = '',
  descriptionClassName = '',
  ...props
}) {
  const trailing = [
    meta && <React.Fragment key="meta">{meta}</React.Fragment>,
    action && <React.Fragment key="action">{action}</React.Fragment>,
    actions && <React.Fragment key="actions">{actions}</React.Fragment>,
  ].filter(Boolean);
  return (
    <div
      {...props}
      className={cx('flex flex-col overflow-hidden rounded-lg border border-kumo-line/90 bg-kumo-base p-0 shadow-none', className)}
    >
      <div className={cx(sectionCardHeaderClass, headerClassName)}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <div className={cx(sectionCardTitleClass, titleClassName)}>
            {icon}
            {typeof title === 'string' || typeof title === 'number' ? (
              <span className="min-w-0 truncate">{title}</span>
            ) : (
              title
            )}
          </div>
          {description && (
            <div className={cx('min-w-0 flex-1 basis-40 truncate text-xs font-normal text-kumo-subtle', descriptionClassName)}>
              {description}
            </div>
          )}
        </div>
        {trailing.length > 0 && (
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {trailing}
          </div>
        )}
      </div>
      <div className={cx(cardPaddingClass[bodyPadding] || cardPaddingClass.md, bodyClassName)}>
        {children}
      </div>
    </div>
  );
}

export function InsetPanel({
  tone = 'recessed',
  className = '',
  bodyClassName = '',
  padding = 'md',
  children,
  ...props
}) {
  return (
    <LayerCard
      {...props}
      className={cx('overflow-hidden rounded-lg border shadow-none', insetToneClass[tone] || insetToneClass.recessed, className)}
    >
      <LayerCard.Primary className={cx(cardPaddingClass[padding] || cardPaddingClass.md, bodyClassName)}>
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}

export function DataTableFrame({
  className = '',
  density = 'compact',
  variant = 'card',
  children,
  ...props
}) {
  const frameClassName = cx('overflow-x-auto', tableDensityClass[density], className);

  if (variant === 'embedded') {
    return (
      <div {...props} className={frameClassName}>
        {children}
      </div>
    );
  }

  return (
    <AppCard
      {...props}
      padding="none"
      className={frameClassName}
    >
      {children}
    </AppCard>
  );
}

export function AppTable({
  widths,
  fitContent = false,
  className = '',
  style,
  ...props
}) {
  const minWidth = Array.isArray(widths)
    ? widths.reduce((total, width) => total + (Number(width) || 0), 0)
    : undefined;

  return (
    <Table
      {...props}
      className={className}
      style={{
        ...(minWidth
          ? { minWidth, width: fitContent ? minWidth : '100%' }
          : undefined),
        ...style,
      }}
    />
  );
}

export function ScrollableTable({
  widths,
  wrapperClassName = 'min-w-0 max-w-full overflow-x-auto scrollbar-thin',
  ...props
}) {
  return (
    <div className={wrapperClassName}>
      <AppTable widths={widths} {...props} />
    </div>
  );
}

export function StatusBadge({ tone = 'neutral', children, className = '', ...props }) {
  const variant = {
    neutral: 'secondary',
    brand: 'info',
    info: 'info',
    success: 'success',
    warning: 'warning',
    danger: 'error',
    error: 'error',
  }[tone] || 'secondary';

  return (
    <Badge {...props} variant={variant} className={cx('shrink-0', className)}>
      {children}
    </Badge>
  );
}

export function getStatusPillClass(tone = 'neutral', { border = true } = {}) {
  return cx(border && 'border', pillToneClass[tone] || pillToneClass.neutral);
}

export function getHttpStatusPillClass(code, options) {
  const statusCode = Number(code);
  if (!Number.isFinite(statusCode)) return getStatusPillClass('neutral', options);
  if (statusCode >= 200 && statusCode < 300) return getStatusPillClass('success', options);
  if (statusCode === 429 || statusCode >= 400) return getStatusPillClass('danger', options);
  return getStatusPillClass('neutral', options);
}

export function InlineStatusPill({ tone = 'neutral', children, className = '', ...props }) {
  return (
    <span
      {...props}
      className={cx('inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold', getStatusPillClass(tone), className)}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon: Icon = Info,
  title,
  description,
  action,
  className = '',
  card = true,
}) {
  const content = (
    <div className={cx('flex min-h-44 flex-col items-center justify-center p-6 text-center', className)}>
      <Icon className="mb-3 h-8 w-8 text-kumo-subtle" />
      <div className="text-sm font-semibold text-kumo-strong">{title}</div>
      {description && <div className="mt-1 max-w-sm text-xs leading-relaxed text-kumo-subtle">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );

  if (!card) return content;
  return <AppCard padding="none">{content}</AppCard>;
}

export function KeyValueGrid({
  items,
  columns = 2,
  className = '',
  itemClassName = '',
  labelClassName = '',
  valueClassName = '',
}) {
  return (
    <div className={cx('grid gap-3 text-sm', keyValueGridColumnsClass[columns] || keyValueGridColumnsClass[2], className)}>
      {items.map((item) => (
        <div key={item.key || item.label} className={cx('min-w-0', itemClassName, item.className)}>
          <div className={cx('text-xs text-kumo-subtle', labelClassName, item.labelClassName)}>{item.label}</div>
          <div className={cx('mt-1 min-w-0 text-kumo-strong', valueClassName, item.valueClassName)}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChartBoundaryBox({ className = '', children }) {
  const [boundary, setBoundary] = useState(null);
  return (
    <div ref={setBoundary} className={className}>
      {typeof children === 'function' ? children(boundary) : children}
    </div>
  );
}

export function ChartCard({ className = '', children }) {
  const [boundary, setBoundary] = useState(null);
  return (
    <LayerCard
      className={cx('min-w-0 overflow-hidden rounded-lg border border-kumo-line/90 bg-kumo-base p-3 shadow-none', className)}
    >
      <div ref={setBoundary} className="flex h-full min-w-0 flex-col">
        {typeof children === 'function' ? children(boundary) : children}
      </div>
    </LayerCard>
  );
}

export function ChartWarmupSkeleton({ height = 120, bars = 5 }) {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col justify-end gap-2 overflow-hidden rounded-md border border-kumo-line/70 bg-kumo-recessed/35 p-3"
      style={{ height }}
    >
      <SkeletonLine className="h-3 w-1/3" />
      <SkeletonLine className="h-14 w-full rounded" />
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${bars}, minmax(0, 1fr))` }}>
        {Array.from({ length: bars }).map((_, index) => (
          <SkeletonLine key={index} className="h-2 w-full" />
        ))}
      </div>
    </div>
  );
}
