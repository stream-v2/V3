const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
let oauthToken = ''; 
let tokenClient;
let pendingFile = null;

// --- DOM ELEMENTS ---
const els = {
    authBtn: document.getElementById('authBtn'),
    statusText: document.getElementById('statusText'),
    loadingSpinner: document.getElementById('loadingSpinner'),
    statusIndicator: document.getElementById('statusIndicator'),
    fileGrid: document.getElementById('fileGrid'),
    playerContainer: document.getElementById('playerContainer'),
    videoPlayer: document.getElementById('videoPlayer'),
    nowPlayingLabel: document.getElementById('nowPlayingLabel'),
    passwordModal: document.getElementById('passwordModal'),
    unlockForm: document.getElementById('unlockForm'),
    archivePassword: document.getElementById('archivePassword'),
    cancelUnlock: document.getElementById('cancelUnlock'),
    targetFileLabel: document.getElementById('targetFileLabel'),
    errorConsole: document.getElementById('errorConsole'),
    errorCodeLabel: document.getElementById('errorCodeLabel'),
    errorConsoleMessage: document.getElementById('errorConsoleMessage')
};

// --- ERROR HANDLER ---
function showError(code, message) {
    console.error(`[${code}]`, message);
    els.errorConsole.classList.remove('hidden');
    els.errorCodeLabel.innerText = code;
    els.errorConsoleMessage.innerText = message;
    setLoading(false, "System Halted");
}

function clearError() {
    els.errorConsole.classList.add('hidden');
}

function setLoading(isLoading, text) {
    els.statusText.innerText = text;
    if (isLoading) {
        els.loadingSpinner.classList.remove('hidden');
        els.statusIndicator.classList.add('text-blue-400', 'ring-blue-500/30');
    } else {
        els.loadingSpinner.classList.add('hidden');
        els.statusIndicator.classList.remove('text-blue-400', 'ring-blue-500/30');
    }
}

// --- BOOTSTRAP ---
window.initApp = async function() {
    clearError();
    setLoading(true, "Booting Decryption Engine...");
    
    try {
        if ('serviceWorker' in navigator) {
            await navigator.serviceWorker.register('sw.js');
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller) window.location.reload();
        } else {
            throw new Error("Browser does not support secure Service Workers.");
        }

        if (typeof google === 'undefined') {
            throw new Error("Google API blocked. Disable your Adblocker or Brave Shields.");
        }

        setLoading(true, "Authenticating Client...");
        
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                if (response.error) {
                    showError("ERR_AUTH_01", `Google refused login: ${response.error}`);
                    return;
                }
                oauthToken = response.access_token;
                
                // Update UI to Connected State
                els.authBtn.innerHTML = `<i class="fa-solid fa-check"></i> Connected`;
                els.authBtn.classList.replace('bg-white/10', 'bg-emerald-500/20');
                els.authBtn.classList.replace('hover:bg-blue-600', 'hover:bg-emerald-500/30');
                els.authBtn.classList.add('text-emerald-400', 'ring-1', 'ring-emerald-500/50');
                
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'INIT_VAULT', token: oauthToken });
                }
                scanEntireDrive();
            }
        });

        els.authBtn.addEventListener('click', () => {
            clearError();
            tokenClient.requestAccessToken({ prompt: 'consent' });
        });

        setLoading(false, "Ready. Connect Drive to begin.");

    } catch (err) {
        showError("ERR_BOOT_00", err.message);
    }
};

// --- GLOBAL DRIVE SCANNER (BYPASSES FOLDERS) ---
async function scanEntireDrive() {
    clearError();
    setLoading(true, "Deep scanning entire Google Drive for .zip files...");
    els.fileGrid.innerHTML = '';

    try {
        // This query ignores folders. It finds EVERY zip file you own.
        const query = encodeURIComponent(`name contains '.zip' and trashed = false`);
        const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size,thumbnailLink)&pageSize=100`;
        
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) throw new Error(`Google API returned Status ${res.status}.`);
        const data = await res.json();
        
        if (!data.files || data.files.length === 0) {
            showError("ERR_EMPTY_02", "Deep scan completed. Zero .zip files were found on this Google account.");
            return;
        }

        setLoading(false, `${data.files.length} Encrypted Files Found`);

        // Render Cinematic Cards
        data.files.forEach(file => {
            const sizeMB = file.size ? (file.size / 1024 / 1024).toFixed(1) : 'Unknown';
            const cleanName = file.name.replace('.zip', '').replace('_Z', '');
            
            const card = document.createElement('div');
            card.className = 'group relative bg-slate-900 border border-white/5 rounded-2xl p-1 overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-500/50 transition-all duration-300 shadow-xl';
            
            card.innerHTML = `
                <div class="absolute inset-0 bg-gradient-to-b from-transparent to-slate-950/90 z-10"></div>
                <div class="aspect-video bg-slate-800 rounded-xl flex items-center justify-center relative overflow-hidden">
                    <i class="fa-solid fa-file-zipper text-4xl text-slate-700 group-hover:scale-110 group-hover:text-blue-500/50 transition-all duration-500"></i>
                </div>
                <div class="absolute bottom-0 left-0 w-full p-4 z-20 transform translate-y-2 group-hover:translate-y-0 transition-all">
                    <h3 class="font-bold text-white text-sm truncate drop-shadow-md" title="${file.name}">${cleanName}</h3>
                    <div class="flex items-center gap-3 mt-2 opacity-0 group-hover:opacity-100 transition-opacity delay-100">
                        <span class="bg-blue-600 px-2 py-1 rounded text-[10px] font-black tracking-wider text-white">AES-256</span>
                        <span class="text-slate-300 text-xs font-mono">${sizeMB} MB</span>
                    </div>
                </div>`;
            
            card.onclick = () => openUnlockModal(file, cleanName);
            els.fileGrid.appendChild(card);
        });

    } catch (err) {
        showError("ERR_API_03", err.message);
    }
}

// --- UI INTERACTIONS ---
function openUnlockModal(file, cleanName) {
    pendingFile = file;
    els.targetFileLabel.innerText = cleanName;
    els.archivePassword.value = '';
    els.passwordModal.classList.remove('hidden');
    setTimeout(() => els.archivePassword.focus(), 100);
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
        showError("ERR_SW_04", "Service Worker disconnected. Please hard refresh the page.");
        return;
    }

    const password = els.archivePassword.value;
    navigator.serviceWorker.controller.postMessage({
        type: 'UNLOCK_FILE',
        fileId: pendingFile.id,
        password: password
    });

    els.nowPlayingLabel.innerHTML = `<i class="fa-solid fa-film text-blue-500"></i> ${els.targetFileLabel.innerText}`;
    els.playerContainer.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    els.videoPlayer.src = `/vault-stream/${pendingFile.id}`;
    els.videoPlayer.play().catch(e => console.log("Press play manually."));
    
    closeUnlockModal();
});
