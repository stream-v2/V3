const CLIENT_ID = '185170823583-t1g2t509cd1ogbhj9i9ctjb1rk9mpu8q.apps.googleusercontent.com';

const UI = {
    btn: document.getElementById('authBtn'),
    status: document.getElementById('statusBox'),
    list: document.getElementById('fileList'),
    playerWrap: document.getElementById('playerWrapper'),
    video: document.getElementById('videoPlayer'),
    title: document.getElementById('videoTitle'),
    term: document.getElementById('debugTerminal')
};

let tokenClient;
let driveToken = '';

function sysLog(msg, isError = false) {
    const time = new Date().toLocaleTimeString();
    const color = isError ? 'text-red-500 font-bold' : 'text-green-400';
    UI.term.innerHTML += `<div class="${color}">[${time}] ${msg}</div>`;
    UI.term.scrollTop = UI.term.scrollHeight;
}

const logChannel = new BroadcastChannel('streamvault_logs');
logChannel.onmessage = (e) => sysLog(`[SW Engine] ${e.data.msg}`, e.data.isError);

window.onload = async () => {
    sysLog("App started. Registering Service Worker...");
    try {
        if ('serviceWorker' in navigator) {
            await navigator.serviceWorker.register('sw.js');
            await navigator.serviceWorker.ready;
            sysLog("Service worker registered successfully.");
            
            if (!navigator.serviceWorker.controller) {
                sysLog("Forcing Service Worker takeover. Reloading...");
                window.location.reload(); 
            }
        }

        sysLog("Waiting for Google Identity script...");
        let checks = 0;
        const waitForGoogle = setInterval(() => {
            if (typeof google !== 'undefined') {
                clearInterval(waitForGoogle);
                sysLog("Google API loaded. Login System Ready.");
                initLoginSystem();
            } else if (checks > 20) {
                clearInterval(waitForGoogle);
                sysLog("Google Auth failed to load. Check Adblocker.", true);
            }
            checks++;
        }, 100);
    } catch (err) {
        sysLog(`Boot Error: ${err.message}`, true);
    }
};

function initLoginSystem() {
    UI.status.innerText = "Ready.";
    
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: (response) => {
            if (response.error) {
                sysLog(`Google Login failed: ${response.error}`, true);
                return;
            }
            driveToken = response.access_token;
            sysLog("Google Auth Token received.");
            
            UI.btn.innerText = "Connected";
            UI.btn.classList.replace('bg-blue-600', 'bg-green-600');
            
            sysLog("Syncing token to Decryption Engine...");
            navigator.serviceWorker.controller.postMessage({ type: 'SYNC_TOKEN', token: driveToken });
            
            fetchFiles();
        }
    });

    UI.btn.addEventListener('click', () => {
        sysLog("Requesting Google Login prompt...");
        tokenClient.requestAccessToken({ prompt: 'consent' });
    });
}

async function fetchFiles() {
    sysLog("Scanning Google Drive for encrypted .zip files...");
    UI.list.innerHTML = '';

    try {
        const query = encodeURIComponent(`name contains '.zip' and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size)`, {
            headers: { 'Authorization': `Bearer ${driveToken}` }
        });

        if (!res.ok) throw new Error(`Google API responded with status ${res.status}`);
        const data = await res.json();

        sysLog(`Found ${data.files.length} encrypted archives in your Drive.`);

        data.files.forEach(file => {
            const btn = document.createElement('button');
            btn.className = "p-4 bg-slate-800 hover:bg-slate-700 rounded text-left border border-slate-600 transition-colors flex flex-col justify-between";
            
            // UI FIX: Replaced "truncate" with "break-words" so long names wrap perfectly!
            btn.innerHTML = `
                <strong class="block text-sm break-words leading-snug mb-2 text-slate-100">${file.name}</strong>
                <span class="text-xs font-bold text-blue-400 bg-blue-900/30 px-2 py-1 rounded w-fit">Click to Unlock</span>
            `;
            
            btn.onclick = () => {
                const pass = prompt(`Enter AES-256 password for:\n${file.name}`);
                if (pass) startDecryption(file, pass);
            };
            
            UI.list.appendChild(btn);
        });

    } catch (err) {
        sysLog(`Drive Scan Error: ${err.message}`, true);
    }
}

function startDecryption(file, password) {
    sysLog(`Preparing to unlock ${file.name}...`);
    
    navigator.serviceWorker.controller.postMessage({ 
        type: 'UNLOCK', 
        fileId: file.id, 
        password: password 
    });

    UI.title.innerText = file.name;
    UI.playerWrap.classList.remove('hidden');
    
    sysLog("Attaching stream to Video Player...");
    UI.video.src = `/stream-vault/${file.id}`;
    
    UI.video.onerror = () => sysLog("HTML5 Video Player refused the stream.", true);
    UI.video.onplaying = () => sysLog("VIDEO IS PLAYING SUCCESSFULLY!");
}
