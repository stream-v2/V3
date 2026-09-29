const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
let oauthToken = null;
let pendingFile = null;

// UI Elements
const els = {
    statusText: document.getElementById('status-text'),
    authBtn: document.getElementById('auth-btn'),
    loginScreen: document.getElementById('login-screen'),
    driveUi: document.getElementById('drive-ui'),
    fileGrid: document.getElementById('file-grid'),
    passwordModal: document.getElementById('password-modal'),
    submitPwdBtn: document.getElementById('submit-password'),
    cancelPwdBtn: document.getElementById('cancel-password'),
    targetFileLabel: document.getElementById('target-file-label'),
    archivePasswordInput: document.getElementById('archive-password'),
    videoModal: document.getElementById('video-modal'),
    videoContainer: document.getElementById('video-container'),
    playingTitle: document.getElementById('playing-title'),
    closeModal: document.getElementById('close-modal'),
    debugConsole: document.getElementById('debug-console'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text')
};

let currentVideo = null;

function logToScreen(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
    const color = isError ? 'text-red-400' : 'text-green-400';
    els.debugConsole.innerHTML += `<div class="${color}">[${time}] ${msg}</div>`;
    els.debugConsole.scrollTop = els.debugConsole.scrollHeight;
}

function showLoader(text) {
    els.loadingText.innerText = text;
    els.loadingOverlay.classList.remove('hidden');
}

function hideLoader() {
    els.loadingOverlay.classList.add('hidden');
}

window.onload = async function () {
    logToScreen("System Booting...");
    
    try {
        await navigator.serviceWorker.register('./sw.js');
        await navigator.serviceWorker.ready;
        logToScreen("Decryption Engine Ready.");
    } catch (err) {
        logToScreen(`[SW_ERR] ${err.message}`, true);
    }

    let tokenClient;
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                if (response.error || !response.access_token) return logToScreen("Auth failed.", true);
                
                oauthToken = response.access_token;
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'INIT_VAULT', token: oauthToken });
                }

                els.loginScreen.classList.add('hidden');
                els.driveUi.classList.remove('hidden');
                els.statusText.innerText = "Vault Connected";
                loadDriveFiles();
            }
        });
    } catch (err) {
        logToScreen(`Client Error: ${err.message}`, true);
    }

    els.authBtn.onclick = () => tokenClient.requestAccessToken({ prompt: 'select_account' });
};

async function loadDriveFiles() {
    logToScreen("Scanning Drive...");
    try {
        const query = encodeURIComponent("fileExtension = '7z' and trashed = false");
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)&pageSize=100`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) throw new Error(`API ${res.status}`);
        
        const data = await res.json();
        els.fileGrid.innerHTML = '';
        const validFiles = (data.files || []).filter(file => file.name.toLowerCase().endsWith('.7z'));

        validFiles.forEach(file => {
            const sizeMB = file.size ? Math.round(file.size / 1024 / 1024) : 'Unknown';
            const card = document.createElement('div');
            // Tailwind Card Styling
            card.className = 'bg-slate-800 border border-slate-700 rounded-lg p-4 cursor-pointer hover:border-blue-500 hover:-translate-y-1 transition-all group';
            card.innerHTML = `
                <div class="flex items-start gap-3">
                    <i class="fa-solid fa-file-zipper text-2xl text-slate-500 group-hover:text-blue-400 transition-colors"></i>
                    <div class="overflow-hidden">
                        <strong class="block truncate text-sm font-medium text-slate-200">${file.name}</strong>
                        <small class="text-slate-400 text-xs">${sizeMB} MB</small>
                    </div>
                </div>`;
            card.onclick = () => {
                pendingFile = file;
                els.targetFileLabel.innerText = file.name;
                els.archivePasswordInput.value = '';
                els.passwordModal.classList.remove('hidden');
                els.archivePasswordInput.focus();
            };
            els.fileGrid.appendChild(card);
        });
        logToScreen(`Rendered ${validFiles.length} archives.`);
    } catch (err) {
        logToScreen(`[API_ERR] ${err.message}`, true);
    }
}

els.submitPwdBtn.onclick = async () => {
    const password = els.archivePasswordInput.value;
    if (!password) return;
    
    els.passwordModal.classList.add('hidden');
    showLoader("Deriving AES Keys..."); // UI LOADING FEEDBACK
    logToScreen(`Unlocking ${pendingFile.name}...`);

    try {
        const tailRes = await fetch(`https://www.googleapis.com/drive/v3/files/${pendingFile.id}?alt=media`, {
            headers: { 'Authorization': `Bearer ${oauthToken}`, 'Range': `bytes=-32768` }
        });

        if (!tailRes.ok) throw new Error(`Metadata fetch failed (${tailRes.status})`);
        
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'UNLOCK_FILE',
                fileId: pendingFile.id,
                password: password,
                fileSize: pendingFile.size
            });
        }
        
        setTimeout(() => {
            hideLoader();
            openPlayer(pendingFile.id, pendingFile.name);
        }, 1000); // Artificial delay to ensure SW memory is set before video tags fires

    } catch (err) {
        hideLoader();
        logToScreen(`[DEC_ERR] ${err.message}`, true);
    }
};

els.cancelPwdBtn.onclick = () => {
    els.passwordModal.classList.add('hidden');
    pendingFile = null;
};

function openPlayer(fileId, filename) {
    els.playingTitle.innerText = filename;
    const streamUrl = `./vault-stream/${fileId}?filename=${encodeURIComponent(filename)}`;

    currentVideo = document.createElement('video');
    currentVideo.controls = true;
    currentVideo.autoplay = true;
    currentVideo.className = 'w-full h-full';
    currentVideo.src = streamUrl;

    els.videoContainer.innerHTML = '';
    els.videoContainer.appendChild(currentVideo);
    els.videoModal.classList.remove('hidden');
}

els.closeModal.onclick = () => {
    if (currentVideo) {
        currentVideo.pause();
        currentVideo.removeAttribute('src');
        currentVideo.load();
        currentVideo.remove();
        currentVideo = null;
    }
    els.videoContainer.innerHTML = '';
    els.videoModal.classList.add('hidden');
    logToScreen("Stream closed.");
};
