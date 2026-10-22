const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 20,
  reconnectionDelay: 1000
});

let currentUser = null, isSignup = false, currentStream = null, peer = null, incomingData = null, activeChatUser = null;
let groupPeers = {};

// STUN Servers (Mobile Data Cellular 4G/5G fi WiFi irratti akka walqunnaman gargaaru)
const iceServersConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function getActiveRingtone() {
  const style = document.getElementById('ring-style-select')?.value || 'classic';
  if(style === 'modern') return document.getElementById('ring-modern');
  if(style === 'soft') return document.getElementById('ring-soft');
  return document.getElementById('ring-classic');
}

function toggleAuthMode() {
  isSignup = !isSignup;
  document.getElementById('auth-title').innerText = isSignup ? 'Signup' : 'Login';
  document.getElementById('auth-btn').innerText = isSignup ? 'Signup' : 'Login';
}

async function handleAuth() {
  const username = document.getElementById('auth-username').value;
  const password = document.getElementById('auth-password').value;
  const phone = document.getElementById('auth-phone').value;
  const bio = document.getElementById('auth-bio').value;

  const endpoint = isSignup ? '/api/auth/signup' : '/api/auth/login';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, phone, bio })
  });

  const data = await res.json();
  if(!data.success) return alert(data.message);

  currentUser = data.user;
  document.getElementById('auth-sec').style.display = 'none';
  document.getElementById('app-sec').style.display = 'block';

  document.getElementById('user-head-sec').innerHTML = `<b>@${currentUser.username}</b> <button onclick="location.reload()" class="btn btn-danger" style="width:auto; padding:5px;">Logout</button>`;

  socket.emit('register-user', currentUser.username);
  loadPosts();
}

socket.on('missed-calls-notification', missedList => {
  const banner = document.getElementById('notification-banner');
  if(!banner) return;
  banner.style.display = 'block';
  let txt = '<b>🔔 Missed Calls (Yeroo offline turtan):</b><ul>';
  missedList.forEach(m => {
    txt += `<li>@${m.caller} irraa ${m.call_type} call dhufeera (${m.created_at})</li>`;
  });
  txt += '</ul>';
  banner.innerHTML = txt;
});

socket.on('update-user-list', users => {
  const container = document.getElementById('users-list');
  if(!container) return;
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

// GROUP CHAT (Media support: Suuraa, Sagalee, Vidiyoo)
function sendGroupMessage() {
  const input = document.getElementById('group-msg-input');
  const fileInput = document.getElementById('group-media-input');
  const message = input.value.trim();
  const file = fileInput.files[0];

  if (file) {
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
      socket.emit('group-chat-message', { sender: currentUser.username, message, mediaUrl: e.target.result, mediaType: type });
      input.value = '';
      fileInput.value = '';
    };
    reader.readAsDataURL(file);
  } else if (message) {
    socket.emit('group-chat-message', { sender: currentUser.username, message });
    input.value = '';
  }
}

socket.on('group-chat-message', data => {
  const box = document.getElementById('group-chat-box');
  let mediaTag = '';
  if(data.media_type === 'image') mediaTag = `<br><img src="${data.media_url}" style="max-width:150px; border-radius:5px;">`;
  if(data.media_type === 'video') mediaTag = `<br><video src="${data.media_url}" controls style="max-width:150px;"></video>`;
  if(data.media_type === 'audio') mediaTag = `<br><audio src="${data.media_url}" controls></audio>`;

  box.innerHTML += `<div><b>@${data.sender}:</b> ${data.message || ''} ${mediaTag}</div>`;
  box.scrollTop = box.scrollHeight;
});

// PRIVATE CHAT (Media support: Suuraa, Sagalee, Vidiyoo)
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
  const fileInput = document.getElementById('private-media-input');
  const message = input.value.trim();
  const file = fileInput.files[0];

  if (!activeChatUser) return;

  if (file) {
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
      socket.emit('private-message', { sender: currentUser.username, receiver: activeChatUser, message, mediaUrl: e.target.result, mediaType: type });
      
      let mediaTag = type === 'image' ? `<img src="${e.target.result}" style="max-width:150px;">` : type === 'video' ? `<video src="${e.target.result}" controls style="max-width:150px;"></video>` : `<audio src="${e.target.result}" controls></audio>`;
      const box = document.getElementById('private-chat-box');
      box.innerHTML += `<div style="text-align:right;"><b>Ani:</b> ${message || ''} <br> ${mediaTag}</div>`;
      box.scrollTop = box.scrollHeight;
      input.value = '';
      fileInput.value = '';
    };
    reader.readAsDataURL(file);
  } else if (message) {
    socket.emit('private-message', { sender: currentUser.username, receiver: activeChatUser, message });
    const box = document.getElementById('private-chat-box');
    box.innerHTML += `<div style="text-align:right;"><b>Ani:</b> ${message}</div>`;
    box.scrollTop = box.scrollHeight;
    input.value = '';
  }
}

socket.on('private-message', data => {
  let mediaTag = '';
  if(data.media_type === 'image') mediaTag = `<br><img src="${data.media_url}" style="max-width:150px;">`;
  if(data.media_type === 'video') mediaTag = `<br><video src="${data.media_url}" controls style="max-width:150px;"></video>`;
  if(data.media_type === 'audio') mediaTag = `<br><audio src="${data.media_url}" controls></audio>`;

  if (activeChatUser === data.sender) {
    const box = document.getElementById('private-chat-box');
    box.innerHTML += `<div><b>@${data.sender}:</b> ${data.message || ''} ${mediaTag}</div>`;
    box.scrollTop = box.scrollHeight;
  } else {
    alert(`Ergaa haaraan @${data.sender} irraa dhufeera!`);
  }
});

// CALL ENGINE (STUN Server waliin qindaa'e)
async function startCall(userToCall, isVideo) {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo ? { width: { ideal: 480 }, height: { ideal: 360 } } : false });
    const grid = document.getElementById('video-grid');
    grid.innerHTML = `<video id="local-video" autoplay muted></video><video id="remote-video" autoplay></video>`;
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';

    peer = new SimplePeer({ initiator: true, trickle: false, stream: currentStream, config: iceServersConfig });
    peer.on('signal', signalData => {
      socket.emit('call-user', { userToCall, signalData, callerName: currentUser.username, isVideo, ringStyle: document.getElementById('ring-style-select')?.value });
    });
    peer.on('stream', remoteStream => { document.getElementById('remote-video').srcObject = remoteStream; });
  } catch(e) { alert("Camera/Mic Permission barbaachisa!"); }
}

socket.on('incoming-call', data => {
  incomingData = data;
  document.getElementById('caller-name-txt').innerText = `${data.callerName} is calling...`;
  document.getElementById('call-modal').style.display = 'flex';
  
  // Ringtone browser policy darbuuf user interaction eega
  const ring = getActiveRingtone();
  if(ring) {
    ring.play().catch(err => {
      console.log("Audio autoplay restricted by browser:", err);
    });
  }
});

async function acceptCall() {
  const ring = getActiveRingtone();
  if(ring) ring.pause();
  document.getElementById('call-modal').style.display = 'none';
  document.getElementById('call-screen').style.display = 'block';

  currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: incomingData.isVideo ? { width: { ideal: 480 }, height: { ideal: 360 } } : false });
  const grid = document.getElementById('video-grid');
  grid.innerHTML = `<video id="local-video" autoplay muted></video><video id="remote-video" autoplay></video>`;
  document.getElementById('local-video').srcObject = currentStream;

  peer = new SimplePeer({ initiator: false, trickle: false, stream: currentStream, config: iceServersConfig });
  peer.on('signal', signal => socket.emit('accept-call', { signal, to: incomingData.from }));
  peer.on('stream', remoteStream => { document.getElementById('remote-video').srcObject = remoteStream; });
  peer.signal(incomingData.signal);
}

function rejectCall() {
  const ring = getActiveRingtone();
  if(ring) ring.pause();
  document.getElementById('call-modal').style.display = 'none';
  socket.emit('reject-call', { to: incomingData.from });
}

socket.on('call-accepted', signal => { if(peer) peer.signal(signal); });
socket.on('call-failed-offline', () => { alert("Maammilli offline waan ta'eef bilbilamuu hin dandeenye (Missed Call galmaa'eera)."); endCall(); });

async function startGroupCall() {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const grid = document.getElementById('video-grid');
    grid.innerHTML = `<video id="local-video" autoplay muted></video>`;
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';
    socket.emit('join-group-call');
  } catch(e) { alert("Camera/Mic feedhi barbaachisa!"); }
}

socket.on('user-joined-group', userId => {
  if(!currentStream) return;
  const p = new SimplePeer({ initiator: true, trickle: false, stream: currentStream, config: iceServersConfig });
  p.on('signal', signal => socket.emit('group-signal', { signal, to: userId }));
  p.on('stream', remoteStream => {
    let vid = document.getElementById(`remote-${userId}`);
    if(!vid) {
      vid = document.createElement('video');
      vid.id = `remote-${userId}`;
      vid.autoplay = true;
      document.getElementById('video-grid').appendChild(vid);
    }
    vid.srcObject = remoteStream;
  });
  groupPeers[userId] = p;
});

socket.on('group-signal', data => {
  if(!currentStream) return;
  let p = groupPeers[data.from];
  if(!p) {
    p = new SimplePeer({ initiator: false, trickle: false, stream: currentStream, config: iceServersConfig });
    p.on('signal', signal => socket.emit('group-signal', { signal, to: data.from }));
    p.on('stream', remoteStream => {
      let vid = document.getElementById(`remote-${data.from}`);
      if(!vid) {
        vid = document.createElement('video');
        vid.id = `remote-${data.from}`;
        vid.autoplay = true;
        document.getElementById('video-grid').appendChild(vid);
      }
      vid.srcObject = remoteStream;
    });
    groupPeers[data.from] = p;
  }
  p.signal(data.signal);
});

socket.on('user-left-group', userId => {
  if(groupPeers[userId]) { groupPeers[userId].destroy(); delete groupPeers[userId]; }
  const vid = document.getElementById(`remote-${userId}`);
  if(vid) vid.remove();
});

function endCall() {
  if (peer) { peer.destroy(); peer = null; }
  Object.values(groupPeers).forEach(p => p.destroy());
  groupPeers = {};
  socket.emit('leave-group-call');
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
  document.getElementById('call-screen').style.display = 'none';
}

function submitPost() {
  const content = document.getElementById('post-text').value;
  const fileInput = document.getElementById('post-file');
  const file = fileInput.files[0];

  if (file) {
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : 'image';
      socket.emit('create-post', { username: currentUser.username, content, mediaUrl: e.target.result, mediaType: type });
      alert("Post-n keessan ergameera.");
      document.getElementById('post-text').value = '';
      fileInput.value = '';
    };
    reader.readAsDataURL(file);
  } else {
    socket.emit('create-post', { username: currentUser.username, content });
    alert("Post-n keessan ergameera.");
    document.getElementById('post-text').value = '';
  }
}

async function loadPosts() {
  const res = await fetch('/api/posts');
  const posts = await res.json();
  const feed = document.getElementById('feed-container');
  feed.innerHTML = '';
  posts.forEach(p => {
    feed.innerHTML += `
      <div class="post">
        <b>@${p.username}</b>
        <p>${p.content || ''}</p>
        ${p.media_type === 'image' ? `<img src="${p.media_url}">` : ''}
        ${p.media_type === 'video' ? `<video src="${p.media_url}" controls></video>` : ''}
      </div>`;
  });
}
