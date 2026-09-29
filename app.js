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

window.onload = async function () {
    logToScreen("System Booting...");
    await initEngine();

    let tokenClient;
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                logToScreen("OAuth Success. Tunneling token to vault...");
                if (response.error || !response.access_token) return logToScreen("Auth failed.", true);
                
                oauthToken = response.access_token;
                
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'INIT_VAULT', token: oauthToken });
                }

                loginScreen.style.display = 'none';
                driveUi.style.display = 'block';
                statusText.innerText = "Vault Connected";
                loadDriveFiles();
            }
        });
    } catch (err) {
        logToScreen(`Client Error: ${err.message}`, true);
    }

    authBtn.onclick = () => tokenClient.requestAccessToken({ prompt: 'select_account' });
};

async function loadDriveFiles() {
    logToScreen("Scanning Drive for Encrypted Archives...");
    try {
        const query = encodeURIComponent("name contains '.7z' and trashed = false");
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)&pageSize=100`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        const data = await res.json();
        fileGrid.innerHTML = '';

        if (!data.files || data.files.length === 0) return logToScreen("No .7z files found.", true);

        logToScreen(`Found ${data.files.length} protected archives.`);
        data.files.forEach(file => {
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
        logToScreen(`API Error: ${err.message}`, true);
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
        // Step A: Fetch the END of the file from Google Drive to read the 7z Header
        // 7z headers are typically in the last 32KB
        logToScreen("Fetching 7z End-Of-File metadata...");
        const tailRes = await fetch(`https://www.googleapis.com/drive/v3/files/${pendingFile.id}?alt=media`, {
            headers: { 
                'Authorization': `Bearer ${oauthToken}`,
                'Range': `bytes=-32768` // Fetch last 32KB
            }
        });

        if (!tailRes.ok) throw new Error("Failed to fetch archive tail.");
        
        // Pass the credentials to the Service Worker for the live stream
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
    
    // The stream goes through the SW tunnel
    const streamUrl = `./vault-stream/${fileId}?filename=${encodeURIComponent(filename)}`;

    currentVideo = document.createElement('video');
    currentVideo.controls = true;
    currentVideo.autoplay = true;
    currentVideo.style.width = '100%';
    currentVideo.style.height = '100%';
    currentVideo.src = streamUrl;

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
