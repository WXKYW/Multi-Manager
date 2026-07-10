const optionalString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

const SVG_REPO_ICON_REF_PATTERN = /(?:svgrepo:)?(?:https?:\/\/(?:www\.)?svgrepo\.com\/(?:show|download|svg)\/)?([0-9]{3,9})[-/:]([a-z0-9][a-z0-9-]{0,80})(?:\.svg)?/i;

const normalizeIcon = (value) => {
  const text = optionalString(value);
  if (!text) return null;
  const match = text.match(SVG_REPO_ICON_REF_PATTERN);
  if (!match) return text;
  return `svgrepo:${match[1]}-${match[2].replace(/^-+|-+$/g, '').toLowerCase()}`;
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
    icon: normalizeIcon(accountForm.icon),
    color: optionalString(accountForm.color),
  };

  if (includeSecret) {
    payload.secret = String(accountForm.secret || '').replace(/\s/g, '');
  }

  return payload;
};
