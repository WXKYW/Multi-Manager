import { Tabs } from '@cloudflare/kumo';

function PublicOverviewStats({ items, activeKey = '', onChange, className = '' }) {
  return (
    <Tabs
      variant="segmented"
      size="sm"
      value={activeKey || items[0]?.key}
      onValueChange={onChange}
      className={`w-fit max-w-full ${className}`}
      listClassName="w-fit max-w-full"
      tabs={items.map((item) => ({
        value: item.key,
        label: <span className="inline-flex min-w-[3.75rem] items-center justify-between gap-2 tabular-nums"><span>{item.label}</span><strong>{item.value}</strong></span>,
      }))}
    />
  );
}

export default PublicOverviewStats;
