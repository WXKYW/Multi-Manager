import { describe, expect, it } from 'vitest';
import { buildTotpAccountPayload } from './totpPayload.js';

const baseForm = {
  otp_type: 'totp',
  issuer: ' GitHub ',
  account: ' user@example.com ',
  secret: 'JBSW Y3DP EHPK3PXP',
  algorithm: 'SHA1',
  digits: '6',
  period: '30',
  counter: '0',
  group_id: '',
  color: '',
};

describe('buildTotpAccountPayload', () => {
  it('preserves string group ids when saving an account', () => {
    const payload = buildTotpAccountPayload({
      ...baseForm,
      group_id: 'group_1712345678901_ab12cd34ef',
    });

    expect(payload.group_id).toBe('group_1712345678901_ab12cd34ef');
    expect(JSON.parse(JSON.stringify(payload)).group_id).toBe('group_1712345678901_ab12cd34ef');
  });

  it('uses null for empty optional group and color values', () => {
    const payload = buildTotpAccountPayload({
      ...baseForm,
      group_id: '   ',
      color: '',
    });

    expect(payload.group_id).toBeNull();
    expect(payload.color).toBeNull();
  });

  it('cleans add-account secrets only when requested', () => {
    const addPayload = buildTotpAccountPayload(baseForm, { includeSecret: true });
    const editPayload = buildTotpAccountPayload(baseForm);

    expect(addPayload.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(editPayload).not.toHaveProperty('secret');
  });
});
