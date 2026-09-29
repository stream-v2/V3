// ============================================================================
// STREAMVAULT HLS-ZIP ENGINE (Service Worker)
// ============================================================================
importScripts('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.29/dist/zip.min.js');

// Enforce single-core, low-overhead decryption to preserve device battery
zip.configure({ useWebWorkers: false });

let authToken = null;
const activePasswords = new Map(); // fileId -> password
const vaultSessions = new Map();   // fileId -> { directUrl, size, entriesMap }

const logChannel = new BroadcastChannel('streamvault_logs');
function sysLog(msg, isError = false) {
    logChannel.postMessage({ msg, isError });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
    if (e.data.type === 'SYNC_TOKEN') authToken = e.data.token;
    if (e.data.type === 'UNLOCK') {
        activePasswords.set(e.data.fileId, e.data.password);
        vaultSessions.delete(e.data.fileId); // Clear old session on new unlock
    }
});

// ----------------------------------------------------------------------------
// Byte-Range Drive Reader (Direct CDN Pipe)
// ----------------------------------------------------------------------------
class DriveZipReader extends zip.Reader {
    constructor(fileId, token, directUrl, size) {
        super();
        this.fileId = fileId;
        this.token = token;
        this.directUrl = directUrl;
        this.size = size;
    }

    async init() {
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

        if (!res.ok && res.status !== 206) {
            throw new Error(`Drive CDN rejected range bytes=${offset}-${end} (HTTP ${res.status})`);
        }

        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
    }
}

// ----------------------------------------------------------------------------
// Session Manager (Initializes Vault Map Once per Lecture)
// ----------------------------------------------------------------------------
async function getOrCreateVaultSession(fileId) {
    if (vaultSessions.has(fileId)) {
        return vaultSessions.get(fileId);
    }

    sysLog(`[Engine] Initializing vault map for file: ${fileId}...`);

    // 1. Resolve file size from Drive API
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!metaRes.ok) throw new Error("Failed to fetch file metadata from Drive");
    const metaData = await metaRes.json();
    const size = parseInt(metaData.size, 10);

    // 2. Resolve Google CDN storage endpoint
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&acknowledgeAbuse=true`;
    const abortCtrl = new AbortController();
    const initRes = await fetch(driveUrl, {
        headers: { 'Authorization': `Bearer ${authToken}` },
        signal: abortCtrl.signal
    });
    const directUrl = initRes.url;
    abortCtrl.abort();

    // 3. Read ZIP Central Directory table
    const reader = new DriveZipReader(fileId, authToken, directUrl, size);
    await reader.init();

    const zipReader = new zip.ZipReader(reader);
    const entries = await zipReader.getEntries();
    const entriesMap = new Map();

    for (const entry of entries) {
        // Normalize filename (strip any directory prefixes)
        const cleanName = entry.filename.split('/').pop();
        entriesMap.set(cleanName, entry);
    }

    sysLog(`[Engine] Vault indexed successfully (${entriesMap.size} chunks mapped).`);

    const session = { directUrl, size, zipReader, entriesMap };
    vaultSessions.set(fileId, session);
    return session;
}

// ----------------------------------------------------------------------------
// HTTP Interceptor for HLS Playlists and Segments
// ----------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const match = url.pathname.match(/\/stream-vault\/([^\/]+)\/(.+)$/);

    if (match) {
        const fileId = match[1];
        const resourceName = match[2];
        event.respondWith(handleHlsRequest(fileId, resourceName));
    }
});

async function handleHlsRequest(fileId, resourceName) {
    if (!authToken) return new Response("Unauthorized: Missing Auth Token", { status: 401 });
    const password = activePasswords.get(fileId);
    if (!password) return new Response("Forbidden: Missing Vault Password", { status: 403 });

    try {
        const session = await getOrCreateVaultSession(fileId);
        const entry = session.entriesMap.get(resourceName);

        if (!entry) {
            sysLog(`[Engine] Requested chunk not in vault: ${resourceName}`, true);
            return new Response(`File not found in vault: ${resourceName}`, { status: 404 });
        }

        // Handle M3U8 Playlist
        if (resourceName.endsWith('.m3u8')) {
            const textWriter = new zip.TextWriter();
            const playlistText = await entry.getData(textWriter, { password });

            return new Response(playlistText, {
                status: 200,
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-cache'
                }
            });
        }

        // Handle 4-Second TS Video Segments
        if (resourceName.endsWith('.ts')) {
            const bufferWriter = new zip.Uint8ArrayWriter();
            const chunkBytes = await entry.getData(bufferWriter, { password });

            return new Response(chunkBytes, {
                status: 200,
                headers: {
                    'Content-Type': 'video/mp2t',
                    'Content-Length': chunkBytes.length.toString(),
                    'Cache-Control': 'public, max-age=86400'
                }
            });
        }

        return new Response("Unsupported file format", { status: 415 });

    } catch (err) {
        sysLog(`[Engine Error] Chunk ${resourceName}: ${err.message}`, true);
        return new Response(err.message, { status: 500 });
    }
}
