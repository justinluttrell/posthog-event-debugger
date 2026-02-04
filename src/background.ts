import type { PostHogEvent, GetEventsResponse, ClearEventsResponse } from './types';
import * as pako from 'pako';

// Store captured events with smart memory management
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MiB
const CLEANUP_SIZE_BYTES = 10 * 1024 * 1024; // Remove 10 MiB when limit hit
let events: PostHogEvent[] = [];
let currentSizeBytes = 0;

// Estimate size of an event in bytes
function estimateEventSize(event: PostHogEvent): number {
  // Rough estimate: JSON.stringify size + rawData array size (if present)
  const jsonSize = JSON.stringify(event.decoded).length * 2; // UTF-16 chars = 2 bytes each
  const rawDataSize = event.rawData ? event.rawData.length : 0;
  return jsonSize + rawDataSize;
}

// Remove oldest events until we've freed up the target amount
function cleanupOldEvents(bytesToFree: number): void {
  let freedBytes = 0;
  let eventsRemoved = 0;

  while (freedBytes < bytesToFree && events.length > 0) {
    const oldestEvent = events.pop(); // Remove from end (oldest)
    if (oldestEvent) {
      freedBytes += estimateEventSize(oldestEvent);
      eventsRemoved++;
    }
  }

  currentSizeBytes -= freedBytes;
  console.log(`[PostHog Debugger] Cleaned up ${eventsRemoved} events, freed ${(freedBytes / 1024 / 1024).toFixed(2)} MiB`);
}

// Extract domain from URL
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    // Fallback if URL parsing fails
    try {
      const match = url.match(/https?:\/\/([^\/]+)/);
      return match ? match[1] : url;
    } catch {
      return url;
    }
  }
}

// Decode gzip-compressed PostHog event
function decodePostHogEvent(rawData: Uint8Array) {
  try {
    // Decompress using pako
    const decompressed = pako.ungzip(rawData, { to: 'string' });

    // Parse JSON
    return JSON.parse(decompressed);
  } catch (error) {
    console.error('Error decoding PostHog event:', error);
    throw error;
  }
}

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
  if (request.action === 'getEvents') {
    sendResponse({ events } as GetEventsResponse);
  } else if (request.action === 'clearEvents') {
    events = [];
    currentSizeBytes = 0;
    sendResponse({ success: true } as ClearEventsResponse);
  } else if (request.action === 'captureEvent') {
    try {
      const uint8Array = new Uint8Array(request.data);

      let decodedBatch = null;
      let error = undefined;

      try {
        decodedBatch = decodePostHogEvent(uint8Array);
      } catch (e) {
        error = e instanceof Error ? e.message : 'Unknown error';
        console.error('[PostHog Debugger] Decode error:', error);
      }

      // PostHog sends events as an array (or sometimes a single object)
      if (decodedBatch && !error) {
        const eventsToAdd = Array.isArray(decodedBatch) ? decodedBatch : [decodedBatch];

        for (const decodedEvent of eventsToAdd) {
          const event: PostHogEvent = {
            id: `${Date.now()}-${Math.random()}`,
            timestamp: request.timestamp || new Date().toISOString(),
            url: request.url,
            domain: extractDomain(request.url),
            // Don't store rawData - it's huge and we already decoded it
            decoded: decodedEvent,
            error: undefined
          };

          const eventSize = estimateEventSize(event);
          currentSizeBytes += eventSize;
          events.unshift(event);

          // Check if we need to cleanup old events
          if (currentSizeBytes > MAX_SIZE_BYTES) {
            cleanupOldEvents(CLEANUP_SIZE_BYTES);
          }
        }
      } else if (error) {
        // If decoding failed, store rawData for debugging
        const event: PostHogEvent = {
          id: `${Date.now()}-${Math.random()}`,
          timestamp: request.timestamp || new Date().toISOString(),
          url: request.url,
          domain: extractDomain(request.url),
          rawData: request.data,
          decoded: null,
          error
        };

        const eventSize = estimateEventSize(event);
        currentSizeBytes += eventSize;
        events.unshift(event);

        // Check if we need to cleanup old events
        if (currentSizeBytes > MAX_SIZE_BYTES) {
          cleanupOldEvents(CLEANUP_SIZE_BYTES);
        }
      }

    } catch (error) {
      console.error('[PostHog Debugger] Error processing event:', error);
    }

    sendResponse({ success: true });
  }
  return true;
});
