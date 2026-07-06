const optionalString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

export const buildTotpAccountPayload = (accountForm, { includeSecret = false } = {}) => {
  const payload = {
    otp_type: accountForm.otp_type,
    issuer: String(accountForm.issuer || '').trim(),
    account: String(accountForm.account || '').trim(),
    algorithm: accountForm.algorithm,
    digits: Number(accountForm.digits),
    period: Number(accountForm.period),
    counter: Number(accountForm.counter),
    group_id: optionalString(accountForm.group_id),
    color: optionalString(accountForm.color),
  };

  if (includeSecret) {
    payload.secret = String(accountForm.secret || '').replace(/\s/g, '');
  }

  return payload;
};
