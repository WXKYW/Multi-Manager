import { describe, expect, it } from 'vitest';

import { collapseNotificationHistory, parseLifecycleHistoryMeta } from './notificationHistory.js';

describe('notificationHistory', () => {
  it('parses lifecycle metadata from history payload', () => {
    expect(parseLifecycleHistoryMeta(JSON.stringify({
      lifecycleKind: 'availability',
      lifecycleMutation: 'refresh',
      lifecycleResourceKey: 'monitor:1',
      downDuration: '3m',
      lifecycleChanges: { error: ['timeout', 'tls'] },
    }))).toEqual({
      mutation: 'refresh',
      kind: 'availability',
      resourceKey: 'monitor:1',
      duration: '3m',
      changedFields: ['error'],
    });
  });

  it('collapses a lifecycle history chain into the latest visible card', () => {
    const history = [
      {
        id: 30,
        rule_id: 'rule-1',
        channel_id: 'telegram-main',
        title: 'API Gateway',
        message: 'resolved',
        status: 'sent',
        data: JSON.stringify({
          lifecycleKind: 'availability',
          lifecycleMutation: 'resolve',
          lifecycleResourceKey: 'monitor:1',
          downDuration: '8m',
        }),
        created_at: '2026-07-30T12:03:00Z',
      },
      {
        id: 29,
        rule_id: 'rule-1',
        channel_id: 'telegram-main',
        title: 'API Gateway',
        message: 'refresh',
        status: 'sent',
        data: JSON.stringify({
          lifecycleKind: 'availability',
          lifecycleMutation: 'refresh',
          lifecycleResourceKey: 'monitor:1',
          lifecycleChanges: { error: ['timeout', 'refused'] },
        }),
        created_at: '2026-07-30T12:02:00Z',
      },
      {
        id: 28,
        rule_id: 'rule-1',
        channel_id: 'telegram-main',
        title: 'API Gateway',
        message: 'open',
        status: 'sent',
        data: JSON.stringify({
          lifecycleKind: 'availability',
          lifecycleMutation: 'open',
          lifecycleResourceKey: 'monitor:1',
        }),
        created_at: '2026-07-30T12:01:00Z',
      },
      {
        id: 11,
        rule_id: 'rule-2',
        channel_id: 'email-main',
        title: 'Other',
        message: 'single',
        status: 'sent',
        data: '{}',
        created_at: '2026-07-30T12:00:30Z',
      },
    ];

    expect(collapseNotificationHistory(history)).toEqual([
      expect.objectContaining({
        id: 30,
        lifecycle_update_count: 3,
        lifecycle_first_created_at: '2026-07-30T12:01:00Z',
        lifecycle_meta: expect.objectContaining({
          mutation: 'resolve',
          kind: 'availability',
          resourceKey: 'monitor:1',
        }),
      }),
      expect.objectContaining({
        id: 11,
        lifecycle_update_count: 0,
      }),
    ]);
  });
});
