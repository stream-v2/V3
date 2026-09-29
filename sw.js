importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

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
    if (!vaultToken) return new Response("ERR_SW_AUTH: Drive token missing.", { status: 401 });

    const fileId = url.pathname.split('/').pop();
    const vaultData = unlockedFiles.get(fileId);
    if (!vaultData) return new Response("ERR_SW_LOCK: Vault locked. Provide password.", { status: 403 });

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
            return new Response("ERR_SW_NO_VIDEO: No video found in archive.", { status: 404 });
        }

        // --- DYNAMIC MIME TYPE DETECTOR ---
        let mimeType = 'video/mp4'; // Default to MP4
        const ext = videoEntry.filename.split('.').pop().toLowerCase();
        if (ext === 'mkv') mimeType = 'video/webm'; // Browsers handle MKV best when disguised as WebM
        if (ext === 'm4v') mimeType = 'video/x-m4v';

        const { readable, writable } = new TransformStream();
        const streamWriter = new zip.WritableStreamWriter(writable);

        videoEntry.getData(streamWriter, { password: vaultData.password })
            .then(() => zipReader.close())
            .catch(err => console.error("[ERR_SW_DECRYPT] AES Decryption stream failed:", err));

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': mimeType,
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        return new Response(`ERR_SW_FATAL: ${err.message}`, { status: 500 });
    }
}
