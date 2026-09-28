// Minimaler fetch-Wrapper mit Timeout und aussagekräftigen Fehlern.
export async function requestJson(url, { timeoutMs = 10_000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    const err = new Error(`HTTP ${res.status} von ${new URL(url).host}: ${detail?.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}
