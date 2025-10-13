const DEFAULT_API_BASE = 'http://localhost:8001';
const CHAT_KEY = 'history_chat_mem';
const HISTORY_KEY = 'historyData';
const LAST_SYNC_KEY = 'lastUpdate';
const SETTINGS_KEY = 'history_chat_settings';
const USER_ID_KEY = 'historyExtensionUserId';
const DEFAULT_TOP_K = 20;

const log = document.getElementById('log');
const qform = document.getElementById('qform');
const q = document.getElementById('q');
const askBtn = document.getElementById('askBtn');
const statusText = document.getElementById('statusText');
const lastSync = document.getElementById('lastSync');
const syncBtn = document.getElementById('syncBtn');
const settingsBtn = document.getElementById('settingsBtn');
const themeBtn = document.getElementById('themeBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const suggestions = document.getElementById('suggestions');
const overlay = document.getElementById('overlay');

const settingsDialog = document.getElementById('settingsDialog');
const apiBaseInput = document.getElementById('apiBaseInput');
const daysInput = document.getElementById('daysInput');
const maxInput = document.getElementById('maxInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

const clearChatDialog = document.getElementById('clearChatDialog');
const confirmClearBtn = document.getElementById('confirmClearBtn');

const toasts = document.getElementById('toasts');

let memory = [];
let isSyncing = false;
let settings = { 
  apiBase: DEFAULT_API_BASE, 
  days: 14,
  max: 3000,
  topK: DEFAULT_TOP_K
};
let userId = null;

init();

async function init() {
  await loadSettings();
  await ensureUserId();
  applyThemeFromStorage();
  await loadChatMemory();
  renderWelcomeIfEmpty();
  updateStatus('Ready');
  hydrateLastSync();
  autoGrowTextarea(q);

  try { await fullSync({ silentIfCached: true }); } catch {}

  qform.addEventListener('submit', onSend);
  q.addEventListener('keydown', onTextareaKey);
  syncBtn.addEventListener('click', () => fullSync());
  settingsBtn.addEventListener('click', openSettings);
  saveSettingsBtn.addEventListener('click', saveSettings);
  themeBtn.addEventListener('click', toggleTheme);
  clearChatBtn.addEventListener('click', openClearChatDialog);
  confirmClearBtn.addEventListener('click', clearChat);

  suggestions.addEventListener('click', e => {
    if (e.target.classList.contains('chip')) {
      q.value = e.target.textContent;
      q.focus();
    }
  });
}

async function ensureUserId() {
  const result = await chrome.storage.local.get([USER_ID_KEY]);
  
  if (result[USER_ID_KEY]) {
    userId = result[USER_ID_KEY];
  } else {
    userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await chrome.storage.local.set({ [USER_ID_KEY]: userId });
  }
}

function getUserId() {
  return userId;
}

function updateStatus(text) { 
  statusText.textContent = text; 
}

async function hydrateLastSync() {
  const { [LAST_SYNC_KEY]: ts } = await chrome.storage.local.get([LAST_SYNC_KEY]);
  if (ts) lastSync.textContent = formatAgo(new Date(ts));
}

function formatAgo(date) {
  const now = new Date();
  const diff = Math.floor((now - date) / 60000);
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
  return date.toLocaleDateString();
}

function autoGrowTextarea(el) {
  const resize = () => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };
  el.addEventListener('input', resize);
  resize();
}

function toast(msg, type='success', timeout=2600) {
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  toasts.appendChild(d);
  setTimeout(() => d.remove(), timeout);
}

function setSyncing(on) {
  isSyncing = on;
  if (on) {
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    disableInputs(true);
  } else {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    disableInputs(false);
  }
}

function disableInputs(disabled) {
  q.disabled = disabled;
  askBtn.disabled = disabled;
  syncBtn.disabled = disabled;
  settingsBtn.disabled = disabled;
  clearChatBtn.disabled = disabled;
}

function renderWelcomeIfEmpty() {
  if (memory.length === 0) {
    append('bot', `Hi! I can answer questions about your browsing history.

Try asking:
- What did I search for yesterday?
- Show me articles about AI from last week
- What music did I listen to on Monday?`);
  } else {
    memory.forEach(m => append(m.who, m.text, m.sources, m.ts));
  }
}

function append(who, text, sources = [], ts = Date.now()) {
  const row = document.createElement('div');
  row.className = `msg ${who}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerText = text;
  row.appendChild(bubble);

  if (who === 'bot') {
    const tools = document.createElement('div');
    tools.className = 'bubble-tools';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    });
    tools.appendChild(copyBtn);
    bubble.appendChild(tools);
  }

  if (sources.length) {
    const cites = document.createElement('div');
    cites.className = 'cites';
    cites.innerHTML = sources.map((s, i) =>
      `[#${i+1}] <a href="${s.url}" target="_blank">${escapeHtml(s.title || s.url)}</a> ${s.meta ? '— ' + escapeHtml(s.meta) : ''}`
    ).join('<br/>');
    bubble.appendChild(document.createElement('hr'));
    bubble.appendChild(cites);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  bubble.appendChild(meta);

  log.appendChild(row);
  log.scrollTop = log.scrollHeight;

  memory.push({ who, text, sources, ts });
  saveChatMemory();
  return row;
}

function appendTyping() {
  const row = document.createElement('div');
  row.className = 'msg bot';
  row.innerHTML = `<div class="bubble">
    <div class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Thinking…</div>
  </div>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

function escapeHtml(s='') { 
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); 
}

function openClearChatDialog() {
  clearChatDialog.showModal();
}

async function clearChat(e) {
  if (e && e.target.value !== 'confirm') return;
  
  memory = [];
  await chrome.storage.local.remove([CHAT_KEY]);
  
  log.innerHTML = '';
  
  renderWelcomeIfEmpty();
  
  toast('Chat cleared successfully');
}

async function onSend(e) {
  e.preventDefault();
  if (isSyncing) return;
  const text = q.value.trim();
  if (!text) return;

  append('user', text);
  q.value = '';
  q.style.height = '40px';
  const thinking = appendTyping();

  try {
    const resp = await fetch(getApiBase() + '/api/chat/structured', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ 
        message: text, 
        top_k: 30,
        user_id: getUserId()
      })
    });
    const data = await resp.json();
    thinking.remove();

    if (!resp.ok || !data.success) throw new Error(data.detail || 'Chat failed');

    append('bot', data.answer, data.sources);
  } catch (err) {
    thinking.remove();
    append('bot', `Error: ${err.message}`);
  }
}

function onTextareaKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    qform.requestSubmit();
  }
}

async function fullSync({ silentIfCached = false } = {}) {
  if (isSyncing) return;
  setSyncing(true);
  updateStatus('Syncing…');
  
  try {
    if (!silentIfCached) append('bot', 'Collecting history from Chrome…');
    
    const items = await collectHistoryDirect({ 
      days: settings.days, 
      max: settings.max 
    });
    
    if (!items.length) {
      if (!silentIfCached) append('bot', 'No history found. Check permissions.');
      return;
    }
    
    const enrichedItems = await enrichWithMetadata(items);
    await chrome.storage.local.set({ [HISTORY_KEY]: enrichedItems });

    if (!silentIfCached) append('bot', `Sending ${enrichedItems.length} items to backend…`);

    const r = await fetch(getApiBase() + '/api/history/to_embeddings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ 
        items: enrichedItems,
        user_id: getUserId()
      })
    });
    
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(j.detail || j.message || 'Sync failed');

    if (!silentIfCached) append('bot', `Indexed ${j.total_items} items successfully!`);
    
    const ts = Date.now();
    await chrome.storage.local.set({ [LAST_SYNC_KEY]: ts });
    lastSync.textContent = formatAgo(new Date(ts));
    toast(`Synced ${j.total_items} items`);
    
  } catch (e) {
    toast(e.message, 'error');
    if (!silentIfCached) append('bot', `Sync error: ${e.message}`);
  } finally {
    updateStatus('Ready');
    setSyncing(false);
  }
}

async function collectHistoryDirect({ days = 14, max = 3000 } = {}) {
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
  const raw = await chrome.history.search({ 
    text: '', 
    startTime, 
    maxResults: max 
  });
  
  raw.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  
  return raw.map(item => {
    const dt = new Date(item.lastVisitTime || Date.now());
    return {
      id: item.id || crypto.randomUUID(),
      lastVisitTime: item.lastVisitTime || Date.now(),
      title: item.title || '',
      url: item.url,
      domain: safeDomain(item.url),
      dayOfWeek: dt.getDay(),
      hour: dt.getHours(),
      collectedAt: Date.now()
    };
  });
}

async function enrichWithMetadata(historyItems) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PENDING_METADATA' });
    
    if (!response || !response.metadata || response.metadata.length === 0) {
      return historyItems;
    }
    
    const metadataMap = new Map();
    response.metadata.forEach(meta => {
      if (meta.url && meta.extracted_data) {
        metadataMap.set(meta.url, meta.extracted_data);
      }
    });
    
    const enrichedItems = historyItems.map(item => {
      const metadata = metadataMap.get(item.url);
      if (metadata && Object.keys(metadata).length > 0) {
        return {
          ...item,
          extracted_content: metadata
        };
      }
      return item;
    });
    
    const enrichedCount = enrichedItems.filter(item => item.extracted_content).length;
    if (enrichedCount > 0) {
      toast(`Enriched ${enrichedCount} music/video items`, 'success');
    }
    
    return enrichedItems;
  } catch (error) {
    return historyItems;
  }
}

function safeDomain(u) { 
  try { 
    return new URL(u).hostname.replace(/^www\./, ''); 
  } catch { 
    return 'unknown'; 
  } 
}

async function loadChatMemory() {
  const { [CHAT_KEY]: mem = [] } = await chrome.storage.local.get([CHAT_KEY]);
  memory = mem;
}

async function saveChatMemory() {
  await chrome.storage.local.set({ [CHAT_KEY]: memory.slice(-50) });
}

async function loadSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get([SETTINGS_KEY]);
  if (s) settings = { ...settings, ...s };
  apiBaseInput.value = settings.apiBase;
  daysInput.value = settings.days;
  maxInput.value = settings.max;
}

function getApiBase() { 
  return (settings.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''); 
}

function openSettings() {
  apiBaseInput.value = settings.apiBase;
  daysInput.value = settings.days;
  maxInput.value = settings.max;
  settingsDialog.showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  settings.apiBase = apiBaseInput.value.trim() || DEFAULT_API_BASE;
  settings.days = Math.max(1, Math.min(365, parseInt(daysInput.value || '14', 10)));
  settings.max = Math.max(100, Math.min(10000, parseInt(maxInput.value || '3000', 10)));
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  settingsDialog.close();
  toast('Settings saved');
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.classList.toggle('dark');
  localStorage.setItem('history_chat_theme', dark ? 'dark' : 'light');
}

function applyThemeFromStorage() {
  const t = localStorage.getItem('history_chat_theme') || 'light';
  if (t === 'dark') document.documentElement.classList.add('dark');
}