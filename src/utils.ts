// Utility functions for formatting PostHog events

interface EventElement {
  tag_name?: string;
  text?: string;
  attributes?: Record<string, any>;
}

interface EventLike {
  event: string;
  properties?: Record<string, any>;
  elements?: EventElement[];
}

// $event_type to verb map
const eventTypeToVerb: Record<string, string> = {
  click: 'clicked',
  change: 'typed something into',
  submit: 'submitted',
  touch: 'touched a',
  value_changed: 'changed value in',
  toggle: 'toggled',
  menu_action: 'pressed menu',
  swipe: 'swiped',
  pinch: 'pinched',
  pan: 'panned',
  rotation: 'rotated',
  long_press: 'long pressed',
  scroll: 'scrolled in',
};

/**
 * Convert an autocapture event to a human-readable description
 */
export function autoCaptureEventToDescription(
  event: EventLike,
  shortForm: boolean = false
): string {
  if (event.event !== '$autocapture') {
    return event.event;
  }

  const getVerb = (): string => {
    const eventType = event.properties?.$event_type;
    return eventTypeToVerb[eventType] || 'interacted with';
  };

  const getTag = (): string => {
    const tagName = event.elements?.[0]?.tag_name;
    if (tagName === 'a') {
      return 'link';
    } else if (tagName === 'img') {
      return 'image';
    }
    return tagName ?? 'element';
  };

  const getValue = (): string | null => {
    if (event.properties?.$el_text) {
      return `${shortForm ? '' : 'with text '}"${event.properties.$el_text}"`;
    } else if (event.elements?.[0]?.text) {
      return `${shortForm ? '' : 'with text '}"${event.elements[0].text}"`;
    } else if (event.elements?.[0]?.attributes?.['attr__aria-label']) {
      return `${shortForm ? '' : 'with aria label '}"${event.elements[0].attributes['attr__aria-label']}"`;
    }
    return null;
  };

  if (shortForm) {
    return [getVerb(), getValue() ?? getTag()].filter((x) => x).join(' ');
  }

  const value = getValue();
  return [getVerb(), getTag(), value].filter((x) => x).join(' ');
}

/**
 * Convert any PostHog event to a human-readable description
 */
export function eventToDescription(
  event: EventLike,
  shortForm: boolean = false
): string {
  // Pageview and pageleave events
  if (['$pageview', '$pageleave'].includes(event.event)) {
    return event.properties?.$pathname ?? event.properties?.$current_url ?? '<unknown URL>';
  }

  // Autocapture events
  if (event.event === '$autocapture') {
    return autoCaptureEventToDescription(event, shortForm);
  }

  // All other events
  return event.event;
}

// Common PostHog internal events that can be filtered
export const FILTERABLE_EVENT_TYPES: Record<string, string> = {
  '$pageview': 'Page View',
  '$pageleave': 'Page Leave',
  '$autocapture': 'Auto Capture',
  '$identify': 'Identify',
  '$set': 'Set Properties',
  '$groupidentify': 'Group Identify',
  '$feature_flag_called': 'Feature Flag',
  '$exception': 'Exception',
  '$web_vitals': 'Web Vitals',
  '$performance_event': 'Performance',
  '$snapshot': 'Session Recording',
  '$rageclick': 'Rage Click',
  '$$heatmap': 'Heatmap',
};

/**
 * Get a friendly name for common PostHog internal events
 */
export function getEventDisplayName(eventName: string): string {
  return FILTERABLE_EVENT_TYPES[eventName] || eventName;
}

/**
 * Check if an event type can be filtered
 */
export function isFilterableEventType(eventName: string): boolean {
  return eventName in FILTERABLE_EVENT_TYPES;
}
