importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

// Critical: Prevents crashes on Chrome by keeping math on the main SW thread
zip.configure({ useWebWorkers: false });

let authToken = null;
const activeVaults = new Map();

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
    if (e.data.type === 'SYNC_TOKEN') authToken = e.data.token;
    if (e.data.type === 'UNLOCK') activeVaults.set(e.data.fileId, e.data.password);
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/stream-vault/')) {
        event.respondWith(streamDecryptedMP4(url.pathname.split('/').pop()));
    }
});

async function streamDecryptedMP4(fileId) {
    if (!authToken) return new Response("No token", { status: 401 });
    
    const password = activeVaults.get(fileId);
    if (!password) return new Response("No password", { status: 403 });

    try {
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        const reader = new zip.HttpRangeReader(driveUrl, {
            useXHR: false,
            preventHeadRequest: true,
            httpHeaders: { 'Authorization': `Bearer ${authToken}` }
        });

        const zipReader = new zip.ZipReader(reader);
        const entries = await zipReader.getEntries();

        // STRICT MP4 SEARCH ONLY
        const mp4Entry = entries.find(e => e.filename.toLowerCase().endsWith('.mp4'));
        if (!mp4Entry) {
            await zipReader.close();
            return new Response("No MP4 found inside ZIP", { status: 404 });
        }

        const fileSize = mp4Entry.uncompressedSize;
        const { readable, writable } = new TransformStream();
        const streamWriter = new zip.WritableStreamWriter(writable);

        // Start Decryption Pipe
        mp4Entry.getData(streamWriter, { password: password })
            .then(() => zipReader.close())
            .catch(err => console.error("[Decryption Failed]", err));

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'video/mp4',
                'Content-Length': fileSize.toString(),
                'Accept-Ranges': 'none',
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        console.error("[SW Error]", err);
        return new Response(err.message, { status: 500 });
    }
}
