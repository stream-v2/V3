const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
let oauthToken = null;

const statusText = document.getElementById('status-text');
const authBtn = document.getElementById('auth-btn');
const loginScreen = document.getElementById('login-screen');
const driveUi = document.getElementById('drive-ui');
const fileGrid = document.getElementById('file-grid');
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

// 1. Initialize Service Worker
async function initEngine() {
    try {
        logToScreen("Registering Service Worker...");
        const reg = await navigator.serviceWorker.register('./sw.js');
        await navigator.serviceWorker.ready;
        logToScreen("Service Worker registered and ready.");
        return true;
    } catch (err) {
        logToScreen(`SW Registration Failed: ${err.message}`, true);
        return false;
    }
}

// 2. Google OAuth Initialization
window.onload = async function () {
    logToScreen("System Booting...");
    await initEngine();

    let tokenClient;
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                logToScreen("OAuth response received.");
                authBtn.disabled = false;
                authBtn.innerText = "Login with Google";

                if (response.error) {
                    logToScreen(`OAuth Error: ${response.error}`, true);
                    return;
                }

                if (!response.access_token) {
                    logToScreen("Missing access token in response.", true);
                    return;
                }

                oauthToken = response.access_token;
                logToScreen("Token saved. Handing off to Service Worker...");

                // Transmit token to SW
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({
                        type: 'INIT_VAULT',
                        token: oauthToken
                    });
                }

                loginScreen.style.display = 'none';
                driveUi.style.display = 'block';
                statusText.innerText = "Connected";

                loadDriveFiles();
            },
            error_callback: (err) => {
                authBtn.disabled = false;
                authBtn.innerText = "Login with Google";
                logToScreen(`GIS Client Error: ${err.type}`, true);
            }
        });

        statusText.innerText = "Ready to Login";
    } catch (err) {
        logToScreen(`Failed to init Google Client: ${err.message}`, true);
        return;
    }

    authBtn.onclick = () => {
        authBtn.disabled = true;
        authBtn.innerText = "Authorizing...";
        logToScreen("Opening login popup...");
        tokenClient.requestAccessToken({ prompt: 'select_account' });
    };
};

// 3. Load Drive Files
async function loadDriveFiles() {
    logToScreen("Querying Google Drive API for .7z files...");
    try {
        const query = encodeURIComponent("name contains '.7z' and trashed = false");
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)&pageSize=100`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) {
            logToScreen(`Drive API Error: ${res.status} ${res.statusText}`, true);
            return;
        }

        const data = await res.json();
        fileGrid.innerHTML = '';

        if (!data.files || data.files.length === 0) {
            logToScreen("No .7z files found in Drive.", true);
            return;
        }

        logToScreen(`Populating grid with ${data.files.length} archive(s)...`);

        data.files.forEach(file => {
            const sizeMB = file.size ? Math.round(file.size / 1024 / 1024) : 'Unknown';
            const card = document.createElement('div');
            card.className = 'file-card';
            card.innerHTML = `<strong>${file.name}</strong><small>${sizeMB} MB</small>`;
            card.onclick = () => openPlayer(file.id, file.name);
            fileGrid.appendChild(card);
        });
    } catch (err) {
        logToScreen(`Drive query exception: ${err.message}`, true);
    }
}

// 4. Open Player & Route Through SW
function openPlayer(fileId, filename) {
    logToScreen(`Opening player for: ${filename} (ID: ${fileId})`);
    playingTitle.innerText = filename;

    // Service Worker intercepts relative paths ending in /vault-stream/<fileId>
    const streamUrl = `./vault-stream/${fileId}?filename=${encodeURIComponent(filename)}`;

    currentVideo = document.createElement('video');
    currentVideo.controls = true;
    currentVideo.autoplay = true;
    currentVideo.style.width = '100%';
    currentVideo.style.height = '100%';
    currentVideo.src = streamUrl;

    currentVideo.onerror = (e) => {
        logToScreen(`Video element playback error: ${currentVideo.error ? currentVideo.error.message : 'Unknown'}`, true);
    };

    videoContainer.innerHTML = '';
    videoContainer.appendChild(currentVideo);
    videoModal.style.display = 'flex';
}

// 5. Cleanup On Close
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
    logToScreen("Player closed. Video stream released.");
};
