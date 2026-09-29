const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
const FOLDER_ID = ''; 
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

// --- SERVICE WORKER SETUP ---
async function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.register('sw.js');
            await navigator.serviceWorker.ready;
            console.log('StreamVault Engine Active');
        } catch (e) {
            console.error('Failed to boot StreamVault Engine', e);
        }
    }
}

function syncTokenToWorker() {
    if (navigator.serviceWorker.controller && oauthToken) {
        navigator.serviceWorker.controller.postMessage({
            type: 'INIT_VAULT',
            token: oauthToken
        });
    }
}

// --- GOOGLE AUTHENTICATION ---
function initGoogleAuth() {
    // Initialize Google Identity Services
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: (response) => {
            if (response.error !== undefined) {
                els.statusText.innerText = "Authentication failed.";
                return;
            }
            
            // Save Token & Update UI
            oauthToken = response.access_token;
            els.authBtn.innerText = "Vault Connected";
            els.authBtn.classList.replace('bg-blue-600', 'bg-emerald-600');
            els.authBtn.classList.replace('hover:bg-blue-500', 'hover:bg-emerald-500');
            
            // Pass token to the ZIP engine and load files
            syncTokenToWorker();
            loadDriveFiles();
        }
    });

    // Wire up the Connect button
    els.authBtn.addEventListener('click', () => {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    });
}

// --- GOOGLE DRIVE FILE SCANNER ---
async function loadDriveFiles() {
    els.statusText.innerText = "Scanning encrypted vault...";
    els.fileGrid.innerHTML = '';

    try {
        const query = encodeURIComponent(`'${FOLDER_ID}' in parents and fileExtension = 'zip' and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)&pageSize=100`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) throw new Error(`Drive API Error: ${res.status}`);
        const data = await res.json();
        
        if (!data.files || data.files.length === 0) {
            els.statusText.innerText = "Vault is empty.";
            return;
        }

        els.statusText.innerText = `${data.files.length} Secure Archives Found`;

        // Render UI Cards
        data.files.forEach(file => {
            const sizeMB = file.size ? (file.size / 1024 / 1024).toFixed(1) : '???';
            
            const card = document.createElement('div');
            card.className = 'bg-slate-800 border border-slate-700 rounded-xl p-5 cursor-pointer hover:border-blue-500 hover:bg-slate-800/80 hover:-translate-y-1 transition-all group shadow-lg';
            card.innerHTML = `
                <div class="flex flex-col gap-3">
                    <div class="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center text-slate-400 group-hover:text-blue-500 group-hover:bg-blue-500/10 transition-colors">
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
        els.statusText.innerText = "Error reading vault.";
        console.error(err);
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

    const password = els.archivePassword.value;
    
    // 1. Send password to Service Worker securely
    navigator.serviceWorker.controller.postMessage({
        type: 'UNLOCK_FILE',
        fileId: pendingFile.id,
        password: password
    });

    // 2. Prep Video Player UI
    els.nowPlayingLabel.innerText = pendingFile.name.replace('_Z.zip', '');
    els.playerContainer.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // 3. Trigger the Service Worker Intercept
    els.videoPlayer.src = `/vault-stream/${pendingFile.id}`;
    els.videoPlayer.play().catch(e => console.log("Waiting for user interaction to play..."));
    
    closeUnlockModal();
});

// --- BOOT SEQUENCE ---
window.onload = () => {
    initServiceWorker();
    initGoogleAuth();
};
