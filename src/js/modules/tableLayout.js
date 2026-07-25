const fixedRole = (minWidth, idealWidth, maxWidth, align = 'left') => ({
  minWidth,
  idealWidth,
  maxWidth,
  grow: 0,
  align,
  verticalAlign: 'middle',
});

const flexibleRole = (minWidth, idealWidth, align = 'left', verticalAlign = 'middle') => ({
  minWidth,
  idealWidth,
  maxWidth: null,
  grow: 1,
  align,
  verticalAlign,
});

export const TABLE_COLUMN_ROLES = Object.freeze({
  check: fixedRole(40, 40, 40, 'center'),
  control: fixedRole(48, 56, 64, 'center'),
  status: fixedRole(72, 88, 112, 'center'),
  type: fixedRole(80, 96, 128, 'center'),
  count: fixedRole(72, 88, 112, 'right'),
  number: fixedRole(88, 112, 144, 'right'),
  date: fixedRole(104, 120, 144),
  datetime: fixedRole(136, 160, 184),
  meta: fixedRole(104, 136, 176),
  'actions-sm': fixedRole(56, 72, 80, 'center'),
  'actions-md': fixedRole(96, 120, 144, 'center'),
  'actions-lg': fixedRole(144, 184, 240, 'center'),
  'actions-xl': fixedRole(280, 340, 400, 'center'),
  primary: flexibleRole(160, 240),
  content: flexibleRole(200, 320, 'left', 'top'),
  identifier: flexibleRole(176, 240),
});

const VALID_ALIGNMENTS = new Set(['left', 'center', 'right']);
const VALID_VERTICAL_ALIGNMENTS = new Set(['middle', 'top']);
const VALID_HIDE_BREAKPOINTS = new Set(['sm', 'md']);

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function columnIndexes(columns, predicate) {
  const indexes = columns
    .map((column, index) => (predicate(column) ? index + 1 : null))
    .filter(Boolean);
  return indexes.length > 0 ? indexes.join(' ') : undefined;
}

function normalizeColumn(input, index, warnings) {
  const source = typeof input === 'string' ? { role: input } : (input || {});
  const role = source.role || 'primary';
  const roleDefaults = TABLE_COLUMN_ROLES[role];
  if (!roleDefaults) {
    throw new Error(`Unknown table column role: ${role}`);
  }

  const id = String(source.id || `${role}-${index + 1}`);
  const minWidth = positiveNumber(source.minWidth, roleDefaults.minWidth);
  const configuredMax = source.maxWidth === null
    ? null
    : positiveNumber(source.maxWidth, roleDefaults.maxWidth);
  const maxWidth = configuredMax === null ? null : Math.max(configuredMax, minWidth);
  const grow = source.grow === undefined
    ? roleDefaults.grow
    : Math.max(Number(source.grow) || 0, 0);
  const explicitWidth = source.width === undefined || source.width === null
    ? null
    : positiveNumber(source.width, roleDefaults.idealWidth);
  const preferredWidth = explicitWidth ?? roleDefaults.idealWidth;
  const clampedWidth = Math.max(minWidth, maxWidth === null ? preferredWidth : Math.min(preferredWidth, maxWidth));
  const width = explicitWidth !== null || grow === 0 ? clampedWidth : null;

  if (explicitWidth !== null && explicitWidth !== clampedWidth) {
    warnings.push({
      code: 'width-clamped',
      columnId: id,
      requestedWidth: explicitWidth,
      resolvedWidth: clampedWidth,
    });
  }

  const align = VALID_ALIGNMENTS.has(source.align) ? source.align : roleDefaults.align;
  const verticalAlign = VALID_VERTICAL_ALIGNMENTS.has(source.verticalAlign)
    ? source.verticalAlign
    : roleDefaults.verticalAlign;
  const hideBelow = VALID_HIDE_BREAKPOINTS.has(source.hideBelow) ? source.hideBelow : null;

  if (hideBelow && !source.hasAlternate) {
    warnings.push({
      code: 'hidden-column-without-alternate',
      columnId: id,
      hideBelow,
    });
  }

  return {
    id,
    role,
    minWidth,
    idealWidth: roleDefaults.idealWidth,
    maxWidth,
    width,
    grow,
    align,
    verticalAlign,
    hideBelow,
    sticky: source.sticky || null,
    resizable: Boolean(source.resizable),
  };
}

export function resolveTableColumns(columnSpecs = []) {
  if (!Array.isArray(columnSpecs) || columnSpecs.length === 0) {
    return {
      columns: [],
      minWidth: 0,
      dataAttributes: {},
      warnings: [],
    };
  }

  const warnings = [];
  const columns = columnSpecs.map((column, index) => normalizeColumn(column, index, warnings));
  const ids = new Set();
  columns.forEach((column) => {
    if (ids.has(column.id)) {
      throw new Error(`Duplicate table column id: ${column.id}`);
    }
    ids.add(column.id);
  });

  if (!columns.some((column) => column.width === null && column.grow > 0)) {
    warnings.push({ code: 'missing-flexible-column' });
  }

  const fixedWidth = columns.reduce(
    (total, column) => total + (column.width ?? 0),
    0
  );
  const flexibleColumns = columns.filter((column) => column.width === null && column.grow > 0);
  const widestFlexibleMinimum = flexibleColumns.reduce(
    (maximum, column) => Math.max(maximum, column.minWidth),
    0
  );
  const minWidth = fixedWidth + (widestFlexibleMinimum * flexibleColumns.length);

  return {
    columns,
    minWidth,
    dataAttributes: {
      'data-app-table-align-center': columnIndexes(columns, (column) => column.align === 'center'),
      'data-app-table-align-right': columnIndexes(columns, (column) => column.align === 'right'),
      'data-app-table-valign-top': columnIndexes(columns, (column) => column.verticalAlign === 'top'),
      'data-app-table-hide-sm': columnIndexes(columns, (column) => column.hideBelow === 'sm'),
      'data-app-table-hide-md': columnIndexes(columns, (column) => column.hideBelow === 'md'),
      'data-app-table-action-columns': columnIndexes(columns, (column) => column.role.startsWith('actions-')),
    },
    warnings,
  };
}
