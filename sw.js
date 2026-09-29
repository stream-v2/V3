importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

// 1. CRITICAL FIX: Stop zip.js from crashing by disabling sub-workers inside the SW
zip.configure({ useWebWorkers: false });

let vaultToken = null;
const unlockedFiles = new Map();

self.addEventListener('install', (event) => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    if (event.data?.type === 'INIT_VAULT') vaultToken = event.data.token;
    if (event.data?.type === 'UNLOCK_FILE') {
        unlockedFiles.set(event.data.fileId, { password: event.data.password });
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/vault-stream/')) {
        event.respondWith(handleZipStream(event.request, url));
    }
});

async function handleZipStream(request, url) {
    if (!vaultToken) return new Response("ERR: Drive token missing.", { status: 401 });

    const fileId = url.pathname.split('/').pop();
    const vaultData = unlockedFiles.get(fileId);
    if (!vaultData) return new Response("ERR: Vault locked.", { status: 403 });

    try {
        const driveStreamUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        
        const reader = new zip.HttpRangeReader(driveStreamUrl, {
            useXHR: false,
            preventHeadRequest: true,
            httpHeaders: { 'Authorization': `Bearer ${vaultToken}` }
        });

        const zipReader = new zip.ZipReader(reader);
        const entries = await zipReader.getEntries();

        const videoEntry = entries.find(e => e.filename.match(/\.(mp4|m4v|mkv)$/i));
        if (!videoEntry) {
            await zipReader.close();
            return new Response("ERR: No video found.", { status: 404 });
        }

        let mimeType = 'video/mp4';
        if (videoEntry.filename.toLowerCase().endsWith('.mkv')) mimeType = 'video/webm';

        // 2. CRITICAL FIX: Extract the exact file size so the <video> tag accepts the stream
        const fileSize = videoEntry.uncompressedSize;

        const { readable, writable } = new TransformStream();
        const streamWriter = new zip.WritableStreamWriter(writable);

        // Start AES-256 decryption
        videoEntry.getData(streamWriter, { password: vaultData.password })
            .then(() => zipReader.close())
            .catch(err => {
                // 3. CRITICAL FIX: Log password failures directly to the console
                console.error("[DECRYPT_CRASH] Decryption failed! Check your password.", err);
            });

        // 4. CRITICAL FIX: Feed strict headers to force the browser to play the live pipe
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': mimeType,
                'Content-Length': fileSize.toString(),
                'Accept-Ranges': 'none', // Forces the browser to stream sequentially
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        console.error("[FATAL_SW_ERROR]", err);
        return new Response(`ERR: ${err.message}`, { status: 500 });
    }
}
