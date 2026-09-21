export function validateDashboardUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || loopback && url.protocol === 'http:')) {
    throw new Error('Use the HTTPS dashboard origin, or HTTP on loopback. Credentials must not be included in the URL.');
  }
  return url.origin;
}
export function companionClient(base, token) {
  base = validateDashboardUrl(base);
  return async (action, body, method = 'POST') => {
    const response = await fetch(`${base}/api/auto-buy/worker/${action}`,{
      method, redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{ 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) },
      ...(method === 'GET' ? {} : { body:JSON.stringify(body || {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Checkout server request failed.'),{ status:response.status });
    return data;
  };
}
