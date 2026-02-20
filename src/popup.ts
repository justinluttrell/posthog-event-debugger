import type { PostHogEvent } from './types';
import { EVENT_TYPE_CONFIG, FILTERABLE_EVENT_TYPES, getEventDisplayName, isFilterableEventType, eventToDescription } from './utils';

// State
const expandedEvents = new Set<string>();
const showInternalPropsForEvent = new Map<string, boolean>();
const expandedJsonValues = new Set<string>();
let filteredEventTypes = new Set<string>();
let searchQuery = '';
let selectedDomain: string | null = null; // null means "all domains"
let domainSelectionPinned = false;
let currentViewMode: ExtensionViewMode = 'popup';

const VIEW_MODE_STORAGE_KEY = 'extensionViewMode';
const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScrxH7CmncyQc3slDVRpg1yUcmGPuvsACA00T55cijxQTkC5w/viewform?usp=sharing&ouid=110187965051592055396';

type ExtensionViewMode = 'popup' | 'sidepanel';

const SIDE_PANEL_ICON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M14 4V20" stroke="currentColor" stroke-width="2"/>
</svg>
`;

const POPUP_ICON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M4 9H20" stroke="currentColor" stroke-width="2"/>
</svg>
`;

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

function normalizeViewMode(value: unknown): ExtensionViewMode {
  return value === 'sidepanel' ? 'sidepanel' : 'popup';
}

async function saveViewModeLocally(viewMode: ExtensionViewMode): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [VIEW_MODE_STORAGE_KEY]: viewMode }, () => {
      resolve();
    });
  });
}

async function loadViewMode(): Promise<ExtensionViewMode> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VIEW_MODE_STORAGE_KEY], (result) => {
      resolve(normalizeViewMode(result[VIEW_MODE_STORAGE_KEY]));
    });
  });
}

async function setViewMode(viewMode: ExtensionViewMode): Promise<void> {
  await saveViewModeLocally(viewMode);
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ action: 'setViewMode', viewMode }, () => {
      resolve();
    });
  });
  currentViewMode = viewMode;
  applyViewModeLayout();
  renderModeToggleButton();
}

function applyViewModeLayout(): void {
  const body = document.body;
  if (!body) return;

  body.classList.remove('mode-popup', 'mode-sidepanel');
  body.classList.add(currentViewMode === 'sidepanel' ? 'mode-sidepanel' : 'mode-popup');
}

function renderModeToggleButton(): void {
  const modeToggleBtn = document.getElementById('modeToggleBtn') as HTMLButtonElement | null;
  const modeToggleIcon = document.getElementById('modeToggleIcon');
  if (!modeToggleBtn || !modeToggleIcon) return;

  const isSidePanelMode = currentViewMode === 'sidepanel';
  modeToggleBtn.title = isSidePanelMode ? 'Switch to popup mode' : 'Open in side panel';
  modeToggleBtn.setAttribute('aria-label', modeToggleBtn.title);
  modeToggleIcon.innerHTML = isSidePanelMode ? POPUP_ICON : SIDE_PANEL_ICON;
}

async function getCurrentWindowId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    return tab?.windowId ?? null;
  } catch {
    return null;
  }
}

async function openSidePanelForCurrentWindow(): Promise<void> {
  const windowId = await getCurrentWindowId();
  if (windowId == null) {
    throw new Error('No active window found to open side panel.');
  }

  await chrome.sidePanel.open({ windowId });
}

async function openPopupForCurrentWindow(): Promise<void> {
  const windowId = await getCurrentWindowId();
  if (windowId == null) {
    await chrome.action.openPopup();
    return;
  }

  await chrome.action.openPopup({ windowId });
}

async function switchToPopupModeAndOpen(): Promise<void> {
  const windowId = await getCurrentWindowId();

  await new Promise<void>((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'switchToPopupAndOpen', windowId }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.success) {
        reject(new Error('Background failed to switch to popup mode.'));
        return;
      }

      resolve();
    });
  });

  currentViewMode = 'popup';
  applyViewModeLayout();
  renderModeToggleButton();
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

interface ActiveTabCaptureStatus {
  tabId: number | null;
  domain: string | null;
  isHttpPage: boolean;
  contentScriptLoaded: boolean;
}

async function isContentScriptLoaded(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'pingContentScript' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response?.loaded));
      });
    } catch {
      resolve(false);
    }
  });
}

async function getActiveTabCaptureStatus(): Promise<ActiveTabCaptureStatus> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) {
      return { tabId: null, domain: null, isHttpPage: false, contentScriptLoaded: false };
    }

    let domain: string | null = null;
    let isHttpPage = false;
    if (tab.url) {
      try {
        const urlObj = new URL(tab.url);
        domain = urlObj.hostname || null;
        isHttpPage = urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
      } catch {
        domain = null;
      }
    }

    const contentScriptLoaded = isHttpPage ? await isContentScriptLoaded(tab.id) : false;
    return { tabId: tab.id, domain, isHttpPage, contentScriptLoaded };
  } catch {
    return { tabId: null, domain: null, isHttpPage: false, contentScriptLoaded: false };
  }
}

async function renderDomainTabs(domains: string[], allEvents: PostHogEvent[], currentDomain: string | null): Promise<void> {
  const domainTabs = document.getElementById('domainTabs');
  if (!domainTabs) return;

  const displayDomains = [...domains];
  if (currentDomain && !displayDomains.includes(currentDomain)) {
    displayDomains.push(currentDomain);
    displayDomains.sort();
  }
  
  // Show tabs for multiple domains, or when current tab has no captured events yet.
  if (displayDomains.length <= 1 && !(currentDomain && allEvents.length === 0)) {
    domainTabs.style.display = 'none';
    if (!domainSelectionPinned) {
      selectedDomain = currentDomain;
    }
    return;
  }

  domainTabs.style.display = 'flex';

  if (!domainSelectionPinned) {
    if (currentDomain) {
      selectedDomain = currentDomain;
    } else if (displayDomains.length === 1) {
      selectedDomain = displayDomains[0];
    } else {
      selectedDomain = null;
    }
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
    ${displayDomains
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
      if (domain === 'all') {
        selectedDomain = null;
        domainSelectionPinned = false;
      } else {
        selectedDomain = domain;
        domainSelectionPinned = true;
      }

      // Re-render events and settings (if settings view is open)
      await renderEvents();
      const settingsView = document.getElementById('settingsView');
      if (settingsView && settingsView.style.display !== 'none') {
        await renderSettings();
      }
    });
  });
}

type ScrollMode = 'adjust' | 'keep';

interface EmptyStateData {
  title: string;
  hint: string;
  showRefreshPrompt: boolean;
}

function filterEventsForDisplay(allEvents: PostHogEvent[]): PostHogEvent[] {
  return allEvents.filter((event) => {
    if (selectedDomain !== null && event.domain !== selectedDomain) {
      return false;
    }

    if (event.decoded) {
      const eventName = event.decoded.event || 'Unknown Event';
      if (isFilterableEventType(eventName) && filteredEventTypes.has(eventName)) {
        return false;
      }
    }

    if (!matchesSearch(event, searchQuery)) {
      return false;
    }

    return true;
  });
}

function getDomainScopedEvents(allEvents: PostHogEvent[]): PostHogEvent[] {
  return allEvents.filter((event) => selectedDomain === null || event.domain === selectedDomain);
}

function buildEmptyState(
  allEvents: PostHogEvent[],
  domainScopedEvents: PostHogEvent[],
  activeTabStatus: ActiveTabCaptureStatus
): EmptyStateData {
  const hasEvents = allEvents.length > 0;
  const hasEventsInSelectedDomain = domainScopedEvents.length > 0;
  const hasSearch = searchQuery.length > 0;
  const isActiveDomainSelected = selectedDomain === null || selectedDomain === activeTabStatus.domain;

  const showRefreshPrompt =
    !hasSearch &&
    !hasEventsInSelectedDomain &&
    isActiveDomainSelected &&
    activeTabStatus.isHttpPage &&
    !activeTabStatus.contentScriptLoaded;
  const isUnsupportedPage =
    !hasSearch &&
    !hasEventsInSelectedDomain &&
    isActiveDomainSelected &&
    !activeTabStatus.isHttpPage;

  let title = 'No events captured yet';
  let hint = 'Events will appear here when captured.';

  if (hasSearch) {
    title = 'No events match your search';
    hint = 'Try a different search term.';
  } else if (hasEventsInSelectedDomain) {
    title = 'All events are filtered out';
    hint = 'Adjust filters in settings to see events.';
  } else if (isUnsupportedPage) {
    title = 'Events cannot be tracked on this page';
    hint = 'Open a regular http(s) page to capture PostHog events.';
  } else if (showRefreshPrompt) {
    title = `Refresh to view captured events for ${activeTabStatus.domain || 'this tab'}`;
    hint = 'This page loaded before the extension started tracking events.';
  } else if (hasEvents) {
    title = 'No events captured for this domain';
    hint = isActiveDomainSelected
      ? 'No PostHog events seen on this page yet. Verify PostHog is installed and trigger an event.'
      : 'Switch domains to view captured events from other pages.';
  }

  return { title, hint, showRefreshPrompt };
}

function restoreEventsListScroll(
  eventsList: HTMLElement,
  scrollMode: ScrollMode,
  prevScrollTop: number,
  prevScrollHeight: number
): void {
  const preserveScroll = prevScrollTop > 0;
  const shouldAdjustScroll = scrollMode === 'adjust' && preserveScroll;

  if (shouldAdjustScroll) {
    const newScrollHeight = eventsList.scrollHeight;
    eventsList.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    return;
  }

  if (scrollMode === 'keep') {
    eventsList.scrollTop = prevScrollTop;
  }
}

function bindEventListHandlers(eventsList: HTMLElement): void {
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

async function renderEvents(scrollMode: ScrollMode = 'adjust'): Promise<void> {
  const eventsList = document.getElementById('eventsList');
  if (!eventsList) return;
  
  const prevScrollTop = eventsList.scrollTop;
  const prevScrollHeight = eventsList.scrollHeight;
  
  const allEvents = await getEvents();
  const activeTabStatus = await getActiveTabCaptureStatus();
  
  // Get unique domains and render tabs
  const domains = getUniqueDomains(allEvents);
  await renderDomainTabs(domains, allEvents, activeTabStatus.domain);
  
  const events = filterEventsForDisplay(allEvents);
  const domainScopedEvents = getDomainScopedEvents(allEvents);
  
  if (events.length === 0) {
    const emptyState = buildEmptyState(allEvents, domainScopedEvents, activeTabStatus);
    eventsList.innerHTML = `
      <div class="empty-state">
        <p>${emptyState.title}</p>
        <p class="hint">${emptyState.hint}</p>
        ${emptyState.showRefreshPrompt ? '<button id="refreshTabBtn" class="refresh-tab-btn">Refresh Tab</button>' : ''}
      </div>
    `;

    const refreshTabBtn = document.getElementById('refreshTabBtn');
    refreshTabBtn?.addEventListener('click', () => {
      if (activeTabStatus.tabId != null) {
        chrome.tabs.reload(activeTabStatus.tabId);
      }
    });

    restoreEventsListScroll(eventsList, scrollMode, prevScrollTop, prevScrollHeight);
    return;
  }
  
  eventsList.innerHTML = events.map(renderEvent).join('');
  restoreEventsListScroll(eventsList, scrollMode, prevScrollTop, prevScrollHeight);
  bindEventListHandlers(eventsList);
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
  currentViewMode = await loadViewMode();
  applyViewModeLayout();
  renderModeToggleButton();

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
    domainSelectionPinned = false;
    await renderEvents();
  });
  
  const configBtn = document.getElementById('configBtn');
  configBtn?.addEventListener('click', () => {
    showSettings();
  });

  const modeToggleBtn = document.getElementById('modeToggleBtn');
  modeToggleBtn?.addEventListener('click', async () => {
    if (currentViewMode === 'popup') {
      await setViewMode('sidepanel');
      try {
        await openSidePanelForCurrentWindow();
      } catch (error) {
        console.error('[PostHog Debugger] Failed to open side panel:', error);
      }
      window.close();
      return;
    }

    try {
      await switchToPopupModeAndOpen();
    } catch (error) {
      console.error('[PostHog Debugger] Failed to switch to popup mode:', error);
      try {
        await openPopupForCurrentWindow();
      } catch (openError) {
        console.error('[PostHog Debugger] Failed to open popup:', openError);
      }
      await setViewMode('popup');
    }
  });
  
  const backBtn = document.getElementById('backBtn');
  backBtn?.addEventListener('click', () => {
    showMain();
  });

  const feedbackBtn = document.getElementById('feedbackBtn');
  feedbackBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: FEEDBACK_FORM_URL });
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
