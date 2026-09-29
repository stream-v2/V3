importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

zip.configure({ useWebWorkers: false });

let authToken = null;
const activeVaults = new Map();
const logChannel = new BroadcastChannel('streamvault_logs');

function sysLog(msg, isError = false) {
    logChannel.postMessage({ msg, isError });
}

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
    if (e.data.type === 'SYNC_TOKEN') authToken = e.data.token;
    if (e.data.type === 'UNLOCK') activeVaults.set(e.data.fileId, e.data.password);
});

// ==========================================
// 1. ABORT-AWARE GOOGLE DRIVE ENGINE
// ==========================================
class DriveZipReader extends zip.Reader {
    constructor(fileId, token, signal) {
        super();
        this.fileId = fileId;
        this.token = token;
        this.signal = signal; // Ties Drive downloads to the video player timeline
        this.size = 0;
        this.directUrl = '';
    }

    async init() {
        const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?fields=size`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        const metaData = await metaRes.json();
        this.size = parseInt(metaData.size, 10);

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
        if (this.signal.aborted) throw new Error("ABORTED"); // Stop downloading if user scrubs
        const end = offset + length - 1;
        
        const res = await fetch(this.directUrl, {
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Range': `bytes=${offset}-${end}`
            },
            signal: this.signal
        });
        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
    }
}

// ==========================================
// 2. TIMELINE RANGE STREAM WRITER
// ==========================================
class RangeStreamWriter extends zip.Writer {
    constructor(writableStream, startByte, endByte, signal) {
        super();
        this.writer = writableStream.getWriter();
        this.startByte = startByte;
        this.endByte = endByte;
        this.currentByte = 0;
        this.signal = signal;
    }

    async writeUint8Array(array) {
        if (this.signal.aborted) throw new Error("ABORTED");

        const chunkStart = this.currentByte;
        const chunkEnd = this.currentByte + array.length - 1;
        this.currentByte += array.length;

        // Fast-Forward: If chunk is before our requested timeline timestamp, drop it
        if (chunkEnd < this.startByte) return; 
        
        // End of Range: If we passed the requested chunk, kill the engine early to save CPU
        if (chunkStart > this.endByte) throw new Error("RANGE_MET"); 

        let sliceStart = chunkStart < this.startByte ? this.startByte - chunkStart : 0;
        let sliceEnd = chunkEnd > this.endByte ? array.length - (chunkEnd - this.endByte) : array.length;

        if (sliceEnd > sliceStart) {
            try {
                await this.writer.write(array.subarray(sliceStart, sliceEnd));
            } catch (e) {
                throw new Error("ABORTED");
            }
        }
    }

    async getData() {
        try { await this.writer.close(); } catch (e) {}
    }
}

// ==========================================

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/stream-vault/')) {
        event.respondWith(streamDecryptedVideo(event, url.pathname.split('/').pop()));
    }
});

async function streamDecryptedVideo(event, fileId) {
    const request = event.request;
    const signal = request.signal; // Detects when the user scrubs the timeline

    if (!authToken) return new Response("No token", { status: 401 });
    const password = activeVaults.get(fileId);
    if (!password) return new Response("No password", { status: 403 });

    try {
        const customReader = new DriveZipReader(fileId, authToken, signal);
        const zipReader = new zip.ZipReader(customReader);
        
        const entries = await zipReader.getEntries();
        const videoEntry = entries.find(e => e.filename.match(/\.(mp4|m4v|mkv)$/i));
        
        if (!videoEntry) return new Response("No video found", { status: 404 });

        const fileSize = videoEntry.uncompressedSize;
        const ext = videoEntry.filename.split('.').pop().toLowerCase();
        let mimeType = ext === 'mkv' ? 'video/webm' : (ext === 'm4v' ? 'video/x-m4v' : 'video/mp4');

        // --- HTTP 206 RANGE PARSING ---
        let start = 0;
        let end = fileSize - 1;
        let isRange = false;

        if (request.headers.has('range')) {
            isRange = true;
            const rangeParts = request.headers.get('range').match(/bytes=([0-9]+)-([0-9]*)/);
            if (rangeParts) {
                start = parseInt(rangeParts[1], 10);
                if (rangeParts[2]) end = parseInt(rangeParts[2], 10);
            }
        }

        const chunksize = (end - start) + 1;
        
        if (isRange) sysLog(`Player Scrubbed Timeline: Requested bytes ${start}-${end}`);

        const { readable, writable } = new TransformStream();
        const streamWriter = new RangeStreamWriter(writable, start, end, signal);

        // Run decryption asynchronously
        videoEntry.getData(streamWriter, { password: password })
            .then(() => zipReader.close())
            .catch(err => {
                if (err.message !== "ABORTED" && err.message !== "RANGE_MET") {
                    sysLog(`DECRYPTION ERROR: ${err.message}`, true);
                }
                zipReader.close();
            });

        // --- RESPOND WITH SCRUBBABLE STREAM ---
        const headers = {
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
        };

        if (isRange) {
            headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
            headers['Content-Length'] = chunksize.toString();
            return new Response(readable, { status: 206, headers });
        } else {
            headers['Content-Length'] = fileSize.toString();
            return new Response(readable, { status: 200, headers });
        }

    } catch (err) {
        if (err.message !== "ABORTED") sysLog(`FATAL ERROR: ${err.message}`, true);
        return new Response(err.message, { status: 500 });
    }
}
