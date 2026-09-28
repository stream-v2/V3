let vaultToken = null;
let vaultCatalog = {};

self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Listen for initialization data from app.js
self.addEventListener('message', event => {
    if (event.data.type === 'INIT_VAULT') {
        vaultToken = event.data.token;
        vaultCatalog = event.data.catalog;
    }
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Intercept only our virtual /stream/ requests
    if (url.pathname.includes('/stream/')) {
        event.respondWith(handleStreamRequest(event.request, url));
    }
});

async function handleStreamRequest(request, url) {
    if (!vaultToken) return new Response("Vault locked. No OAuth token.", { status: 401 });

    const fileId = url.pathname.split('/').pop();
    const filename = url.searchParams.get('filename');
    
    // Check if the HTML5 player is asking for a specific byte range
    const rangeHeader = request.headers.get('Range') || 'bytes=0-';
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(.*)/);
    let requestedStart = parseInt(rangeMatch[1], 10);
    
    // 1. Check the Catalog for the 7z offset
    let videoStartOffset = 0;
    if (vaultCatalog[filename]) {
        videoStartOffset = vaultCatalog[filename].videoStart;
    } else {
        // DYNAMIC FALLBACK: If not in catalog, this is where we would inject 
        // the logic to fetch the first/last few KB and parse the 7z header dynamically.
        // For right now, assuming no offset if not cached.
        console.warn(`File ${filename} not in catalog.json. Missing offset.`);
    }

    // 2. Map the Video Bytes -> 7z File Bytes
    const realDriveStart = requestedStart + videoStartOffset;
    const realDriveEnd = rangeMatch[2] ? (parseInt(rangeMatch[2], 10) + videoStartOffset) : '';

    // 3. Fetch from Google Drive API with OAuth Token
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    
    const driveResponse = await fetch(driveUrl, {
        headers: {
            'Authorization': `Bearer ${vaultToken}`,
            'Range': `bytes=${realDriveStart}-${realDriveEnd}`
        }
    });

    if (!driveResponse.ok) {
        return new Response("Drive API Error", { status: driveResponse.status });
    }

    // 4. Repackage the response for the Video Player
    // The browser automatically deletes this stream from RAM as it plays
    return new Response(driveResponse.body, {
        status: 206,
        headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': driveResponse.headers.get('Content-Range'),
            'Accept-Ranges': 'bytes',
            'Content-Length': driveResponse.headers.get('Content-Length')
        }
    });
}