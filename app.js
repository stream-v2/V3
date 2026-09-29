const GOOGLE_CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';

const TARGET_DRIVE_FOLDER = '1bTzbHZ9hcnR9oL38Ue76Q_XzK-JU7g7r';
const video = document.getElementById('vlcPlayer');
const logsOutput = document.getElementById('logsOutput');
let accessToken = null;
let hlsInstance = null;

// --- System Logging ---
function appendLog(msg, isErr = false) {
    const row = document.createElement('div');
    row.className = `log-entry ${isErr ? 'err' : ''}`;
    row.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logsOutput.appendChild(row);
    logsOutput.scrollTop = logsOutput.scrollHeight;
}

const logChannel = new BroadcastChannel('streamvault_logs');
logChannel.onmessage = (e) => appendLog(e.data.msg, e.data.isError);

// --- Register Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(() => appendLog('Service Worker Engine registered.'))
        .catch(err => appendLog(`SW Registration failed: ${err.message}`, true));
}

// ============================================================================
// GOOGLE IDENTITY & DRIVE SCANNER
// ============================================================================
let tokenClient;

document.getElementById('authBtn').addEventListener('click', () => {
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: async (resp) => {
                if (resp.error) return appendLog(`Auth Failed: ${resp.error}`, true);
                accessToken = resp.access_token;
                appendLog('Google Auth Token synchronized successfully (RAM only).');

                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'SYNC_TOKEN', token: accessToken });
                }
                await scanDriveFolder();
            }
        });
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
        appendLog(`OAuth Error: ${err.message}.`, true);
    }
});

async function scanDriveFolder() {
    appendLog(`Scanning Drive for HLS Vaults...`);
    const fileListEl = document.getElementById('fileList');
    fileListEl.innerHTML = '';

    try {
        let query = `mimeType != 'application/vnd.google-apps.folder' and trashed = false and name contains '_HLS_Z.zip' and '${TARGET_DRIVE_FOLDER}' in parents`;

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,size)&pageSize=200`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await res.json();
        
        if (data.error) throw new Error(data.error.message);
        const files = data.files || [];
        document.getElementById('vaultCount').textContent = `${files.length} items`;

        if (files.length === 0) {
            fileListEl.innerHTML = `<li style="padding: 20px; color: var(--text-sub);">No vaults found.</li>`;
            return;
        }

        files.forEach(file => {
            const cleanTitle = file.name.replace('_HLS_Z.zip', '');
            const li = document.createElement('li');
            li.className = 'file-item';
            li.innerHTML = `<div class="title">${cleanTitle}</div><div class="meta">${(file.size / 1048576).toFixed(1)} MB • AES-256 Vault</div>`;
            li.onclick = () => loadHlsStream(file.id, cleanTitle, li);
            fileListEl.appendChild(li);
        });
    } catch (err) {
        appendLog(`Drive Scan Failed: ${err.message}`, true);
    }
}

// ============================================================================
// HLS STREAMING ENGINE
// ============================================================================
function loadHlsStream(fileId, title, listItem) {
    // Password read directly from DOM (RAM). Never touches disk.
    const password = document.getElementById('vaultPassword').value;
    if (!password) return alert('Enter your AES-256 Vault Password at the top.');

    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    listItem.classList.add('active');

    navigator.serviceWorker.controller.postMessage({ type: 'UNLOCK', fileId, password });

    if (hlsInstance) hlsInstance.destroy();
    appendLog(`Mounting HLS stream: ${title}...`);
    
    const playlistUrl = `/stream-vault/${fileId}/master.m3u8`;

    if (Hls.isSupported()) {
        hlsInstance = new Hls({
            maxBufferLength: 15,
            maxMaxBufferLength: 30,
            enableWorker: false
        });

        hlsInstance.loadSource(playlistUrl);
        hlsInstance.attachMedia(video);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            appendLog('Vault unlocked. Stream ready.');
            initAudioBooster();
            video.play().catch(() => {});
        });

        hlsInstance.on(Hls.Events.ERROR, (e, data) => {
            if (data.fatal) appendLog(`HLS Error: ${data.details}`, true);
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playlistUrl;
        video.play();
    }
}

// ============================================================================
// VLC AUDIO BOOSTER & CONTROLS
// ============================================================================
let audioCtx, gainNode;

function initAudioBooster() {
    if (audioCtx) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(video);
    gainNode = audioCtx.createGain();
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
}

const volSlider = document.getElementById('volSlider');
const volVal = document.getElementById('volVal');
const muteBtn = document.getElementById('muteBtn');

volSlider.addEventListener('input', (e) => {
    initAudioBooster();
    const val = parseFloat(e.target.value);
    if (gainNode) gainNode.gain.value = val;
    volVal.textContent = `${Math.round(val * 100)}%`;
    muteBtn.textContent = val === 0 ? '🔇' : (val > 1 ? '🔊' : '🔉');
});

muteBtn.onclick = () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : (parseFloat(volSlider.value) > 1 ? '🔊' : '🔉');
};

const playBtn = document.getElementById('playBtn');
const togglePlay = () => video.paused ? video.play() : video.pause();
playBtn.onclick = togglePlay;
video.onclick = togglePlay;
video.onplay = () => playBtn.textContent = '⏸';
video.onpause = () => playBtn.textContent = '▶';

let showRemaining = false;
const timeDisplay = document.getElementById('timeDisplay');
timeDisplay.onclick = () => showRemaining = !showRemaining;

const fmt = (s) => isNaN(s) ? '00:00:00' : new Date(s * 1000).toISOString().substr(11, 8);

video.addEventListener('timeupdate', () => {
    document.getElementById('progressBar').style.width = `${(video.currentTime / video.duration) * 100}%`;
    if (video.buffered.length > 0) {
        document.getElementById('bufferBar').style.width = `${(video.buffered.end(video.buffered.length - 1) / video.duration) * 100}%`;
    }
    timeDisplay.textContent = showRemaining 
        ? `-${fmt(video.duration - video.currentTime)} / ${fmt(video.duration)}` 
        : `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
});

document.getElementById('timelineBar').onclick = (e) => {
    const rect = e.target.closest('#timelineBar').getBoundingClientRect();
    video.currentTime = ((e.clientX - rect.left) / rect.width) * video.duration;
};

document.getElementById('seekBack5').onclick = () => video.currentTime -= 5;
document.getElementById('seekFwd5').onclick = () => video.currentTime += 5;
document.getElementById('stepBackBtn').onclick = () => { video.pause(); video.currentTime -= 0.04; };
document.getElementById('stepFwdBtn').onclick = () => { video.pause(); video.currentTime += 0.04; };

document.getElementById('speedSelect').onchange = (e) => video.playbackRate = parseFloat(e.target.value);
document.getElementById('pipBtn').onclick = () => document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture();
document.getElementById('fullBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.getElementById('videoWrapper').requestFullscreen();

window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
    switch(e.code) {
        case 'Space': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); video.currentTime -= (e.shiftKey ? 1 : 5); break;
        case 'ArrowRight': e.preventDefault(); video.currentTime += (e.shiftKey ? 1 : 5); break;
        case 'ArrowUp': e.preventDefault(); volSlider.value = Math.min(2, parseFloat(volSlider.value) + 0.05); volSlider.dispatchEvent(new Event('input')); break;
        case 'ArrowDown': e.preventDefault(); volSlider.value = Math.max(0, parseFloat(volSlider.value) - 0.05); volSlider.dispatchEvent(new Event('input')); break;
        case 'KeyF': document.getElementById('fullBtn').click(); break;
        case 'KeyM': muteBtn.click(); break;
        case 'KeyP': document.getElementById('pipBtn').click(); break;
        case 'BracketRight': video.playbackRate = Math.min(3.0, video.playbackRate + 0.25); document.getElementById('speedSelect').value = video.playbackRate; break;
        case 'BracketLeft': video.playbackRate = Math.max(0.25, video.playbackRate - 0.25); document.getElementById('speedSelect').value = video.playbackRate; break;
    }
});
