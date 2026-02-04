// This script runs in the page context and can intercept fetch/XHR

// Intercept fetch
const originalFetch = window.fetch;
window.fetch = async function(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  const isPost = init?.method === 'POST';
  // Match /e or /i/v0/e endpoints with gzip compression
  if (url.includes('/e') && url.includes('compression=gzip-js') && isPost && init?.body) {
    try {
      // PostHog sends gzip-compressed data as a Blob
      const bodyData = init.body instanceof Blob
        ? await init.body.arrayBuffer()
        : init.body as ArrayBuffer;

      // Send to content script via custom event
      window.dispatchEvent(new CustomEvent('posthog-debugger-event', {
        detail: {
          url,
          data: Array.from(new Uint8Array(bodyData)),
          timestamp: new Date().toISOString()
        }
      }));

    } catch (error) {
      console.error('[PostHog Debugger] Error intercepting:', error);
    }
  }

  return originalFetch.call(this, input, init);
};
