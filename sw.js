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
    if (e.data.type === 'SYNC_TOKEN') authToken = e.data.token;
    if (e.data.type === 'UNLOCK') activeVaults.set(e.data.fileId, e.data.password);
});

// ==========================================
// 1. CUSTOM GOOGLE DRIVE ZIP ENGINE
// ==========================================
class DriveZipReader extends zip.Reader {
    constructor(fileId, token) {
        super();
        this.fileId = fileId;
        this.token = token;
        this.size = 0; // CRITICAL: Required by zip.js to locate the Central Directory
        this.directUrl = '';
    }

    async init() {
        sysLog("[Engine] Fetching exact file size...");
        const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?fields=size`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        
        if (!metaRes.ok) throw new Error("Failed to fetch file metadata.");
        const metaData = await metaRes.json();
        this.size = parseInt(metaData.size, 10);
        sysLog(`[Engine] Archive size mapped: ${(this.size / 1024 / 1024).toFixed(2)} MB`);

        sysLog("[Engine] Resolving CDN redirect (CORS Bypass)...");
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media&acknowledgeAbuse=true`;
        const abortCtrl = new AbortController();
        const initRes = await fetch(driveUrl, {
            headers: { 'Authorization': `Bearer ${this.token}` },
            signal: abortCtrl.signal
        });
        
        this.directUrl = initRes.url; 
        abortCtrl.abort(); 
        
        super.init();
    }

    async readUint8Array(offset, length) {
        const end = offset + length - 1;
        const res = await fetch(this.directUrl, {
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Range': `bytes=${offset}-${end}`
            }
        });
        if (!res.ok) throw new Error(`CDN Chunk Fetch Error: ${res.status}`);
        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
    }
}

// ==========================================
// 2. CUSTOM HTML5 VIDEO STREAM WRITER
// ==========================================
class WebStreamWriter extends zip.Writer {
    constructor(writableStream) {
        super();
        this.writer = writableStream.getWriter();
    }
    async writeUint8Array(array) {
        await this.writer.write(array);
    }
    async getData() {
        await this.writer.close();
    }
}
// ==========================================

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/stream-vault/')) {
        event.respondWith(streamDecryptedVideo(url.pathname.split('/').pop()));
    }
});

async function streamDecryptedVideo(fileId) {
    if (!authToken) return new Response("No token", { status: 401 });
    const password = activeVaults.get(fileId);
    if (!password) return new Response("No password", { status: 403 });

    try {
        sysLog("Initializing Custom Google Drive Engine...");
        
        const customReader = new DriveZipReader(fileId, authToken);
        const zipReader = new zip.ZipReader(customReader);
        
        sysLog("Reading ZIP Central Directory...");
        const entries = await zipReader.getEntries();

        const videoEntry = entries.find(e => e.filename.match(/\.(mp4|m4v|mkv)$/i));
        if (!videoEntry) {
            await zipReader.close();
            return new Response("No video found", { status: 404 });
        }

        sysLog(`Found Video: ${videoEntry.filename} (${(videoEntry.uncompressedSize/1024/1024).toFixed(1)} MB)`);
        
        const ext = videoEntry.filename.split('.').pop().toLowerCase();
        let mimeType = 'video/mp4';
        if (ext === 'mkv') mimeType = 'video/webm';
        if (ext === 'm4v') mimeType = 'video/x-m4v';

        const { readable, writable } = new TransformStream();
        const streamWriter = new WebStreamWriter(writable);

        sysLog("Igniting AES-256 decryption pipe...");
        
        videoEntry.getData(streamWriter, { password: password })
            .then(() => zipReader.close())
            .catch(err => sysLog(`DECRYPTION FAILED: ${err.message}. Wrong password?`, true));

        sysLog("Sending readable stream to HTML5 Video Player...");
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': mimeType,
                'Content-Length': videoEntry.uncompressedSize.toString(),
                'Accept-Ranges': 'none',
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        sysLog(`FATAL ENGINE ERROR: ${err.message}`, true);
        return new Response(err.message, { status: 500 });
    }
}
