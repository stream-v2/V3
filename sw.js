let vaultToken = null;

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'INIT_VAULT') {
        vaultToken = event.data.token;
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/vault-stream/')) {
        event.respondWith(handleStreamRequest(event.request, url));
    }
});

async function handleStreamRequest(request, url) {
    if (!vaultToken) {
        return new Response("Missing OAuth token in Service Worker.", { status: 401 });
    }

    const fileId = url.pathname.split('/').pop();
    const rangeHeader = request.headers.get('Range') || 'bytes=0-';
    const match = rangeHeader.match(/bytes=(\d+)-(.*)/);
    
    let requestedStart = parseInt(match[1], 10);
    let requestedEnd = match[2] ? parseInt(match[2], 10) : '';

    // Fixed 32-byte 7z signature header offset
    const HEADER_OFFSET = 32;
    const realStart = requestedStart + HEADER_OFFSET;
    const realEnd = requestedEnd !== '' ? (requestedEnd + HEADER_OFFSET) : '';

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    try {
        const driveResponse = await fetch(driveUrl, {
            headers: {
                'Authorization': `Bearer ${vaultToken}`,
                'Range': `bytes=${realStart}-${realEnd}`
            }
        });

        if (!driveResponse.ok) {
            return new Response(`Drive API returned status ${driveResponse.status}`, { status: driveResponse.status });
        }

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Accept-Ranges', 'bytes');

        const driveContentRange = driveResponse.headers.get('Content-Range');
        if (driveContentRange) {
            // Adjust the reported Content-Range back to the client perspective
            const rangeMatch = driveContentRange.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
            if (rangeMatch) {
                const adjStart = Math.max(0, parseInt(rangeMatch[1], 10) - HEADER_OFFSET);
                const adjEnd = Math.max(0, parseInt(rangeMatch[2], 10) - HEADER_OFFSET);
                const adjTotal = rangeMatch[3] !== '*' ? Math.max(0, parseInt(rangeMatch[3], 10) - HEADER_OFFSET) : '*';
                headers.set('Content-Range', `bytes ${adjStart}-${adjEnd}/${adjTotal}`);
            }
        }

        return new Response(driveResponse.body, {
            status: 206,
            headers: headers
        });
    } catch (err) {
        return new Response(`Stream error: ${err.message}`, { status: 500 });
    }
}
