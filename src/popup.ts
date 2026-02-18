import type { PostHogEvent } from './types';
import { EVENT_TYPE_CONFIG, FILTERABLE_EVENT_TYPES, getEventDisplayName, isFilterableEventType, eventToDescription } from './utils';

// State
const expandedEvents = new Set<string>();
const showInternalPropsForEvent = new Map<string, boolean>();
const expandedJsonValues = new Set<string>();
let filteredEventTypes = new Set<string>();
let searchQuery = '';
let selectedDomain: string | null = null; // null means "all domains"
let domainAutoSelected = false; // Track if we've auto-selected a domain on initial load

// Storage functions
async function loadFilteredEventTypes(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['filteredEventTypes'], (result) => {
      if (result.filteredEventTypes) {
        filteredEventTypes = new Set(result.filteredEventTypes);
      }
      resolve();
    });
  });
}

async function saveFilteredEventTypes(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ filteredEventTypes: Array.from(filteredEventTypes) }, () => {
      resolve();
    });
  });
}

async function getEvents(): Promise<PostHogEvent[]> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getEvents' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(response?.events || []);
      });
    } catch {
      resolve([]);
    }
  });
}

async function clearEvents(): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'clearEvents' }, () => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

// Utility functions
function filterProperties(
  properties: Record<string, any>,
  eventId: string,
  eventName: string
): Record<string, any> {
  const showInternal = showInternalPropsForEvent.get(eventId) || false;
  if (showInternal) {
    return properties;
  }
  const alwaysShow = EVENT_TYPE_CONFIG[eventName]?.alwaysShowProperties ?? [];
  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!key.startsWith('$') || alwaysShow.includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function getValueClass(value: any): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValue(value: any): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderPropertyValueHtml(value: any, eventId: string, propertyKey: string): string {
  const valueClass = getValueClass(value);
  if (value && typeof value === 'object') {
    const expansionKey = `${eventId}::${propertyKey}`;
    const isExpanded = expandedJsonValues.has(expansionKey);
    const collapsed = JSON.stringify(value);
    const expanded = JSON.stringify(value, null, 2);
    return `
      <div
        class="property-value ${valueClass} json-toggle ${isExpanded ? 'expanded' : ''}"
        data-expansion-key="${escapeHtml(expansionKey)}"
        data-collapsed="${escapeHtml(collapsed)}"
        data-full="${escapeHtml(expanded)}"
      >${escapeHtml(isExpanded ? expanded : collapsed)}</div>
    `;
  }
  return `<div class="property-value ${valueClass}">${escapeHtml(formatValue(value))}</div>`;
}

function renderEvent(event: PostHogEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  
  if (event.error) {
    return `
      <div class="event-item">
        <div class="event-header">
          <div class="event-info">
            <div class="event-name">❌ Error</div>
            <div class="event-time">${time}</div>
          </div>
        </div>
        <div class="event-details" style="display: block;">
          <div class="error-message">${event.error}</div>
        </div>
      </div>
    `;
  }
  
  if (!event.decoded) {
    return `
      <div class="event-item">
        <div class="event-header">
          <div class="event-info">
            <div class="event-name">⚠️ Unable to decode</div>
            <div class="event-time">${time}</div>
          </div>
        </div>
      </div>
    `;
  }
  
  const decoded = event.decoded;
  const eventName = decoded.event || 'Unknown Event';
  const displayName = getEventDisplayName(eventName);
  const description = eventToDescription(decoded, true);
  const properties = decoded.properties || {};
  const filteredProps = filterProperties(properties, event.id, eventName);
  const hasProps = Object.keys(filteredProps).length > 0;
  const showInternal = showInternalPropsForEvent.get(event.id) ?? false;
  const isExpanded = expandedEvents.has(event.id);
  const showDescription = description !== displayName && description !== eventName;
  
  const propertiesHtml = hasProps
    ? Object.entries(filteredProps)
        .map(
          ([key, value]) => `
      <div class="property-row">
        <div class="property-key">${key}</div>
        ${renderPropertyValueHtml(value, event.id, key)}
      </div>
    `
        )
        .join('')
    : '<div class="property-row"><div class="property-key">No custom properties</div></div>';
  
  return `
    <div class="event-item ${isExpanded ? 'expanded' : ''}" data-event-id="${event.id}">
      <div class="event-header">
        <div class="event-info">
          <div class="event-name">${displayName}</div>
          ${showDescription ? `<div class="event-description">${description}</div>` : ''}
          <div class="event-time">${time}</div>
        </div>
        <div class="expand-icon">›</div>
      </div>
      <div class="event-details">
        <div class="properties-section">
          <div class="section-header">
            <div class="section-title">Properties</div>
            <label class="internal-props-toggle">
              <input type="checkbox" class="show-internal-props" ${showInternal ? 'checked' : ''}>
              <span>Show PostHog Properties</span>
            </label>
          </div>
          ${propertiesHtml}
        </div>
      </div>
    </div>
  `;
}

function matchesSearch(event: PostHogEvent, query: string): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  
  if (event.decoded) {
    const eventName = event.decoded.event || '';
    if (eventName.toLowerCase().includes(lowerQuery)) return true;
    
    const properties = event.decoded.properties || {};
    for (const [key, value] of Object.entries(properties)) {
      if (key.startsWith('$')) continue;
      if (key.toLowerCase().includes(lowerQuery)) return true;
      const valueStr = String(value).toLowerCase();
      if (valueStr.includes(lowerQuery)) return true;
    }
  }
  
  return false;
}

function getUniqueDomains(events: PostHogEvent[]): string[] {
  const domains = new Set<string>();
  events.forEach((event) => {
    if (event.domain) {
      domains.add(event.domain);
    }
  });
  return Array.from(domains).sort();
}

async function renderDomainTabs(domains: string[], allEvents: PostHogEvent[]): Promise<void> {
  const domainTabs = document.getElementById('domainTabs');
  if (!domainTabs) return;
  
  // Only show tabs if there are multiple domains
  if (domains.length <= 1) {
    domainTabs.style.display = 'none';
    selectedDomain = null; // Reset to show all when only one domain
    return;
  }
  
  domainTabs.style.display = 'flex';
  
  // Only auto-select if we haven't done it yet and no domain is explicitly selected
  // This prevents re-selecting when user clicks "All"
  if (!domainAutoSelected && selectedDomain === null && domains.length > 0) {
    // Try to get current tab's domain and select it, otherwise select first domain
    const currentDomain = await getCurrentTabDomain();
    if (currentDomain && domains.includes(currentDomain)) {
      selectedDomain = currentDomain;
    } else if (domains.length > 0) {
      selectedDomain = domains[0];
    }
    domainAutoSelected = true;
  }
  
  // Count events per domain
  const domainCounts = new Map<string, number>();
  allEvents.forEach((event) => {
    if (event.domain) {
      domainCounts.set(event.domain, (domainCounts.get(event.domain) || 0) + 1);
    }
  });
  
  domainTabs.innerHTML = `
    <button class="domain-tab ${selectedDomain === null ? 'active' : ''}" data-domain="all">
      All (${allEvents.length})
    </button>
    ${domains
      .map(
        (domain) => `
      <button class="domain-tab ${selectedDomain === domain ? 'active' : ''}" data-domain="${domain}">
        ${domain} (${domainCounts.get(domain) || 0})
      </button>
    `
      )
      .join('')}
  `;
  
  // Add click handlers
  domainTabs.querySelectorAll('.domain-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      const domain = tab.getAttribute('data-domain');
      selectedDomain = domain === 'all' ? null : domain;
      domainAutoSelected = true; // Mark as explicitly selected by user
      
      // Re-render events and settings (if settings view is open)
      await renderEvents();
      const settingsView = document.getElementById('settingsView');
      if (settingsView && settingsView.style.display !== 'none') {
        await renderSettings();
      }
    });
  });
}

// Get the current active tab's domain
async function getCurrentTabDomain(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      try {
        const urlObj = new URL(tabs[0].url);
        return urlObj.hostname;
      } catch {
        return null;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

type ScrollMode = 'adjust' | 'keep';

async function renderEvents(scrollMode: ScrollMode = 'adjust'): Promise<void> {
  const eventsList = document.getElementById('eventsList');
  if (!eventsList) return;
  
  const prevScrollTop = eventsList.scrollTop;
  const prevScrollHeight = eventsList.scrollHeight;
  const preserveScroll = prevScrollTop > 0;
  const shouldAdjustScroll = scrollMode === 'adjust' && preserveScroll;
  
  const allEvents = await getEvents();
  
  // Get unique domains and render tabs
  const domains = getUniqueDomains(allEvents);
  await renderDomainTabs(domains, allEvents);
  
  // Filter events by domain, event type, and search
  const events = allEvents.filter((event) => {
    // Filter by domain
    if (selectedDomain !== null && event.domain !== selectedDomain) {
      return false;
    }
    
    // Filter by event type
    if (event.decoded) {
      const eventName = event.decoded.event || 'Unknown Event';
      if (isFilterableEventType(eventName) && filteredEventTypes.has(eventName)) {
        return false;
      }
    }
    
    // Filter by search
    if (!matchesSearch(event, searchQuery)) {
      return false;
    }
    
    return true;
  });
  
  if (events.length === 0) {
    const hasEvents = allEvents.length > 0;
    const hasSearch = searchQuery.length > 0;
    eventsList.innerHTML = `
      <div class="empty-state">
        <p>${hasSearch ? 'No events match your search' : hasEvents ? 'All events are filtered out' : 'No events captured yet'}</p>
        <p class="hint">${hasSearch ? 'Try a different search term' : hasEvents ? 'Adjust filters in settings to see events' : 'Events will appear here when PostHog sends data'}</p>
      </div>
    `;
    if (shouldAdjustScroll) {
      const newScrollHeight = eventsList.scrollHeight;
      eventsList.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    } else if (scrollMode === 'keep') {
      eventsList.scrollTop = prevScrollTop;
    }
    return;
  }
  
  eventsList.innerHTML = events.map(renderEvent).join('');
  
  if (shouldAdjustScroll) {
    const newScrollHeight = eventsList.scrollHeight;
    eventsList.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
  } else if (scrollMode === 'keep') {
    eventsList.scrollTop = prevScrollTop;
  }
  
  eventsList.querySelectorAll('.event-header').forEach((header) => {
    header.addEventListener('click', () => {
      const eventItem = header.closest('.event-item');
      const eventId = eventItem?.getAttribute('data-event-id');
      if (eventId) {
        if (expandedEvents.has(eventId)) {
          expandedEvents.delete(eventId);
        } else {
          expandedEvents.add(eventId);
        }
        eventItem?.classList.toggle('expanded');
      }
    });
  });
  
  eventsList.querySelectorAll('.show-internal-props').forEach((checkbox) => {
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const eventItem = target.closest('.event-item');
      const eventId = eventItem?.getAttribute('data-event-id');
      if (eventId) {
        const isChecked = target.checked;
        showInternalPropsForEvent.set(eventId, isChecked);
        await renderEvents('keep');
      }
    });
  });

  eventsList.querySelectorAll('.property-value.json-toggle').forEach((valueEl) => {
    valueEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      const expansionKey = target.dataset.expansionKey ?? '';
      const isExpanded = target.classList.toggle('expanded');
      const expanded = target.dataset.full ?? '';
      const collapsed = target.dataset.collapsed ?? '';
      target.textContent = isExpanded ? expanded : collapsed;
      if (expansionKey) {
        if (isExpanded) {
          expandedJsonValues.add(expansionKey);
        } else {
          expandedJsonValues.delete(expansionKey);
        }
      }
    });
  });
}

function showSettings(): void {
  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  if (mainView) mainView.style.display = 'none';
  if (settingsView) settingsView.style.display = 'flex';
  renderSettings();
}

function showMain(): void {
  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  if (mainView) mainView.style.display = 'flex';
  if (settingsView) settingsView.style.display = 'none';
}

async function renderSettings(): Promise<void> {
  const filterList = document.getElementById('eventTypeFilters');
  if (!filterList) return;

  const allEvents = await getEvents();
  
  // Filter by selected domain if one is selected
  const eventsToCount = selectedDomain === null 
    ? allEvents 
    : allEvents.filter((event) => event.domain === selectedDomain);
  
  const eventTypeCounts = new Map<string, number>();
  
  eventsToCount.forEach((event) => {
    if (event.decoded) {
      const eventName = event.decoded.event || 'Unknown Event';
      if (isFilterableEventType(eventName)) {
        eventTypeCounts.set(eventName, (eventTypeCounts.get(eventName) || 0) + 1);
      }
    }
  });
  
  const filterableTypes = Object.entries(FILTERABLE_EVENT_TYPES).map(([eventName, displayName]) => {
    const count = eventTypeCounts.get(eventName) || 0;
    const isFiltered = filteredEventTypes.has(eventName);
    return { eventName, displayName, count, isFiltered };
  });
  
  filterableTypes.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.displayName.localeCompare(b.displayName);
  });
  
  filterList.innerHTML = filterableTypes
    .map(
      ({ eventName, displayName, count, isFiltered }) => `
      <div class="event-filter-item">
        <label>
          <input type="checkbox" class="event-type-checkbox" data-event-type="${eventName}" ${isFiltered ? '' : 'checked'}>
          <span>${displayName}</span>
        </label>
        <span class="event-count">${count}</span>
      </div>
    `
    )
    .join('');
  
  filterList.querySelectorAll('.event-type-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const eventType = target.getAttribute('data-event-type');
      const isChecked = target.checked;
      if (eventType) {
        if (isChecked) {
          filteredEventTypes.delete(eventType);
        } else {
          filteredEventTypes.add(eventType);
        }
        await saveFilteredEventTypes();
        await renderEvents();
      }
    });
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadFilteredEventTypes();
  await renderEvents();
  
  const searchInput = document.getElementById('searchInput') as HTMLInputElement;
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  
  searchInput?.addEventListener('input', async (e) => {
    const target = e.target as HTMLInputElement;
    searchQuery = target.value;
    clearSearchBtn?.classList.toggle('visible', searchQuery.length > 0);
    await renderEvents();
  });
  
  clearSearchBtn?.addEventListener('click', async () => {
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    clearSearchBtn.classList.remove('visible');
    await renderEvents();
  });
  
  const clearBtn = document.getElementById('clearBtn');
  clearBtn?.addEventListener('click', async () => {
    await clearEvents();
    expandedEvents.clear();
    showInternalPropsForEvent.clear();
    selectedDomain = null; // Reset domain selection
    await renderEvents();
  });
  
  const configBtn = document.getElementById('configBtn');
  configBtn?.addEventListener('click', () => {
    showSettings();
  });
  
  const backBtn = document.getElementById('backBtn');
  backBtn?.addEventListener('click', () => {
    showMain();
  });

  const selectAllBtn = document.getElementById('selectAllBtn');
  selectAllBtn?.addEventListener('click', async () => {
    filteredEventTypes.clear();
    await saveFilteredEventTypes();
    await renderSettings();
    await renderEvents();
  });
  
  const deselectAllBtn = document.getElementById('deselectAllBtn');
  deselectAllBtn?.addEventListener('click', async () => {
    Object.keys(FILTERABLE_EVENT_TYPES).forEach((eventName) => {
      filteredEventTypes.add(eventName);
    });
    await saveFilteredEventTypes();
    await renderSettings();
    await renderEvents();
  });
  
  setInterval(renderEvents, 2000);
});
