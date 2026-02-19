import type { PostHogEvent, GetEventsResponse, ClearEventsResponse } from './types';
import * as pako from 'pako';

const EVENTS_STORAGE_KEY = 'capturedEvents';

const MAX_STORED_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB
const CLEANUP_SIZE_BYTES = 2 * 1024 * 1024; // Prune 2 MiB when over budget

let events: PostHogEvent[] = [];
let currentSizeBytes = 0;
let isLoaded = false;
let loadPromise: Promise<void> | null = null;

function estimateEventSize(event: PostHogEvent): number {
  const decodedSize = event.decoded ? JSON.stringify(event.decoded).length * 2 : 0;
  const rawDataSize = event.rawData ? event.rawData.length : 0;
  const metadataSize = (event.url.length + event.id.length + event.timestamp.length + (event.domain?.length || 0)) * 2;
  return decodedSize + rawDataSize + metadataSize;
}

function recomputeSize(): void {
  currentSizeBytes = events.reduce((sum, event) => sum + estimateEventSize(event), 0);
}

function cleanupOldEvents(bytesToFree: number): void {
  let freedBytes = 0;
  let removed = 0;

  while (freedBytes < bytesToFree && events.length > 0) {
    const oldestEvent = events.pop();
    if (!oldestEvent) break;
    freedBytes += estimateEventSize(oldestEvent);
    removed++;
  }

  currentSizeBytes = Math.max(0, currentSizeBytes - freedBytes);

  if (removed > 0) {
    console.log(
      `[PostHog Debugger] Pruned ${removed} stored events, freed ${(freedBytes / 1024 / 1024).toFixed(2)} MiB`
    );
  }
}

function getStorage<T>(keys: string[] | string): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result as T);
    });
  });
}

function setStorage(data: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function persistEventsWithTrim(): Promise<void> {
  let attempts = 0;

  while (attempts < 6) {
    try {
      await setStorage({ [EVENTS_STORAGE_KEY]: events });
      return;
    } catch (error) {
      attempts += 1;
      if (events.length === 0) {
        console.error('[PostHog Debugger] Failed to persist empty event list:', error);
        return;
      }

      console.warn('[PostHog Debugger] Storage write failed, pruning more events and retrying:', error);
      cleanupOldEvents(Math.max(CLEANUP_SIZE_BYTES, Math.floor(currentSizeBytes * 0.25)));
    }
  }

  console.error('[PostHog Debugger] Failed to persist events after retries.');
}

async function ensureEventsLoaded(): Promise<void> {
  if (isLoaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const result = await getStorage<Record<string, unknown>>([EVENTS_STORAGE_KEY]);
    const storedEvents = result[EVENTS_STORAGE_KEY];
    events = Array.isArray(storedEvents) ? (storedEvents as PostHogEvent[]) : [];
    recomputeSize();

    if (currentSizeBytes > MAX_STORED_SIZE_BYTES) {
      cleanupOldEvents(currentSizeBytes - MAX_STORED_SIZE_BYTES + CLEANUP_SIZE_BYTES);
      await persistEventsWithTrim();
    }

    isLoaded = true;
  })();

  await loadPromise;
}

function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    try {
      const match = url.match(/https?:\/\/([^\/]+)/);
      return match ? match[1] : url;
    } catch {
      return url;
    }
  }
}

function decodePostHogEvent(rawData: Uint8Array) {
  try {
    const decompressed = pako.ungzip(rawData, { to: 'string' });
    return JSON.parse(decompressed);
  } catch (error) {
    console.error('Error decoding PostHog event:', error);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
  if (request.action === 'getEvents') {
    ensureEventsLoaded()
      .then(() => {
        sendResponse({ events } as GetEventsResponse);
      })
      .catch((error) => {
        console.error('[PostHog Debugger] Failed to load events:', error);
        sendResponse({ events: [] } as GetEventsResponse);
      });
    return true;
  }

  if (request.action === 'clearEvents') {
    ensureEventsLoaded()
      .then(async () => {
        events = [];
        currentSizeBytes = 0;
        await persistEventsWithTrim();
        sendResponse({ success: true } as ClearEventsResponse);
      })
      .catch((error) => {
        console.error('[PostHog Debugger] Failed to clear events:', error);
        sendResponse({ success: false } as ClearEventsResponse);
      });
    return true;
  }

  if (request.action === 'captureEvent') {
    ensureEventsLoaded()
      .then(async () => {
        try {
          const uint8Array = new Uint8Array(request.data);

          let decodedBatch = null;
          let error: string | undefined;

          try {
            decodedBatch = decodePostHogEvent(uint8Array);
          } catch (e) {
            error = e instanceof Error ? e.message : 'Unknown error';
            console.error('[PostHog Debugger] Decode error:', error);
          }

          if (decodedBatch && !error) {
            const eventsToAdd = Array.isArray(decodedBatch) ? decodedBatch : [decodedBatch];

            for (const decodedEvent of eventsToAdd) {
              const event: PostHogEvent = {
                id: `${Date.now()}-${Math.random()}`,
                timestamp: request.timestamp || new Date().toISOString(),
                url: request.url,
                domain: extractDomain(request.url),
                decoded: decodedEvent,
                error: undefined
              };

              currentSizeBytes += estimateEventSize(event);
              events.unshift(event);
            }
          } else if (error) {
            const event: PostHogEvent = {
              id: `${Date.now()}-${Math.random()}`,
              timestamp: request.timestamp || new Date().toISOString(),
              url: request.url,
              domain: extractDomain(request.url),
              rawData: request.data,
              decoded: null,
              error
            };

            currentSizeBytes += estimateEventSize(event);
            events.unshift(event);
          }

          if (currentSizeBytes > MAX_STORED_SIZE_BYTES) {
            cleanupOldEvents(currentSizeBytes - MAX_STORED_SIZE_BYTES + CLEANUP_SIZE_BYTES);
          }

          await persistEventsWithTrim();
        } catch (error) {
          console.error('[PostHog Debugger] Error processing event:', error);
        }

        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[PostHog Debugger] Failed while capturing event:', error);
        sendResponse({ success: true });
      });

    return true;
  }

  return false;
});
