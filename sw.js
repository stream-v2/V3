importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

zip.configure({ useWebWorkers: false });

let authToken = null;
const activeVaults = new Map();
const logChannel = new BroadcastChannel('streamvault_logs');

function sysLog(msg, isError = false) {
    logChannel.postMessage({ msg, isError });
}

self.addEventListener('install', (e) => {
    self.skipWaiting();
    sysLog("New Service Worker installed.");
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
    sysLog("Service Worker activated and claimed clients.");
});

self.addEventListener('message', (e) => {
    if (e.data.type === 'SYNC_TOKEN') {
        authToken = e.data.token;
        sysLog("Engine received Google Token.");
    }
    if (e.data.type === 'UNLOCK') {
        activeVaults.set(e.data.fileId, e.data.password);
        sysLog(`Password cached for file ID: ${e.data.fileId}`);
    }
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/stream-vault/')) {
        sysLog(`Intercepted stream request for Drive File ID: ${url.pathname.split('/').pop()}`);
        event.respondWith(streamDecryptedVideo(url.pathname.split('/').pop()));
    }
});

async function streamDecryptedVideo(fileId) {
    if (!authToken) {
        sysLog("Fetch aborted: No Google auth token.", true);
        return new Response("No token", { status: 401 });
    }
    
    const password = activeVaults.get(fileId);
    if (!password) {
        sysLog("Fetch aborted: No password provided.", true);
        return new Response("No password", { status: 403 });
    }

    try {
        sysLog("Resolving Google Drive redirect to bypass CORS restrictions...");
        
        // 1. PRE-RESOLUTION: We fetch the URL without Range headers so the browser happily follows the redirect.
        const initialUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&acknowledgeAbuse=true`;
        const abortCtrl = new AbortController();
        
        const initialRes = await fetch(initialUrl, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            signal: abortCtrl.signal
        });

        if (!initialRes.ok) {
            throw new Error(`Google API blocked the request: ${initialRes.status}`);
        }

        // 2. We capture the final direct URL to the hidden media server!
        const finalStreamUrl = initialRes.url;
        
        // 3. Instantly abort the download so it doesn't eat your RAM.
        abortCtrl.abort();
        
        sysLog("Redirect resolved. Initializing direct Range Reader...");

        // 4. Give the final direct URL to the ZIP engine. No more redirects!
        const reader = new zip.HttpRangeReader(finalStreamUrl, {
            useXHR: false,
            preventHeadRequest: true,
            httpHeaders: { 'Authorization': `Bearer ${authToken}` }
        });

        sysLog("Reading ZIP Central Directory...");
        const zipReader = new zip.ZipReader(reader);
        const entries = await zipReader.getEntries();

        sysLog(`Found ${entries.length} files in archive. Searching for Video...`);
        
        const videoEntry = entries.find(e => e.filename.match(/\.(mp4|m4v|mkv)$/i));
        
        if (!videoEntry) {
            sysLog("No video file found inside the ZIP!", true);
            await zipReader.close();
            return new Response("No video found", { status: 404 });
        }

        sysLog(`Found Video: ${videoEntry.filename} (${(videoEntry.uncompressedSize/1024/1024).toFixed(1)} MB)`);
        
        const ext = videoEntry.filename.split('.').pop().toLowerCase();
        let mimeType = 'video/mp4';
        if (ext === 'mkv') mimeType = 'video/webm';
        if (ext === 'm4v') mimeType = 'video/x-m4v';

        const fileSize = videoEntry.uncompressedSize;
        const { readable, writable } = new TransformStream();
        const streamWriter = new zip.WritableStreamWriter(writable);

        sysLog("Igniting AES-256 decryption pipe...");
        
        videoEntry.getData(streamWriter, { password: password })
            .then(() => {
                sysLog("Decryption stream successfully finished.");
                zipReader.close();
            })
            .catch(err => {
                sysLog(`DECRYPTION FAILED: ${err.message}. Wrong password?`, true);
            });

        sysLog("Sending readable stream to HTML5 Video Player...");
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': mimeType,
                'Content-Length': fileSize.toString(),
                'Accept-Ranges': 'none',
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        sysLog(`FATAL ENGINE ERROR: ${err.message}`, true);
        return new Response(err.message, { status: 500 });
    }
}
