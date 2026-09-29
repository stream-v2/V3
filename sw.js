importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

let vaultToken = null;
const unlockedFiles = new Map();

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
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
    if (!vaultToken) return new Response("Drive token missing.", { status: 401 });

    const fileId = url.pathname.split('/').pop();
    const vaultData = unlockedFiles.get(fileId);
    if (!vaultData) return new Response("Vault locked. Provide password.", { status: 403 });

    try {
        const driveStreamUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        
        // zip.js connects to Drive using HTTP Range Requests
        const reader = new zip.HttpRangeReader(driveStreamUrl, {
            useXHR: false,
            preventHeadRequest: true,
            httpHeaders: { 'Authorization': `Bearer ${vaultToken}` }
        });

        const zipReader = new zip.ZipReader(reader);
        const entries = await zipReader.getEntries();

        // Target the video file inside the ZIP
        const videoEntry = entries.find(e => e.filename.match(/\.(mp4|m4v|mkv)$/i));
        if (!videoEntry) {
            await zipReader.close();
            return new Response("No video found in archive.", { status: 404 });
        }

        // CREATE A LIVE PIPE: No RAM buffering.
        const { readable, writable } = new TransformStream();
        const streamWriter = new zip.WritableStreamWriter(writable);

        // Start decryption in the background asynchronously 
        videoEntry.getData(streamWriter, { password: vaultData.password })
            .then(() => zipReader.close())
            .catch(err => console.error("[SW] AES Decryption stream failed:", err));

        // Return the readable end of the pipe immediately to the HTML <video> tag
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        return new Response(`[SW] Fatal Stream Error: ${err.message}`, { status: 500 });
    }
}
