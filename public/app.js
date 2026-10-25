const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000
});

let currentUser = null, isSignup = false;
let currentStream = null, peer = null, incomingData = null, activeChatUser = null;
let groupPeers = {};
let iceServersConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// === ICE servers (TURN) server irraa fe'i ===
async function loadIceServers() {
  try {
    const res = await fetch('/api/ice-servers');
    iceServersConfig = await res.json();
    console.log('ICE servers loaded:', iceServersConfig.iceServers.length);
  } catch (e) {
    console.error('ICE load failed:', e);
  }
}
loadIceServers();

// === Audio unlock (mobile ringtone) ===
function unlockAudioForMobile() {
  document.querySelectorAll('audio').forEach(a => {
    const wasMuted = a.muted;
    a.muted = true;
    a.play().then(() => {
      a.pause(); a.currentTime = 0; a.muted = wasMuted;
    }).catch(() => { a.muted = wasMuted; });
  });
}

function getActiveRingtone() {
  const style = document.getElementById('ring-style-select')?.value || 'classic';
  if (style === 'modern') return document.getElementById('ring-modern');
  if (style === 'soft')   return document.getElementById('ring-soft');
  return document.getElementById('ring-classic');
}

function stopRingtone() {
  document.querySelectorAll('audio').forEach(a => { a.pause(); a.currentTime = 0; });
}

function toggleAuthMode() {
  isSignup = !isSignup;
  document.getElementById('auth-title').innerText = isSignup ? 'Signup' : 'Login';
  document.getElementById('auth-btn').innerText = isSignup ? 'Signup' : 'Login';
}

// === Auth ===
async function handleAuth() {
  unlockAudioForMobile();   // user gesture → ringtone unlock

  const username = document.getElementById('auth-username').value.trim();
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
  if (!data.success) return alert(data.message);

  currentUser = data.user;
  document.getElementById('auth-sec').style.display = 'none';
  document.getElementById('app-sec').style.display = 'block';

  const adminLink = currentUser.is_admin
    ? `<a href="admin.html" style="color:orange;margin-left:8px;font-weight:bold">👑 Admin</a>` : '';

  document.getElementById('user-head-sec').innerHTML =
    `<b>@${currentUser.username}</b> ${adminLink}
     <button onclick="location.reload()" class="btn btn-danger" style="width:auto;padding:5px 10px;margin-left:5px">Logout</button>`;

  socket.emit('register-user', currentUser.username);
  loadPosts();
}

// === Missed calls notification ===
socket.on('missed-calls-notification', list => {
  const banner = document.getElementById('notification-banner');
  if (!banner) return;
  banner.style.display = 'block';
  let txt = '<b>🔔 Missed Calls (offline turtan):</b><ul>';
  list.forEach(m => { txt += `<li>@${m.caller} — ${m.call_type} (${m.created_at})</li>`; });
  banner.innerHTML = txt + '</ul>';
});

// === User list ===
socket.on('update-user-list', users => {
  const container = document.getElementById('users-list');
  if (!container || !currentUser) return;
  container.innerHTML = '';
  users.filter(u => u.username !== currentUser.username).forEach(u => {
    container.innerHTML += `
      <div class="user-list-item">
        <div>
          <span class="status-dot ${u.isOnline ? 'online' : 'offline'}"></span>
          <b>@${u.username}</b>
        </div>
        <div>
          <button class="btn btn-primary" style="width:auto;padding:6px 10px" onclick="openPrivateChat('${u.username}')">Chat 💬</button>
          ${u.isOnline ? `
            <button class="btn btn-green" style="width:auto;padding:6px 10px" onclick="startCall('${u.username}', false)">Voice 📞</button>
            <button class="btn btn-primary" style="width:auto;padding:6px 10px" onclick="startCall('${u.username}', true)">Video 📹</button>
          ` : '<small>Offline</small>'}
        </div>
      </div>`;
  });
});

// === Group chat ===
function sendGroupMessage() {
  const input = document.getElementById('group-msg-input');
  const fileInput = document.getElementById('group-media-input');
  const message = input.value.trim();
  const file = fileInput.files[0];

  if (file) {
    if (file.size > 20 * 1024 * 1024) return alert('File guddaa dha (max 20MB)');
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
      socket.emit('group-chat-message', { sender: currentUser.username, message, mediaUrl: e.target.result, mediaType: type });
      input.value = ''; fileInput.value = '';
    };
    reader.readAsDataURL(file);
  } else if (message) {
    socket.emit('group-chat-message', { sender: currentUser.username, message });
    input.value = '';
  }
}

socket.on('group-chat-message', data => {
  const box = document.getElementById('group-chat-box');
  let media = '';
  if (data.mediaType === 'image') media = `<br><img src="${data.mediaUrl}" style="max-width:150px;border-radius:5px">`;
  if (data.mediaType === 'video') media = `<br><video src="${data.mediaUrl}" controls playsinline style="max-width:150px"></video>`;
  if (data.mediaType === 'audio') media = `<br><audio src="${data.mediaUrl}" controls></audio>`;
  box.innerHTML += `<div><b>@${data.sender}:</b> ${data.message || ''} ${media}</div>`;
  box.scrollTop = box.scrollHeight;
});

// === Private chat ===
async function openPrivateChat(username) {
  activeChatUser = username;
  document.getElementById('private-chat-title').innerText = `Chat @${username}`;
  document.getElementById('private-chat-section').style.display = 'block';
  const box = document.getElementById('private-chat-box');
  box.innerHTML = '<i>Loading...</i>';

  try {
    const res = await fetch(`/api/messages/${currentUser.username}/${username}`);
    const msgs = await res.json();
    box.innerHTML = '';
    msgs.forEach(m => appendPrivateMsg(m.sender, m.message, m.media_url, m.media_type, m.sender === currentUser.username));
    box.scrollTop = box.scrollHeight;
  } catch { box.innerHTML = ''; }
}

function appendPrivateMsg(sender, message, mediaUrl, mediaType, isMine) {
  const box = document.getElementById('private-chat-box');
  let media = '';
  if (mediaType === 'image') media = `<br><img src="${mediaUrl}" style="max-width:150px;border-radius:5px">`;
  if (mediaType === 'video') media = `<br><video src="${mediaUrl}" controls playsinline style="max-width:150px"></video>`;
  if (mediaType === 'audio') media = `<br><audio src="${mediaUrl}" controls></audio>`;
  const align = isMine ? 'text-align:right' : '';
  const who = isMine ? 'Ani' : `@${sender}`;
  box.innerHTML += `<div style="${align}"><b>${who}:</b> ${message || ''} ${media}</div>`;
}

function closePrivateChat() {
  activeChatUser = null;
  document.getElementById('private-chat-section').style.display = 'none';
}

function sendPrivateMessage() {
  if (!activeChatUser) return;
  const input = document.getElementById('private-msg-input');
  const fileInput = document.getElementById('private-media-input');
  const message = input.value.trim();
  const file = fileInput.files[0];

  if (file) {
    if (file.size > 20 * 1024 * 1024) return alert('File guddaa dha (max 20MB)');
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
      socket.emit('private-message', {
        sender: currentUser.username, receiver: activeChatUser,
        message, mediaUrl: e.target.result, mediaType: type
      });
      appendPrivateMsg(currentUser.username, message, e.target.result, type, true);
      document.getElementById('private-chat-box').scrollTop =
        document.getElementById('private-chat-box').scrollHeight;
      input.value = ''; fileInput.value = '';
    };
    reader.readAsDataURL(file);
  } else if (message) {
    socket.emit('private-message', { sender: currentUser.username, receiver: activeChatUser, message });
    appendPrivateMsg(currentUser.username, message, null, null, true);
    document.getElementById('private-chat-box').scrollTop =
      document.getElementById('private-chat-box').scrollHeight;
    input.value = '';
  }
}

socket.on('private-message', data => {
  if (activeChatUser === data.sender) {
    appendPrivateMsg(data.sender, data.message, data.mediaUrl, data.mediaType, false);
    document.getElementById('private-chat-box').scrollTop =
      document.getElementById('private-chat-box').scrollHeight;
  } else {
    alert(`Ergaan haaraan @${data.sender} irraa dhufeera!`);
  }
});

// ===== CALL ENGINE (TURN + Trickle ICE) =====
async function startCall(userToCall, isVideo) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return alert('Camera/Mic requires HTTPS. Render URL (https://) fayyadami.');
  }
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: isVideo
        ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        : false
    });

    const grid = document.getElementById('video-grid');
    grid.innerHTML =
      `<video id="local-video" autoplay muted playsinline></video>
       <video id="remote-video" autoplay playsinline></video>`;
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';

    peer = new SimplePeer({
      initiator: true,
      trickle: true,
      stream: currentStream,
      config: iceServersConfig
    });

    peer.on('signal', sig => {
      if (sig.type === 'offer' || sig.type === 'answer') {
        socket.emit('call-user', {
          userToCall, signalData: sig,
          callerName: currentUser.username, isVideo
        });
      } else {
        socket.emit('ice-candidate', { toUsername: userToCall, candidate: sig });
      }
    });

    peer.on('stream', remoteStream => {
      const rv = document.getElementById('remote-video');
      if (rv) {
        rv.srcObject = remoteStream;
        rv.play().catch(e => { rv.controls = true; });
      }
    });

    peer.on('error', err => { console.error('Peer err:', err); alert('Call error: ' + err.message); endCall(); });
    peer.on('close', () => endCall());

  } catch (e) {
    alert('Camera/Mic eeyyama barbaachisa!');
    console.error(e);
  }
}

socket.on('incoming-call', data => {
  incomingData = data;
  document.getElementById('caller-name-txt').innerText = `${data.callerName} is calling...`;
  document.getElementById('call-modal').style.display = 'flex';

  if (navigator.vibrate) navigator.vibrate([500, 300, 500, 300, 500]);

  const ring = getActiveRingtone();
  if (ring) {
    ring.currentTime = 0;
    ring.play().catch(err => console.log('Ringtone blocked (tap to enable):', err));
  }
});

async function acceptCall() {
  stopRingtone();
  document.getElementById('call-modal').style.display = 'none';
  document.getElementById('call-screen').style.display = 'block';

  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: incomingData.isVideo
        ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        : false
    });

    const grid = document.getElementById('video-grid');
    grid.innerHTML =
      `<video id="local-video" autoplay muted playsinline></video>
       <video id="remote-video" autoplay playsinline></video>`;
    document.getElementById('local-video').srcObject = currentStream;

    peer = new SimplePeer({
      initiator: false,
      trickle: true,
      stream: currentStream,
      config: iceServersConfig
    });

    peer.on('signal', sig => {
      if (sig.type === 'offer' || sig.type === 'answer') {
        socket.emit('accept-call', { signal: sig, to: incomingData.from });
      } else {
        socket.emit('ice-candidate', { toUsername: incomingData.callerName, candidate: sig });
      }
    });

    peer.on('stream', remoteStream => {
      const rv = document.getElementById('remote-video');
      if (rv) {
        rv.srcObject = remoteStream;
        rv.play().catch(e => { rv.controls = true; });
      }
    });

    peer.on('error', err => { console.error(err); endCall(); });
    peer.on('close', () => endCall());

    peer.signal(incomingData.signal);
  } catch (e) {
    alert('Camera/Mic eeyyama barbaachisa!');
    console.error(e);
  }
}

function rejectCall() {
  stopRingtone();
  document.getElementById('call-modal').style.display = 'none';
  socket.emit('reject-call', { to: incomingData.from });
}

socket.on('call-accepted', signal => { if (peer) peer.signal(signal); });
socket.on('call-rejected', () => { alert('Call reject ta\'eera.'); endCall(); });
socket.on('ice-candidate', candidate => { if (peer) peer.signal(candidate); });
socket.on('call-failed-offline', () => {
  alert('Maammilli offline waan ta\'eef bilbilamuu hin dandeenye (Missed Call galmaa\'eera).');
  endCall();
});

// ===== GROUP CALL =====
async function startGroupCall() {
  if (!navigator.mediaDevices?.getUserMedia)
    return alert('Camera/Mic requires HTTPS');
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
    });
    const grid = document.getElementById('video-grid');
    grid.innerHTML = `<video id="local-video" autoplay muted playsinline></video>`;
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';
    socket.emit('join-group-call');
  } catch (e) { alert('Camera/Mic barbaachisa!'); }
}

function attachGroupRemote(userId, remoteStream) {
  let vid = document.getElementById(`remote-${userId}`);
  if (!vid) {
    vid = document.createElement('video');
    vid.id = `remote-${userId}`;
    vid.autoplay = true;
    vid.setAttribute('playsinline', '');
    document.getElementById('video-grid').appendChild(vid);
  }
  vid.srcObject = remoteStream;
  vid.play().catch(e => { vid.controls = true; });
}

socket.on('user-joined-group', userId => {
  if (!currentStream) return;
  const p = new SimplePeer({ initiator: true, trickle: true, stream: currentStream, config: iceServersConfig });
  p.on('signal', sig => {
    if (sig.type === 'offer' || sig.type === 'answer')
      socket.emit('group-signal', { signal: sig, to: userId });
    else
      socket.emit('group-ice-candidate', { candidate: sig, to: userId });
  });
  p.on('stream', rs => attachGroupRemote(userId, rs));
  p.on('error', e => console.error('group peer', e));
  groupPeers[userId] = p;
});

socket.on('group-signal', data => {
  if (!currentStream) return;
  let p = groupPeers[data.from];
  if (!p) {
    p = new SimplePeer({ initiator: false, trickle: true, stream: currentStream, config: iceServersConfig });
    p.on('signal', sig => {
      if (sig.type === 'offer' || sig.type === 'answer')
        socket.emit('group-signal', { signal: sig, to: data.from });
      else
        socket.emit('group-ice-candidate', { candidate: sig, to: data.from });
    });
    p.on('stream', rs => attachGroupRemote(data.from, rs));
    p.on('error', e => console.error('group peer', e));
    groupPeers[data.from] = p;
  }
  p.signal(data.signal);
});

socket.on('group-ice-candidate', data => {
  const p = groupPeers[data.from];
  if (p) p.signal(data.candidate);
});

socket.on('user-left-group', userId => {
  if (groupPeers[userId]) { groupPeers[userId].destroy(); delete groupPeers[userId]; }
  const vid = document.getElementById(`remote-${userId}`);
  if (vid) vid.remove();
});

// ===== END CALL =====
function endCall() {
  stopRingtone();
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  Object.values(groupPeers).forEach(p => { try { p.destroy(); } catch {} });
  groupPeers = {};
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (socket.connected) socket.emit('leave-group-call');
  document.getElementById('call-screen').style.display = 'none';
}

// ===== POSTS =====
function submitPost() {
  const content = document.getElementById('post-text').value;
  const fileInput = document.getElementById('post-file');
  const file = fileInput.files[0];

  if (file) {
    if (file.size > 30 * 1024 * 1024) return alert('File guddaa dha (max 30MB)');
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : 'image';
      socket.emit('create-post', {
        username: currentUser.username, content,
        mediaUrl: e.target.result, mediaType: type
      });
      alert('Post-n keessan ergameera (admin approval barbaachisa).');
      document.getElementById('post-text').value = '';
      fileInput.value = '';
    };
    reader.readAsDataURL(file);
  } else if (content) {
    socket.emit('create-post', { username: currentUser.username, content });
    alert('Post-n keessan ergameera.');
    document.getElementById('post-text').value = '';
  }
}

async function loadPosts() {
  const res = await fetch('/api/posts');
  const posts = await res.json();
  const feed = document.getElementById('feed-container');
  if (!feed) return;
  feed.innerHTML = '';
  posts.forEach(p => {
    feed.innerHTML += `
      <div class="post">
        <b>@${p.username}</b>
        <p>${p.content || ''}</p>
        ${p.media_type === 'image' ? `<img src="${p.media_url}">` : ''}
        ${p.media_type === 'video' ? `<video src="${p.media_url}" controls playsinline></video>` : ''}
      </div>`;
  });
}

// ===== Network resilience =====
window.addEventListener('offline', () => console.warn('Network offline'));
window.addEventListener('online', () => {
  console.log('Network online - reconnecting');
  if (currentUser && socket.connected) socket.emit('register-user', currentUser.username);
});

socket.on('connect', () => {
  if (currentUser) socket.emit('register-user', currentUser.username);
});
