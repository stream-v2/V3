// Import lightweight AES engine to bypass Web Crypto padding limitations
importScripts('https://cdnjs.cloudflare.com/ajax/libs/aes-js/3.1.2/index.min.js');

let vaultToken = null;
const unlockedFiles = new Map(); 

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'INIT_VAULT') vaultToken = event.data.token;
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

// SHA-256 Key Derivation (Returns raw bytes for aes-js)
async function deriveKeyBytes(password) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    // 7z standard PBKDF2 parameters
    const keyBuffer = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: new Uint8Array(16), iterations: 524288, hash: "SHA-256" },
        keyMaterial, 256
    );
    return new Uint8Array(keyBuffer);
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

    const HEADER_OFFSET = 32;
    const realStart = requestedStart + HEADER_OFFSET;
    
    // AES Block Alignment
    const alignedStart = Math.floor(realStart / 16) * 16;
    let alignedEnd = requestedEnd !== '' ? (requestedEnd + HEADER_OFFSET) : '';
    if (alignedEnd !== '') {
        alignedEnd = Math.ceil(alignedEnd / 16) * 16 + 15; 
    }

    // AES-CBC Seeking Magic: Fetch 16 bytes prior to alignedStart to act as the IV for this chunk
    let fetchStart = alignedStart;
    let isMidStreamSeek = false;
    if (alignedStart > HEADER_OFFSET) {
        fetchStart = alignedStart - 16;
        isMidStreamSeek = true;
    }

    try {
        const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${vaultToken}`, 'Range': `bytes=${fetchStart}-${alignedEnd}` }
        });

        if (!driveRes.ok) return new Response(`API Error ${driveRes.status}`, { status: driveRes.status });

        const keyBytes = await deriveKeyBytes(vaultData.password);
        
        let aesCbc = null;
        let buffer = new Uint8Array(0);
        let isFirstChunk = true;

        const decryptStream = new TransformStream({
            transform(chunk, controller) {
                // 1. Combine leftover bytes from previous chunk with the new chunk
                let combined = new Uint8Array(buffer.length + chunk.length);
                combined.set(buffer);
                combined.set(chunk, buffer.length);

                // 2. If this is the first network hit on a mid-stream seek, extract the IV
                if (isFirstChunk && isMidStreamSeek) {
                    if (combined.length >= 16) {
                        const extractedIV = combined.slice(0, 16);
                        aesCbc = new aesjs.ModeOfOperation.cbc(keyBytes, extractedIV);
                        combined = combined.slice(16); // Remove IV from the video pipeline
                        isFirstChunk = false;
                    } else {
                        buffer = combined; // Wait for more bytes to form the IV
                        return;
                    }
                } else if (isFirstChunk && !isMidStreamSeek) {
                    aesCbc = new aesjs.ModeOfOperation.cbc(keyBytes, new Uint8Array(16)); // Start of file IV
                    isFirstChunk = false;
                }

                // 3. Process only perfect 16-byte blocks
                let processableLength = Math.floor(combined.length / 16) * 16;
                if (processableLength > 0) {
                    let toProcess = combined.slice(0, processableLength);
                    buffer = combined.slice(processableLength); // Keep the remainder for the next network chunk

                    try {
                        const decryptedBytes = aesCbc.decrypt(toProcess);
                        controller.enqueue(decryptedBytes);
                    } catch (e) {
                        console.error("Decryption pipeline error:", e);
                    }
                } else {
                    buffer = combined;
                }
            },
            flush(controller) {
                // Ignore trailing padding errors on stream close
                buffer = new Uint8Array(0);
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
        return new Response(`Stream Error: ${err.message}`, { status: 500 });
    }
}
