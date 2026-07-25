import { describe, expect, it } from 'vitest';
import {
  TABLE_COLUMN_ROLES,
  resolveTableColumns,
} from './tableLayout.js';

describe('semantic table layout', () => {
  it('keeps utility columns fixed and leaves the primary column flexible', () => {
    const layout = resolveTableColumns([
      { id: 'check', role: 'check' },
      { id: 'name', role: 'primary' },
      { id: 'status', role: 'status' },
      { id: 'updatedAt', role: 'datetime' },
      { id: 'actions', role: 'actions-md' },
    ]);

    expect(layout.columns.map((column) => column.width)).toEqual([40, null, 88, 160, 120]);
    expect(layout.minWidth).toBe(568);
    expect(layout.dataAttributes).toMatchObject({
      'data-app-table-align-center': '1 3 5',
      'data-app-table-align-right': undefined,
    });
    expect(layout.warnings).toEqual([]);
  });

  it('balances multiple content columns across the remaining table width', () => {
    const layout = resolveTableColumns([
      { id: 'control', role: 'control' },
      { id: 'name', role: 'primary', minWidth: 200 },
      { id: 'connection', role: 'content', minWidth: 240 },
      { id: 'host', role: 'meta', grow: 1, minWidth: 160 },
      { id: 'actions', role: 'actions-sm' },
    ]);

    expect(layout.columns.map((column) => column.width)).toEqual([
      56,
      null,
      null,
      null,
      72,
    ]);
    expect(layout.minWidth).toBe(848);
  });

  it('protects dense labels and a single-line wide action column', () => {
    const layout = resolveTableColumns([
      { id: 'check', role: 'check' },
      { id: 'status', role: 'status' },
      { id: 'name', role: 'primary', minWidth: 240 },
      { id: 'location', role: 'meta', grow: 1, minWidth: 240 },
      { id: 'online', role: 'count' },
      { id: 'version', role: 'meta', grow: 1, minWidth: 240 },
      { id: 'labels', role: 'content', grow: 0, width: 300, verticalAlign: 'middle' },
      { id: 'type', role: 'type', grow: 1, minWidth: 240 },
      { id: 'actions', role: 'actions-xl', width: 360 },
    ]);

    expect(layout.minWidth).toBe(1836);
    expect(layout.columns[6]).toMatchObject({ width: 300, verticalAlign: 'middle' });
    expect(layout.columns[8].width).toBe(360);
    expect(layout.dataAttributes['data-app-table-action-columns']).toBe('9');
    expect(layout.dataAttributes['data-app-table-valign-top']).toBeUndefined();
  });

  it('clamps explicit widths to the role boundaries', () => {
    const narrow = resolveTableColumns([
      { id: 'status', role: 'status', width: 20 },
      { id: 'name', role: 'primary' },
    ]);
    const wide = resolveTableColumns([
      { id: 'actions', role: 'actions-sm', width: 200 },
      { id: 'name', role: 'primary' },
    ]);

    expect(narrow.columns[0].width).toBe(TABLE_COLUMN_ROLES.status.minWidth);
    expect(wide.columns[0].width).toBe(TABLE_COLUMN_ROLES['actions-sm'].maxWidth);
    expect(narrow.warnings[0].code).toBe('width-clamped');
    expect(wide.warnings[0].code).toBe('width-clamped');
  });

  it('encodes responsive visibility and top alignment as table data attributes', () => {
    const layout = resolveTableColumns([
      { id: 'name', role: 'primary' },
      { id: 'description', role: 'content', verticalAlign: 'top', hideBelow: 'sm', hasAlternate: true },
      { id: 'region', role: 'meta', hideBelow: 'md', hasAlternate: true },
    ]);

    expect(layout.dataAttributes).toMatchObject({
      'data-app-table-valign-top': '2',
      'data-app-table-hide-sm': '2',
      'data-app-table-hide-md': '3',
    });
    expect(layout.warnings).toEqual([]);
  });

  it('warns when a responsive-hidden column has no alternate access path', () => {
    const layout = resolveTableColumns([
      { id: 'name', role: 'primary' },
      { id: 'region', role: 'meta', hideBelow: 'sm' },
    ]);

    expect(layout.warnings).toContainEqual(expect.objectContaining({
      code: 'hidden-column-without-alternate',
      columnId: 'region',
    }));
  });

  it('warns when a table has no flexible content column', () => {
    const layout = resolveTableColumns([
      { id: 'status', role: 'status' },
      { id: 'updatedAt', role: 'datetime' },
    ]);

    expect(layout.warnings).toContainEqual(expect.objectContaining({ code: 'missing-flexible-column' }));
  });

  it('rejects unknown roles and duplicate column identifiers', () => {
    expect(() => resolveTableColumns([{ id: 'mystery', role: 'unknown' }])).toThrow(/unknown table column role/i);
    expect(() => resolveTableColumns([
      { id: 'name', role: 'primary' },
      { id: 'name', role: 'meta' },
    ])).toThrow(/duplicate table column id/i);
  });
});
