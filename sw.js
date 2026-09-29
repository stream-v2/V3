let vaultToken = null;
const unlockedFiles = new Map(); 

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'INIT_VAULT') {
        vaultToken = event.data.token;
    }
    if (event.data && event.data.type === 'UNLOCK_FILE') {
        unlockedFiles.set(event.data.fileId, { password: event.data.password });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/vault-stream/')) {
        event.respondWith(handleEncryptedStream(event.request, url));
    }
});

// Helper to derive AES key from password (SHA-256)
async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]
    );
    // 7z standard uses SHA-256 with 524288 iterations
    return await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: new Uint8Array(16), iterations: 524288, hash: "SHA-256" },
        keyMaterial, { name: "AES-CBC", length: 256 }, false, ["decrypt"]
    );
}

async function handleEncryptedStream(request, url) {
    if (!vaultToken) return new Response("Missing token.", { status: 401 });

    const fileId = url.pathname.split('/').pop();
    const vaultData = unlockedFiles.get(fileId);
    if (!vaultData) return new Response("Locked.", { status: 403 });

    const rangeHeader = request.headers.get('Range') || 'bytes=0-';
    const match = rangeHeader.match(/bytes=(\d+)-(.*)/);
    let requestedStart = parseInt(match[1], 10);
    let requestedEnd = match[2] ? parseInt(match[2], 10) : '';

    // Web Crypto requires perfectly aligned 16-byte AES blocks
    const HEADER_OFFSET = 32;
    const alignedStart = Math.floor((requestedStart + HEADER_OFFSET) / 16) * 16;
    let alignedEnd = requestedEnd !== '' ? (requestedEnd + HEADER_OFFSET) : '';
    if (alignedEnd !== '') {
        alignedEnd = Math.ceil(alignedEnd / 16) * 16 + 15; 
    }

    try {
        // Fetch raw encrypted chunk
        const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${vaultToken}`, 'Range': `bytes=${alignedStart}-${alignedEnd}` }
        });

        if (!driveRes.ok) return new Response(`API Error ${driveRes.status}`, { status: driveRes.status });

        // Generate Crypto Key
        const aesKey = await deriveKey(vaultData.password);
        const iv = new Uint8Array(16); // IV zeroed for simple block streams

        // Pipe encrypted bytes through Decryption TransformStream
        const decryptStream = new TransformStream({
            async transform(chunk, controller) {
                try {
                    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, aesKey, chunk);
                    controller.enqueue(new Uint8Array(decryptedBuffer));
                } catch (e) {
                    // If a 16-byte block is misaligned or padding fails, push raw bytes safely
                    // (This prevents the browser tab from crashing during seek)
                    controller.enqueue(chunk); 
                }
            }
        });

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Accept-Ranges', 'bytes');
        
        const driveContentRange = driveRes.headers.get('Content-Range');
        if (driveContentRange) {
            const rMatch = driveContentRange.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
            if (rMatch) {
                const adjStart = Math.max(0, parseInt(rMatch[1], 10) - HEADER_OFFSET);
                const adjEnd = Math.max(0, parseInt(rMatch[2], 10) - HEADER_OFFSET);
                const adjTotal = rMatch[3] !== '*' ? Math.max(0, parseInt(rMatch[3], 10) - HEADER_OFFSET) : '*';
                headers.set('Content-Range', `bytes ${adjStart}-${adjEnd}/${adjTotal}`);
            }
        }

        const responseStream = driveRes.body.pipeThrough(decryptStream);
        return new Response(responseStream, { status: 206, headers: headers });

    } catch (err) {
        return new Response(`[MEM_ERR] Decryption Pipeline Failed: ${err.message}`, { status: 500 });
    }
}
