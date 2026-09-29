const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
let oauthToken = null;
let pendingFile = null;

const statusText = document.getElementById('status-text');
const authBtn = document.getElementById('auth-btn');
const loginScreen = document.getElementById('login-screen');
const driveUi = document.getElementById('drive-ui');
const fileGrid = document.getElementById('file-grid');
const passwordModal = document.getElementById('password-modal');
const submitPwdBtn = document.getElementById('submit-password');
const targetFileLabel = document.getElementById('target-file-label');
const archivePasswordInput = document.getElementById('archive-password');
const videoModal = document.getElementById('video-modal');
const videoContainer = document.getElementById('video-container');
const playingTitle = document.getElementById('playing-title');
const closeModal = document.getElementById('close-modal');
const debugConsole = document.getElementById('debug-console');
let currentVideo = null;

function logToScreen(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
    const color = isError ? '#f87171' : '#4ade80';
    debugConsole.innerHTML += `<div style="color: ${color}">[${time}] ${msg}</div>`;
    debugConsole.scrollTop = debugConsole.scrollHeight;
}

// 1. Initialize Engine
async function initEngine() {
    try {
        logToScreen("Booting Decryption Engine & Service Worker...");
        await navigator.serviceWorker.register('./sw.js');
        await navigator.serviceWorker.ready;
        return true;
    } catch (err) {
        logToScreen(`SW Error: ${err.message}`, true);
        return false;
    }
}

window.onload = function () {
    logToScreen("System Booting...");
    
    // 1. Boot Service Worker in the background (Do not block the login button!)
    initEngine();

    // 2. Initialize Google Login
    let tokenClient;
    try {
        if (typeof google === 'undefined') {
            logToScreen("[AUTH_ERR_01] Google script blocked by browser or adblocker.", true);
            return;
        }

        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID, // Ensure your Client ID at the top is correct!
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                logToScreen("OAuth Success. Tunneling token to vault...");
                authBtn.disabled = false;
                authBtn.innerText = "Login with Google";

                if (response.error || !response.access_token) return logToScreen("Auth failed.", true);
                
                oauthToken = response.access_token;
                
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'INIT_VAULT', token: oauthToken });
                }

                loginScreen.style.display = 'none';
                driveUi.style.display = 'block';
                statusText.innerText = "Vault Connected";
                loadDriveFiles();
            },
            error_callback: (err) => {
                authBtn.disabled = false;
                authBtn.innerText = "Login with Google";
                logToScreen(`Google Popup Error: ${err.type}`, true);
            }
        });
        
        logToScreen("Login system ready.");
    } catch (err) {
        logToScreen(`Client Error: ${err.message}`, true);
    }

    // 3. The Button Click Event (Now with visual feedback restored)
    authBtn.onclick = () => {
        authBtn.disabled = true;
        authBtn.innerText = "Authorizing...";
        logToScreen("Opening login popup...");
        
        if (tokenClient) {
            tokenClient.requestAccessToken({ prompt: 'select_account' });
        } else {
            logToScreen("Cannot open popup. Google client failed to initialize.", true);
        }
    };
};
    } catch (err) {
        logToScreen(`Client Error: ${err.message}`, true);
    }

    authBtn.onclick = () => tokenClient.requestAccessToken({ prompt: 'select_account' });
};

async function loadDriveFiles() {
    logToScreen("Scanning Drive for strict .7z Archives...");
    try {
        // 1. Strict API Query: fileExtension must be exactly 7z
        const query = encodeURIComponent("fileExtension = '7z' and trashed = false");
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)&pageSize=100`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) {
            logToScreen(`[API_ERR_02] Drive API rejected request: ${res.status}`, true);
            return;
        }

        const data = await res.json();
        fileGrid.innerHTML = '';

        // 2. JavaScript Armor: Physically ensure the name ends with .7z
        const validFiles = (data.files || []).filter(file => file.name.toLowerCase().endsWith('.7z'));

        if (validFiles.length === 0) {
            return logToScreen("No strict .7z files found in Drive.", true);
        }

        logToScreen(`Filtered down to ${validFiles.length} verified archives.`);
        
        validFiles.forEach(file => {
            const sizeMB = file.size ? Math.round(file.size / 1024 / 1024) : 'Unknown';
            const card = document.createElement('div');
            card.className = 'file-card';
            card.innerHTML = `<strong>${file.name}</strong><small>${sizeMB} MB</small>`;
            card.onclick = () => {
                pendingFile = file;
                targetFileLabel.innerText = file.name;
                archivePasswordInput.value = '';
                passwordModal.style.display = 'flex';
                archivePasswordInput.focus();
            };
            fileGrid.appendChild(card);
        });
    } catch (err) {
        logToScreen(`[API_ERR_02] Network/API Error: ${err.message}`, true);
    }
}

// 2. Cryptographic Unlock & Tail Fetch
submitPwdBtn.onclick = async () => {
    const password = archivePasswordInput.value;
    if (!password) return alert("Password required.");
    
    submitPwdBtn.innerText = "Decrypting Header...";
    submitPwdBtn.disabled = true;
    logToScreen(`Initializing decryption sequence for ${pendingFile.name}...`);

    try {
        logToScreen("Fetching 7z End-Of-File metadata...");
        const tailRes = await fetch(`https://www.googleapis.com/drive/v3/files/${pendingFile.id}?alt=media`, {
            headers: { 
                'Authorization': `Bearer ${oauthToken}`,
                'Range': `bytes=-32768` // Fetch last 32KB
            }
        });

        if (!tailRes.ok) throw new Error(`Failed to fetch archive tail (Status: ${tailRes.status})`);
        
        logToScreen("Metadata retrieved. Handoff to stream processor...");
        
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'UNLOCK_FILE',
                fileId: pendingFile.id,
                password: password,
                fileSize: pendingFile.size
            });
        }

        passwordModal.style.display = 'none';
        submitPwdBtn.innerText = "Unlock & Stream";
        submitPwdBtn.disabled = false;
        
        openPlayer(pendingFile.id, pendingFile.name);

    } catch (err) {
        logToScreen(`Header Decryption Failed: ${err.message}`, true);
        submitPwdBtn.innerText = "Unlock & Stream";
        submitPwdBtn.disabled = false;
    }
};

document.getElementById('cancel-password').onclick = () => {
    passwordModal.style.display = 'none';
    pendingFile = null;
};

// 3. Launch Video Player
function openPlayer(fileId, filename) {
    playingTitle.innerText = filename;
    
    const streamUrl = `./vault-stream/${fileId}?filename=${encodeURIComponent(filename)}`;

    currentVideo = document.createElement('video');
    currentVideo.controls = true;
    currentVideo.autoplay = true;
    currentVideo.style.width = '100%';
    currentVideo.style.height = '100%';
    currentVideo.src = streamUrl;

    currentVideo.onerror = () => {
        logToScreen(`[DEC_ERR_04] Video element playback error. Stream interrupted or format unsupported.`, true);
    };

    videoContainer.innerHTML = '';
    videoContainer.appendChild(currentVideo);
    videoModal.style.display = 'flex';
}

closeModal.onclick = () => {
    if (currentVideo) {
        currentVideo.pause();
        currentVideo.removeAttribute('src');
        currentVideo.load();
        currentVideo.remove();
        currentVideo = null;
    }
    videoContainer.innerHTML = '';
    videoModal.style.display = 'none';
    logToScreen("Stream closed.");
};
