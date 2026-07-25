import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Table } from '@cloudflare/kumo/components/table';
import { AppTable } from '../components/ui/AppPrimitives.jsx';

describe('AppTable semantic layout', () => {
  it('renders a semantic colgroup and table-level alignment contract', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        AppTable,
        {
          tableId: 'test-table',
          columns: [
          { id: 'name', role: 'primary' },
          { id: 'status', role: 'status' },
          { id: 'actions', role: 'actions-sm' },
          ],
        },
        React.createElement(
          Table.Header,
          null,
          React.createElement(
            Table.Row,
            null,
            React.createElement(Table.Head, null, 'Name'),
            React.createElement(Table.Head, null, 'Status'),
            React.createElement(Table.Head, null, 'Actions')
          )
        )
      )
    );

    expect(markup).toContain('class="isolate w-full table-fixed');
    expect(markup).toContain('app-semantic-table');
    expect(markup).toContain('data-app-table-align-center="2 3"');
    expect(markup).toContain('data-column-role="primary"');
    expect(markup).toContain('data-column-role="status" style="width:88px"');
    expect(markup).toContain('min-width:320px');
  });

  it('turns legacy pixel widths into an effective colgroup', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        AppTable,
        { widths: [240, 96, 120] },
        React.createElement(Table.Body)
      )
    );

    expect(markup).toContain('<col style="width:240px"/>');
    expect(markup).toContain('<col style="width:96px"/>');
    expect(markup).toContain('<col style="width:120px"/>');
    expect(markup).toContain('min-width:456px');
  });
});
