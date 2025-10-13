// content-scraper.js - Extracts rich metadata from music/media pages

console.log('🎵 Content scraper loaded on:', window.location.href);

// Wait for page to fully load
setTimeout(() => {
    extractAndSendMetadata();
}, 3000);

function extractAndSendMetadata() {
    const url = window.location.href;
    const metadata = {
        url: url,
        title: document.title,
        domain: window.location.hostname,
        extracted_data: {}
    };
    
    // YouTube Music/Video
    if (url.includes('youtube.com') || url.includes('music.youtube.com')) {
        metadata.extracted_data = extractYouTubeData();
    }
    // Spotify
    else if (url.includes('spotify.com')) {
        metadata.extracted_data = extractSpotifyData();
    }
    
    // Only send if we extracted meaningful data
    if (Object.keys(metadata.extracted_data).length > 0) {
        console.log('📤 Sending metadata:', metadata);
        chrome.runtime.sendMessage({
            type: 'MUSIC_METADATA',
            data: metadata
        });
    }
}

function extractYouTubeData() {
    const data = {};
    
    // Video title
    const titleSelectors = [
        'h1.ytd-video-primary-info-renderer',
        'yt-formatted-string.ytd-watch-metadata',
        'h1.ytd-watch-metadata yt-formatted-string',
        'ytd-watch-metadata h1'
    ];
    
    for (const selector of titleSelectors) {
        const elem = document.querySelector(selector);
        if (elem && elem.textContent.trim()) {
            data.video_title = elem.textContent.trim();
            break;
        }
    }
    
    // Channel/Artist name
    const channelSelectors = [
        '#channel-name',
        'ytd-channel-name a',
        'ytd-video-owner-renderer .ytd-channel-name a',
        '#owner-name a'
    ];
    
    for (const selector of channelSelectors) {
        const elem = document.querySelector(selector);
        if (elem && elem.textContent.trim()) {
            data.channel = elem.textContent.trim();
            break;
        }
    }
    
    // ENHANCED: Get FULL description with visual/contextual clues
    const descSelectors = [
        '#description-inline-expander',
        '#description',
        'ytd-text-inline-expander#description',
        'yt-attributed-string#content'
    ];
    
    for (const selector of descSelectors) {
        const elem = document.querySelector(selector);
        if (elem) {
            // Get full text content
            let descText = elem.textContent.trim();
            
            // Get first 3000 chars (enough for most descriptions)
            data.description = descText.substring(0, 3000);
            
            // Extract key visual/contextual keywords for better search
            const keywords = [];
            const lowerDesc = descText.toLowerCase();
            
            // Instruments
            if (lowerDesc.includes('piano')) keywords.push('piano');
            if (lowerDesc.includes('guitar')) keywords.push('guitar');
            if (lowerDesc.includes('drum')) keywords.push('drums');
            
            // Visual elements
            if (lowerDesc.includes('rain')) keywords.push('rain');
            if (lowerDesc.includes('dance') || lowerDesc.includes('dancing')) keywords.push('dancing');
            if (lowerDesc.includes('beach')) keywords.push('beach');
            if (lowerDesc.includes('city') || lowerDesc.includes('urban')) keywords.push('city');
            if (lowerDesc.includes('night')) keywords.push('night');
            
            // Performance type
            if (lowerDesc.includes('live')) keywords.push('live performance');
            if (lowerDesc.includes('acoustic')) keywords.push('acoustic');
            if (lowerDesc.includes('duet')) keywords.push('duet');
            if (lowerDesc.includes('featuring') || lowerDesc.includes('feat.')) keywords.push('collaboration');
            
            // Gender/people
            if (lowerDesc.match(/\b(she|her|woman|girl|female)\b/)) keywords.push('female artist');
            if (lowerDesc.match(/\b(he|him|man|boy|male)\b/)) keywords.push('male artist');
            
            if (keywords.length > 0) {
                data.contextual_keywords = keywords.join(', ');
            }
            
            break;
        }
    }
    
    // Parse artist/song from title
    if (data.video_title) {
        const lowerTitle = data.video_title.toLowerCase();
        
        // Detect collaboration patterns
        if (lowerTitle.includes('featuring') || lowerTitle.includes('ft.') || 
            lowerTitle.includes('feat.') || lowerTitle.includes('with') ||
            lowerTitle.includes(' & ') || lowerTitle.includes(', ')) {
            data.collaboration = true;
        }
        
        // Pattern: "Artist - Song Title"
        const dashMatch = data.video_title.match(/^([^-]+)\s*-\s*(.+)$/);
        if (dashMatch) {
            data.parsed_artist = dashMatch[1].trim();
            data.parsed_song = dashMatch[2].trim();
        }
        
        // Extract video type from title
        if (lowerTitle.includes('official video')) data.video_type = 'official music video';
        if (lowerTitle.includes('lyric')) data.video_type = 'lyric video';
        if (lowerTitle.includes('live')) data.video_type = 'live performance';
        if (lowerTitle.includes('acoustic')) data.video_type = 'acoustic version';
    }
    
    // Video ID
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');
    if (videoId) {
        data.video_id = videoId;
    }
    
    return data;
}

function extractSpotifyData() {
    const data = {};
    
    // Track name
    const trackSelectors = [
        '[data-testid="entity-title"]',
        'h1[data-encore-id="text"]',
        'h1'
    ];
    
    for (const selector of trackSelectors) {
        const elem = document.querySelector(selector);
        if (elem && elem.textContent.trim()) {
            data.track_name = elem.textContent.trim();
            break;
        }
    }
    
    // Artist(s)
    const artistSelectors = [
        '[data-testid="creator-link"]',
        'a[href*="/artist/"]'
    ];
    
    const artists = [];
    for (const selector of artistSelectors) {
        const elems = document.querySelectorAll(selector);
        elems.forEach(elem => {
            const text = elem.textContent.trim();
            if (text && !artists.includes(text)) {
                artists.push(text);
            }
        });
        if (artists.length > 0) break;
    }
    
    if (artists.length > 0) {
        data.artist = artists.join(', ');
    }
    
    // Album
    const albumElem = document.querySelector('a[href*="/album/"]');
    if (albumElem && albumElem.textContent.trim()) {
        data.album = albumElem.textContent.trim();
    }
    
    // Release year
    const yearElem = document.querySelector('[data-testid="release-year"]');
    if (yearElem && yearElem.textContent.trim()) {
        data.release_year = yearElem.textContent.trim();
    }
    
    return data;
}

// Re-extract when page content changes (for SPAs like YouTube/Spotify)
const observer = new MutationObserver((mutations) => {
    // Debounce: only re-extract after 2 seconds of no changes
    clearTimeout(window.contentScraperTimeout);
    window.contentScraperTimeout = setTimeout(() => {
        extractAndSendMetadata();
    }, 2000);
});

// Observe the document body for changes
observer.observe(document.body, {
    childList: true,
    subtree: true
});