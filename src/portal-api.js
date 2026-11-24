export async function portalApi(path, { token, method = 'GET', body, download = false, signal } = {}) {
  const base = (import.meta.env.VITE_CASHZILLA_API_URL || '').replace(/\/$/, '');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetch(base + '/api' + path, {
    method, signal: requestSignal, redirect: 'error',
    headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (download && response.ok) {
    return { blob: await response.blob(), filename: response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] };
  }
  if (response.status === 204 || response.status === 201) return;
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    const error = new Error(data?.error || 'Cashzilla’s account service is unavailable. Check the server connection.');
    error.status = response.status;
    throw error;
  }
  return data;
}
