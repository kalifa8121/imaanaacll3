const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 20,
  reconnectionDelay: 1000
});

let currentUser = null, isSignup = false, currentStream = null, peer = null, incomingData = null, activeChatUser = null;
let mediaRecorder = null, audioChunks = [];

// Mobile cellular network (STUN Server)
const iceServersConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// Web Audio API Ringtone Generator (Mobile Chrome Autoplay bypass)
let audioCtx = null;
let ringInterval = null;

function playRingtone() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  function triggerBeep() {
    if (!audioCtx) return;
    let osc = audioCtx.createOscillator();
    let gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.8);
  }

  triggerBeep();
  ringInterval = setInterval(triggerBeep, 1600);
}

function stopRingtone() {
  if (ringInterval) clearInterval(ringInterval);
  ringInterval = null;
}

document.body.addEventListener('click', () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });

function toggleAuthMode() {
  isSignup = !isSignup;
  document.getElementById('auth-title').innerText = isSignup ? 'Signup' : 'Login';
  document.getElementById('auth-btn').innerText = isSignup ? 'Signup' : 'Login';
}

async function handleAuth() {
  const username = document.getElementById('auth-username').value;
  const password = document.getElementById('auth-password').value;

  const endpoint = isSignup ? '/api/auth/signup' : '/api/auth/login';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if(!data.success) return alert(data.message);

  currentUser = data.user;
  document.getElementById('auth-sec').style.display = 'none';
  document.getElementById('app-sec').style.display = 'block';
  document.getElementById('user-head-sec').innerHTML = `<b>@${currentUser.username}</b> <button onclick="location.reload()" class="btn btn-danger" style="width:auto; padding:5px;">Logout</button>`;

  socket.emit('register-user', currentUser.username);
}

socket.on('update-user-list', users => {
  const container = document.getElementById('users-list');
  container.innerHTML = '';
  users.filter(u => u.username !== currentUser.username).forEach(u => {
    container.innerHTML += `
      <div class="user-list-item">
        <div>
          <span class="status-dot ${u.isOnline ? 'online' : 'offline'}"></span>
          <b>@${u.username}</b>
        </div>
        <div>
          <button class="btn btn-primary" style="width:auto; padding:5px;" onclick="openPrivateChat('${u.username}')">Chat 💬</button>
          ${u.isOnline ? `
            <button class="btn btn-green" style="width:auto; padding:5px;" onclick="startCall('${u.username}', false)">Voice 📞</button>
            <button class="btn btn-primary" style="width:auto; padding:5px;" onclick="startCall('${u.username}', true)">Video 📹</button>
          ` : '<small>Offline</small>'}
        </div>
      </div>`;
  });
});

// PRIVATE CHAT & MEDIA SHARING
function openPrivateChat(username) {
  activeChatUser = username;
  document.getElementById('private-chat-title').innerText = `Chat @${username} wajjin`;
  document.getElementById('private-chat-section').style.display = 'block';
  document.getElementById('private-chat-box').innerHTML = '';
}

function closePrivateChat() {
  activeChatUser = null;
  document.getElementById('private-chat-section').style.display = 'none';
}

function sendPrivateMessage() {
  const input = document.getElementById('private-msg-input');
  const message = input.value.trim();
  if(!message || !activeChatUser) return;

  socket.emit('private-message', { sender: currentUser.username, receiver: activeChatUser, message });
  appendMessage('Ani', message);
  input.value = '';
}

function sendPrivateFile() {
  const fileInput = document.getElementById('private-file-input');
  const file = fileInput.files[0];
  if (!file || !activeChatUser) return;

  const reader = new FileReader();
  reader.onload = e => {
    const mediaType = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
    socket.emit('private-message', { sender: currentUser.username, receiver: activeChatUser, mediaUrl: e.target.result, mediaType });
    appendMedia('Ani', e.target.result, mediaType);
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
}

// VOICE RECORDER
async function toggleVoiceRecord() {
  const btn = document.getElementById('rec-btn');
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    btn.classList.remove('rec-active');
    btn.innerText = "🎙️ Audio Record";
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = e => {
          socket.emit('private-message', { sender: currentUser.username, receiver: activeChatUser, mediaUrl: e.target.result, mediaType: 'audio' });
          appendMedia('Ani', e.target.result, 'audio');
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorder.start();
      btn.classList.add('rec-active');
      btn.innerText = "🛑 Stop & Send";
    } catch(e) { alert("Microphone Permission Gaafatamaa!"); }
  }
}

socket.on('private-message', data => {
  if (activeChatUser === data.sender) {
    if (data.mediaUrl) {
      appendMedia(`@${data.sender}`, data.mediaUrl, data.mediaType);
    } else {
      appendMessage(`@${data.sender}`, data.message);
    }
  } else {
    alert(`Ergaa haaraan @${data.sender} irraa dhufeera!`);
  }
});

function appendMessage(sender, msg) {
  const box = document.getElementById('private-chat-box');
  box.innerHTML += `<div><b>${sender}:</b> ${msg}</div>`;
  box.scrollTop = box.scrollHeight;
}

function appendMedia(sender, url, type) {
  const box = document.getElementById('private-chat-box');
  let tag = type === 'image' ? `<img src="${url}" style="max-width:180px; border-radius:5px;">` : type === 'video' ? `<video src="${url}" controls style="max-width:180px;"></video>` : `<audio src="${url}" controls></audio>`;
  box.innerHTML += `<div><b>${sender}:</b><br>${tag}</div>`;
  box.scrollTop = box.scrollHeight;
}

// CELLULAR DATA OPTIMIZED WEBRTC CALL ENGINE
async function startCall(userToCall, isVideo) {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ 
      audio: true, 
      video: isVideo ? { width: { ideal: 480 }, height: { ideal: 360 } } : false 
    });
    
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';

    peer = new SimplePeer({ 
      initiator: true, 
      trickle: false, 
      stream: currentStream,
      config: iceServersConfig
    });

    peer.on('signal', signalData => {
      socket.emit('call-user', { userToCall, signalData, callerName: currentUser.username, isVideo });
    });

    peer.on('stream', remoteStream => {
      document.getElementById('remote-video').srcObject = remoteStream;
    });
  } catch(e) { alert("Camera/Microphone Permission Gaafatamaa!"); }
}

socket.on('incoming-call', data => {
  incomingData = data;
  document.getElementById('caller-name-txt').innerText = `${data.callerName} is calling...`;
  document.getElementById('call-modal').style.display = 'flex';
  playRingtone();
});

async function acceptCall() {
  stopRingtone();
  document.getElementById('call-modal').style.display = 'none';
  document.getElementById('call-screen').style.display = 'block';

  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ 
      audio: true, 
      video: incomingData.isVideo ? { width: { ideal: 480 }, height: { ideal: 360 } } : false 
    });
    document.getElementById('local-video').srcObject = currentStream;

    peer = new SimplePeer({ 
      initiator: false, 
      trickle: false, 
      stream: currentStream,
      config: iceServersConfig
    });

    peer.on('signal', signal => socket.emit('accept-call', { signal, to: incomingData.from }));
    peer.on('stream', remoteStream => {
      document.getElementById('remote-video').srcObject = remoteStream;
    });

    peer.signal(incomingData.signal);
  } catch(e) { alert("Camera/Microphone access needed!"); }
}

function rejectCall() {
  stopRingtone();
  document.getElementById('call-modal').style.display = 'none';
  socket.emit('reject-call', { to: incomingData.from });
}

socket.on('call-accepted', signal => { if(peer) peer.signal(signal); });
socket.on('call-failed-offline', () => { alert("Maammilli offline waan ta'eef bilbilamuu hin dandeenye."); endCall(); });

function endCall() {
  stopRingtone();
  if (peer) { peer.destroy(); peer = null; }
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  document.getElementById('call-screen').style.display = 'none';
}
