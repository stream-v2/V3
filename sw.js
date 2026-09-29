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
        sysLog("Connecting to Google Drive API...");
        
        // CRITICAL FIX: Embed the auth token directly into the URL to survive Google's redirects.
        // Also added acknowledgeAbuse=true to bypass Google Drive's large-file virus scan blocks.
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&acknowledgeAbuse=true&access_token=${authToken}`;
        
        const reader = new zip.HttpRangeReader(driveUrl, {
            useXHR: false,
            preventHeadRequest: true
            // Authorization header is removed here because it is now safely in the URL
        });

        sysLog("Reading ZIP Central Directory...");
        const zipReader = new zip.ZipReader(reader);
        const entries = await zipReader.getEntries();

        sysLog(`Found ${entries.length} files in archive. Searching for Video...`);
        
        // CRITICAL FIX: Expanded to catch .m4v and .mkv since your file is an M4V!
        const videoEntry = entries.find(e => e.filename.match(/\.(mp4|m4v|mkv)$/i));
        
        if (!videoEntry) {
            sysLog("No video file found inside the ZIP!", true);
            await zipReader.close();
            return new Response("No video found", { status: 404 });
        }

        sysLog(`Found Video: ${videoEntry.filename} (${(videoEntry.uncompressedSize/1024/1024).toFixed(1)} MB)`);
        
        // Set correct MIME type so the HTML5 player accepts it
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
