const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
const FOLDER_ID = '1BZzgwFUc-ISA6QyW--_31zP10IiMS_d0'; 
let oauthToken = ''; 
let tokenClient;
let pendingFile = null;

// --- DOM ELEMENTS ---
const els = {
    authBtn: document.getElementById('authBtn'),
    statusText: document.getElementById('statusText'),
    fileGrid: document.getElementById('fileGrid'),
    playerContainer: document.getElementById('playerContainer'),
    videoPlayer: document.getElementById('videoPlayer'),
    nowPlayingLabel: document.getElementById('nowPlayingLabel'),
    passwordModal: document.getElementById('passwordModal'),
    unlockForm: document.getElementById('unlockForm'),
    archivePassword: document.getElementById('archivePassword'),
    cancelUnlock: document.getElementById('cancelUnlock'),
    targetFileLabel: document.getElementById('targetFileLabel')
};

// --- ERROR LOGGER ---
function logError(message) {
    console.error("[CRITICAL]", message);
    els.statusText.innerHTML = `<span class="text-red-500 font-bold"><i class="fa-solid fa-triangle-exclamation"></i> ${message}</span>`;
}

// --- APP BOOTSTRAP (Called by index.html onload) ---
window.initApp = async function() {
    els.statusText.innerText = "Booting Service Worker...";
    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.register('sw.js');
            await navigator.serviceWorker.ready;
            
            // Force the SW to control the page immediately
            if (!navigator.serviceWorker.controller) {
                window.location.reload();
            }
        } else {
            throw new Error("Browser does not support Service Workers.");
        }

        els.statusText.innerText = "Initializing Google Auth...";
        
        if (typeof google === 'undefined') {
            throw new Error("Google Identity script failed to load. Disable adblockers.");
        }

        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                if (response.error) {
                    logError(`Google Auth Failed: ${response.error}`);
                    return;
                }
                oauthToken = response.access_token;
                els.authBtn.innerText = "Vault Connected";
                els.authBtn.classList.replace('bg-blue-600', 'bg-emerald-600');
                
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'INIT_VAULT', token: oauthToken });
                }
                loadDriveFiles();
            }
        });

        els.authBtn.addEventListener('click', () => {
            els.statusText.innerText = "Waiting for Google login pop-up...";
            try {
                tokenClient.requestAccessToken({ prompt: 'consent' });
            } catch (err) {
                logError("Failed to trigger pop-up: " + err.message);
            }
        });

        els.statusText.innerText = "Engine ready. Click 'Connect Drive'.";

    } catch (err) {
        logError(err.message);
    }
};

// --- GOOGLE DRIVE FILE SCANNER ---
async function loadDriveFiles() {
    els.statusText.innerText = "Scanning Drive for AES-256 ZIPs...";
    els.fileGrid.innerHTML = '';

    try {
       const query = encodeURIComponent(`name contains '_Z.zip' and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)&pageSize=100`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) throw new Error(`Google API rejected request (Status ${res.status}). Check Authorized Origins in Cloud Console.`);
        const data = await res.json();
        
        if (!data.files || data.files.length === 0) {
            els.statusText.innerText = "Folder is empty. No .zip files found.";
            return;
        }

        els.statusText.innerText = `${data.files.length} Secure Archives Found`;

        data.files.forEach(file => {
            const sizeMB = file.size ? (file.size / 1024 / 1024).toFixed(1) : '???';
            const card = document.createElement('div');
            card.className = 'bg-slate-800 border border-slate-700 rounded-xl p-5 cursor-pointer hover:border-blue-500 hover:bg-slate-800/80 transition-all shadow-lg';
            card.innerHTML = `
                <div class="flex flex-col gap-3">
                    <div class="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center text-blue-400">
                        <i class="fa-solid fa-file-zipper text-xl"></i>
                    </div>
                    <div>
                        <strong class="block truncate text-sm font-semibold text-slate-100" title="${file.name}">${file.name}</strong>
                        <div class="flex items-center gap-2 mt-1">
                            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">AES-256</span>
                            <span class="text-slate-400 text-xs">${sizeMB} MB</span>
                        </div>
                    </div>
                </div>`;
            card.onclick = () => openUnlockModal(file);
            els.fileGrid.appendChild(card);
        });

    } catch (err) {
        logError(err.message);
    }
}

// --- UI INTERACTIONS ---
function openUnlockModal(file) {
    pendingFile = file;
    els.targetFileLabel.innerText = file.name;
    els.archivePassword.value = '';
    els.passwordModal.classList.remove('hidden');
    els.archivePassword.focus();
}

function closeUnlockModal() {
    els.passwordModal.classList.add('hidden');
    pendingFile = null;
}

els.cancelUnlock.addEventListener('click', closeUnlockModal);

els.unlockForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pendingFile) return;

    if (!navigator.serviceWorker.controller) {
        logError("Service Worker disconnected. Refresh the page.");
        return;
    }

    const password = els.archivePassword.value;
    navigator.serviceWorker.controller.postMessage({
        type: 'UNLOCK_FILE',
        fileId: pendingFile.id,
        password: password
    });

    els.nowPlayingLabel.innerText = pendingFile.name.replace('_Z.zip', '');
    els.playerContainer.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    els.videoPlayer.src = `/vault-stream/${pendingFile.id}`;
    els.videoPlayer.play().catch(e => console.log("Press play to start video."));
    
    closeUnlockModal();
});
