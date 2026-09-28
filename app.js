const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
let oauthToken = null;

const statusText = document.getElementById('status-text');
const authBtn = document.getElementById('auth-btn');
const debugConsole = document.getElementById('debug-console');

function logToScreen(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
    const color = isError ? '#ff4444' : '#00ff00';
    debugConsole.innerHTML += `<div style="color: ${color}">[${time}] ${msg}</div>`;
    debugConsole.scrollTop = debugConsole.scrollHeight;
}

window.onload = function () {
    logToScreen("System Booting...");

    // 1. Check if Hugging Face is severing popup communication
    if (window.crossOriginIsolated) {
        logToScreen("WARNING: Hugging Face has COOP/COEP isolation enabled. Browser may block popup postMessage.", true);
    } else {
        logToScreen("Browser environment clean (COOP isolation inactive).");
    }

    // 2. Initialize Google Identity Services
    let tokenClient;
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                logToScreen("OAuth Response received from Google!");
                authBtn.disabled = false;
                authBtn.innerText = "Login with Google";

                if (response.error) {
                    logToScreen(`Google Error: ${response.error} - ${response.error_description || ''}`, true);
                    return;
                }

                if (!response.access_token) {
                    logToScreen("No access token in response. Did you check the Drive permission box?", true);
                    return;
                }

                oauthToken = response.access_token;
                logToScreen("Token acquired successfully! Switching view...");
                
                document.getElementById('login-screen').style.display = 'none';
                document.getElementById('drive-ui').style.display = 'block';
                statusText.innerText = "Authenticated";

                loadDriveFiles();
            },
            error_callback: (err) => {
                authBtn.disabled = false;
                authBtn.innerText = "Login with Google";
                logToScreen(`GIS Client Error: ${err.type} - ${err.message || ''}`, true);
            }
        });

        logToScreen("Google Identity Client ready.");
        statusText.innerText = "Ready to Login";

    } catch (err) {
        logToScreen(`Failed to init Google Client: ${err.message}`, true);
        return;
    }

    // 3. Single-Click Protected Login Trigger
    authBtn.onclick = () => {
        authBtn.disabled = true;
        authBtn.innerText = "Authorizing (Check Popup)...";
        logToScreen("Opening Google Login popup. Complete prompt in the popup window...");
        
        tokenClient.requestAccessToken({ prompt: 'select_account' });
    };
};

// 4. Fetch Drive Files
async function loadDriveFiles() {
    logToScreen("Querying Google Drive API...");
    try {
        const query = encodeURIComponent("name contains '.7z' and trashed = false");
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)`, {
            headers: { 'Authorization': `Bearer ${oauthToken}` }
        });

        if (!res.ok) {
            logToScreen(`Drive API Error: ${res.status} ${res.statusText}`, true);
            return;
        }

        const data = await res.json();
        const fileGrid = document.getElementById('file-grid');
        fileGrid.innerHTML = '';

        if (!data.files || data.files.length === 0) {
            logToScreen("Connected to Drive, but no .7z files found.", true);
            return;
        }

        logToScreen(`Success: Found ${data.files.length} archive(s).`);

        data.files.forEach(file => {
            const sizeMB = file.size ? Math.round(file.size / 1024 / 1024) : 'Unknown';
            const card = document.createElement('div');
            card.className = 'file-card';
            card.innerHTML = `<div class="file-icon">📦</div><div><strong>${file.name}</strong><br><small>${sizeMB} MB</small></div>`;
            card.onclick = () => logToScreen(`Selected: ${file.name}`);
            fileGrid.appendChild(card);
        });
    } catch (err) {
        logToScreen(`Fetch exception: ${err.message}`, true);
    }
}
