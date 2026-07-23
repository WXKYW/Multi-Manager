export function fileboxDownloadEndpoint(code) {
  return `/api/filebox/public/${encodeURIComponent(code)}/download`;
}

export function fileboxShareURL(code) {
  return `${window.location.origin}/share/${encodeURIComponent(code)}`;
}

export function fileboxDirectURL(code) {
  return `${window.location.origin}/api/filebox/d/${encodeURIComponent(code)}`;
}
