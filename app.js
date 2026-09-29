const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';
const UI = {
    btn: document.getElementById('authBtn'),
    status: document.getElementById('statusBox'),
    list: document.getElementById('fileList'),
    playerWrap: document.getElementById('playerWrapper'),
    video: document.getElementById('videoPlayer'),
    title: document.getElementById('videoTitle')
};

let tokenClient;
let driveToken = '';

// --- BOOT SEQUENCE ---
window.onload = async () => {
    UI.status.innerText = "Registering Decryption Engine (sw.js)...";
    
    try {
        // 1. Boot Service Worker
        if ('serviceWorker' in navigator) {
            await navigator.serviceWorker.register('sw.js');
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller) {
                window.location.reload(); // Force SW takeover
            }
        }

        // 2. Wait for Google Script to load
        let checks = 0;
        const waitForGoogle = setInterval(() => {
            if (typeof google !== 'undefined') {
                clearInterval(waitForGoogle);
                initLoginSystem();
            } else if (checks > 20) {
                clearInterval(waitForGoogle);
                UI.status.innerHTML = "<span class='text-red-500'>Google Auth failed to load. Turn off Adblocker.</span>";
            }
            checks++;
        }, 100);

    } catch (err) {
        UI.status.innerHTML = `<span class="text-red-500">Boot Error: ${err.message}</span>`;
    }
};

// --- LOGIN SYSTEM ---
function initLoginSystem() {
    UI.status.innerText = "Engine ready. Click 'Connect Google Drive'.";
    
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: (response) => {
            if (response.error) {
                UI.status.innerText = `Login failed: ${response.error}`;
                return;
            }
            driveToken = response.access_token;
            UI.btn.innerText = "Connected";
            UI.btn.classList.replace('bg-blue-600', 'bg-green-600');
            
            // Send token to Service Worker
            navigator.serviceWorker.controller.postMessage({ type: 'SYNC_TOKEN', token: driveToken });
            
            fetchFiles();
        }
    });

    UI.btn.addEventListener('click', () => {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    });
}

// --- FILE MANAGER ---
async function fetchFiles() {
    UI.status.innerText = "Scanning Drive for .zip files...";
    UI.list.innerHTML = '';

    try {
        const query = encodeURIComponent(`name contains '.zip' and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)`, {
            headers: { 'Authorization': `Bearer ${driveToken}` }
        });

        if (!res.ok) throw new Error("API Request Failed");
        const data = await res.json();

        if (data.files.length === 0) {
            UI.status.innerText = "No .zip files found in your Google Drive.";
            return;
        }

        UI.status.innerText = `Found ${data.files.length} encrypted archives.`;

        data.files.forEach(file => {
            const btn = document.createElement('button');
            btn.className = "p-4 bg-slate-800 hover:bg-slate-700 rounded text-left border border-slate-600 transition-colors";
            btn.innerHTML = `<strong class="block truncate">${file.name}</strong><span class="text-xs text-slate-400">Click to unlock</span>`;
            
            btn.onclick = () => {
                const pass = prompt(`Enter AES-256 password for:\n${file.name}`);
                if (pass) startDecryption(file, pass);
            };
            
            UI.list.appendChild(btn);
        });

    } catch (err) {
        UI.status.innerHTML = `<span class="text-red-500">Scan Error: ${err.message}</span>`;
    }
}

// --- START STREAM ---
function startDecryption(file, password) {
    // Send password to SW
    navigator.serviceWorker.controller.postMessage({ 
        type: 'UNLOCK', 
        fileId: file.id, 
        password: password 
    });

    // Setup Video Player
    UI.title.innerText = `Decrypting: ${file.name}`;
    UI.playerWrap.classList.remove('hidden');
    
    // Connect video to the SW stream interceptor
    UI.video.src = `/stream-vault/${file.id}`;
    UI.video.play().catch(e => console.log("Press play manually."));
    
    window.scrollTo(0, 0);
}
