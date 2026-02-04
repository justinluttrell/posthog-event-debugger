export interface PostHogEvent {
  id: string;
  timestamp: string;
  url: string;
  domain: string; // Domain extracted from URL
  rawData?: number[]; // Optional - removed after decoding to save memory
  decoded: DecodedEvent | null;
  error?: string;
}

export interface DecodedEvent {
  uuid?: string;
  event: string;
  properties: Record<string, any>;
  timestamp?: string;
}

export interface MessageGetEvents {
  action: 'getEvents';
}

export interface MessageClearEvents {
  action: 'clearEvents';
}

export type Message = MessageGetEvents | MessageClearEvents;

export interface GetEventsResponse {
  events: PostHogEvent[];
}

export interface ClearEventsResponse {
  success: boolean;
}
