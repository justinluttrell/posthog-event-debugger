// Content script - injects code into page context and relays messages

// Inject the script into the page context
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = function() {
  (this as HTMLScriptElement).remove();
};
(document.head || document.documentElement).appendChild(script);

// Check if extension context is still valid
function isExtensionContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Listen for events from the injected script
window.addEventListener('posthog-debugger-event', ((event: CustomEvent) => {
  // Check if extension context is still valid before trying to send message
  if (!isExtensionContextValid()) {
    return;
  }

  // Get the page URL where the event was fired
  const pageUrl = window.location.href;

  // Forward to background script
  chrome.runtime.sendMessage({
    action: 'captureEvent',
    url: pageUrl,
    apiUrl: event.detail.url,
    data: event.detail.data,
    timestamp: event.detail.timestamp
  }).catch((error) => {
      console.error('[PostHog Debugger] Error forwarding to background:', error);
  });
}) as EventListener);
