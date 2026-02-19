# Privacy Policy

PostHog Event Debugger does not collect, transmit, or sell personal data.

All data displayed by the extension is processed locally within the user's browser and never leaves the device. The extension passively observes PostHog analytics events that are already present in the page's JavaScript context for the purpose of developer debugging.

No data is sent to external servers.
No analytics or tracking is performed by the extension itself.
No event data is transmitted off-device by the extension.

Locally stored data includes:
- Captured PostHog event payloads and metadata, stored in `chrome.storage.local` to preserve events across extension service worker restarts.
- Extension preferences such as UI state and filters.

Stored event data can be removed at any time by using the extension's **Clear All** button, which clears the persisted event history.
