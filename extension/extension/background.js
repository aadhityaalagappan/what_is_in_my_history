// background.js - Service Worker for History Collector Extension

console.log('🚀 History Collector Extension - Background Script Loaded');

// Store for pending metadata from content scripts
const pendingMetadata = new Map();

// Extension installation handler
chrome.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed:', details.reason);
    
    if (details.reason === 'install') {
        console.log('First time installation - setting up defaults');
        
        chrome.storage.local.set({
            'settings': {
                defaultDays: 30,
                defaultMaxItems: 1000,
                autoCollectOnStartup: false
            },
            'installDate': Date.now()
        }).then(() => {
            console.log('Default settings saved');
            
            // Generate unique user ID on first install
            const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            chrome.storage.local.set({ 'historyExtensionUserId': userId });
            console.log('Generated user ID:', userId);
        });
        
        if (chrome.notifications) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon.png',
                title: 'History Collector Installed!',
                message: 'Click the extension icon to start collecting your browsing data.'
            });
        }
    }
});

chrome.runtime.onStartup.addListener(() => {
    console.log('Browser started');
    
    chrome.storage.local.get(['settings']).then((result) => {
        if (result.settings && result.settings.autoCollectOnStartup) {
            console.log('Auto-collect enabled - triggering collection');
        }
    });
});

chrome.action.onClicked.addListener((tab) => {
    console.log('Extension icon clicked on tab:', tab.url);
});

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);
    
    switch (message.action) {
        case 'GET_EXTENSION_INFO':
            sendResponse({
                version: chrome.runtime.getManifest().version,
                id: chrome.runtime.id,
                installDate: null
            });
            break;
            
        case 'LOG_EVENT':
            console.log(`Event logged: ${message.event}`, message.data);
            break;
        
        case 'GET_USER_ID':
            // Return user ID from storage
            chrome.storage.local.get(['historyExtensionUserId']).then((result) => {
                sendResponse({ userId: result.historyExtensionUserId || null });
            });
            return true; // Keep channel open for async response
            
        default:
            console.log('Unknown message action:', message.action);
            sendResponse({ error: 'Unknown action' });
    }
    
    // Handle MUSIC_METADATA from content scripts
    if (message.type === 'MUSIC_METADATA') {
        console.log('📥 Received music metadata:', message.data);
        
        // Store metadata with URL as key
        const key = message.data.url;
        pendingMetadata.set(key, message.data);
        
        // Clean up old entries (keep last 200)
        if (pendingMetadata.size > 200) {
            const keysToDelete = Array.from(pendingMetadata.keys()).slice(0, pendingMetadata.size - 200);
            keysToDelete.forEach(k => pendingMetadata.delete(k));
        }
        
        sendResponse({ success: true });
    }
    
    // Handle request for pending metadata
    if (message.action === 'GET_PENDING_METADATA') {
        const metadata = Array.from(pendingMetadata.values());
        console.log(`📤 Sending ${metadata.length} pending metadata items`);
        sendResponse({ metadata });
        return true;
    }
    
    return true;
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    console.log('Storage changed in namespace:', namespace);
    
    for (let [key, { oldValue, newValue }] of Object.entries(changes)) {
        if (key === 'historyData' && newValue) {
            console.log(`History data updated: ${newValue.length} items`);
        }
        if (key === 'bookmarkData' && newValue) {
            console.log(`Bookmark data updated: ${newValue.length} items`);
        }
    }
});

self.addEventListener('error', (event) => {
    console.error('Background script error:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection in background script:', event.reason);
});

async function checkPermissions() {
    const permissions = await chrome.permissions.getAll();
    console.log('Current permissions:', permissions);
    return permissions;
}

async function getStorageUsage() {
    try {
        const bytesInUse = await chrome.storage.local.getBytesInUse();
        console.log('Storage usage:', bytesInUse, 'bytes');
        return bytesInUse;
    } catch (error) {
        console.error('Error getting storage usage:', error);
        return 0;
    }
}

async function initializeBackground() {
    console.log('Initializing background script...');
    
    try {
        await checkPermissions();
        await getStorageUsage();
        
        // Ensure user ID exists
        const result = await chrome.storage.local.get(['historyExtensionUserId']);
        if (!result.historyExtensionUserId) {
            const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            await chrome.storage.local.set({ 'historyExtensionUserId': userId });
            console.log('Generated user ID:', userId);
        } else {
            console.log('Existing user ID:', result.historyExtensionUserId);
        }
        
        console.log('✅ Background script initialization complete');
        
    } catch (error) {
        console.error('❌ Background script initialization failed:', error);
    }
}

initializeBackground();

// Export for testing (optional)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pendingMetadata };
}

// background.js
console.log('🚀 History Collector Extension - Background Script Loaded');

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Extension installation
chrome.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed:', details.reason);
    
    if (details.reason === 'install') {
        chrome.storage.local.set({
            'settings': {
                defaultDays: 30,
                defaultMaxItems: 1000,
                autoCollectOnStartup: false
            },
            'installDate': Date.now()
        });
        
        // Generate user ID
        const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        chrome.storage.local.set({ 'historyExtensionUserId': userId });
        
        // Open side panel on first install
        chrome.sidePanel.setOptions({
            enabled: true
        });
    }
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);
    
    if (message.type === 'MUSIC_METADATA') {
        const key = message.data.url;
        pendingMetadata.set(key, message.data);
        
        if (pendingMetadata.size > 200) {
            const keysToDelete = Array.from(pendingMetadata.keys()).slice(0, pendingMetadata.size - 200);
            keysToDelete.forEach(k => pendingMetadata.delete(k));
        }
        
        sendResponse({ success: true });
    }
    
    if (message.action === 'GET_PENDING_METADATA') {
        const metadata = Array.from(pendingMetadata.values());
        sendResponse({ metadata });
    }
    
    return true;
});