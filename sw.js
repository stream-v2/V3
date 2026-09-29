let vaultToken = null;
// Secure memory registry for unlocked archives
const unlockedFiles = new Map(); 

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
    if (event.data && event.data.type === 'UNLOCK_FILE') {
        // Store password securely in SW RAM only
        unlockedFiles.set(event.data.fileId, {
            password: event.data.password,
            fileSize: event.data.fileSize
        });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/vault-stream/')) {
        event.respondWith(handleEncryptedStream(event.request, url));
    }
});

async function handleEncryptedStream(request, url) {
    if (!vaultToken) return new Response("Vault locked: Missing token.", { status: 401 });

    const fileId = url.pathname.split('/').pop();
    const vaultData = unlockedFiles.get(fileId);
    
    if (!vaultData) {
        return new Response("Archive is locked. No password in memory.", { status: 403 });
    }

    const rangeHeader = request.headers.get('Range') || 'bytes=0-';
    const match = rangeHeader.match(/bytes=(\d+)-(.*)/);
    
    let requestedStart = parseInt(match[1], 10);
    let requestedEnd = match[2] ? parseInt(match[2], 10) : '';

    // Standard store-mode 7z offset adjustment (Usually 32 bytes)
    // In a full implementation, this offset is dynamically updated by the tail metadata block.
    const HEADER_OFFSET = 32;
    const realStart = requestedStart + HEADER_OFFSET;
    
    // Web Crypto API requires AES-CBC chunks to align perfectly on 16-byte boundaries.
    // We adjust the request window to ensure we fetch a perfectly decryptable block.
    const alignedStart = Math.floor(realStart / 16) * 16;
    let alignedEnd = requestedEnd !== '' ? (requestedEnd + HEADER_OFFSET) : '';
    if (alignedEnd !== '') {
        alignedEnd = Math.ceil(alignedEnd / 16) * 16 + 15; // Ensure 16-byte block
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    try {
        const driveResponse = await fetch(driveUrl, {
            headers: {
                'Authorization': `Bearer ${vaultToken}`,
                'Range': `bytes=${alignedStart}-${alignedEnd}`
            }
        });

        if (!driveResponse.ok) {
            return new Response(`Drive chunk fetch failed: ${driveResponse.status}`, { status: driveResponse.status });
        }

        // ==========================================
        // DECRYPTION PIPELINE
        // Here, the encrypted bytes (driveResponse.body) are intercepted.
        // In the next phase, we will pipe this body through a TransformStream 
        // that runs crypto.subtle.decrypt(AES-CBC) on each 16-byte chunk before
        // handing it to the video player.
        // ==========================================

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Accept-Ranges', 'bytes');

        const driveContentRange = driveResponse.headers.get('Content-Range');
        if (driveContentRange) {
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
        return new Response(`Decryption stream error: ${err.message}`, { status: 500 });
    }
}
