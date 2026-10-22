const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});

let currentUser = null, isSignup = false, currentStream = null, peer = null, incomingData = null, activeChatUser = null;
let groupPeers = {};
const ringtone = document.getElementById('ringtone');

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

  let adminLink = currentUser.is_admin ? `<a href="admin.html" target="_blank" style="color:yellow; margin-left:10px;">Admin Dashboard</a>` : '';

  document.getElementById('user-head-sec').innerHTML = `
    <b>@${currentUser.username}</b> ${adminLink}
    <button onclick="logout()" class="btn btn-danger" style="width:auto; padding:5px 10px; margin-left:5px;">Logout</button>`;

  socket.emit('register-user', currentUser.username);
  loadPosts();
}

function logout() {
  location.reload();
}

async function saveProfile() {
  const phone = document.getElementById('edit-phone').value;
  const bio = document.getElementById('edit-bio').value;

  await fetch('/api/profile/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser.username, phone, bio, avatar: '' })
  });
  alert("Profile Updated!");
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

// GROUP CHAT
function sendGroupMessage() {
  const input = document.getElementById('group-msg-input');
  const message = input.value.trim();
  if(!message) return;
  socket.emit('group-chat-message', { sender: currentUser.username, message });
  input.value = '';
}

socket.on('group-chat-message', data => {
  const box = document.getElementById('group-chat-box');
  box.innerHTML += `<div><b>@${data.sender}:</b> ${data.message}</div>`;
  box.scrollTop = box.scrollHeight;
});

// PRIVATE CHAT
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
  const box = document.getElementById('private-chat-box');
  box.innerHTML += `<div style="text-align:right;"><b>Ani:</b> ${message}</div>`;
  box.scrollTop = box.scrollHeight;
  input.value = '';
}

socket.on('private-message', data => {
  if (activeChatUser === data.sender) {
    const box = document.getElementById('private-chat-box');
    box.innerHTML += `<div><b>@${data.sender}:</b> ${data.message}</div>`;
    box.scrollTop = box.scrollHeight;
  } else {
    alert(`Ergaa haaraan @${data.sender} irraa dhufeera!`);
  }
});

// --- 1-on-1 CALL ENGINE ---
async function startCall(userToCall, isVideo) {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ 
      audio: true, 
      video: isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false 
    });
    
    const grid = document.getElementById('video-grid');
    grid.innerHTML = `<video id="local-video" autoplay muted></video><video id="remote-video" autoplay></video>`;
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';

    peer = new SimplePeer({ initiator: true, trickle: false, stream: currentStream });

    peer.on('signal', signalData => {
      socket.emit('call-user', { userToCall, signalData, callerName: currentUser.username, isVideo });
    });

    peer.on('stream', remoteStream => {
      const remoteVideo = document.getElementById('remote-video');
      if(remoteVideo) remoteVideo.srcObject = remoteStream;
    });
  } catch(e) { alert("Camera/Microphone Permission Gaafatamaa!"); }
}

socket.on('incoming-call', data => {
  incomingData = data;
  document.getElementById('caller-name-txt').innerText = `${data.callerName} is calling...`;
  document.getElementById('call-modal').style.display = 'flex';
  ringtone.play().catch(e => console.log(e));
});

async function acceptCall() {
  ringtone.pause();
  document.getElementById('call-modal').style.display = 'none';
  document.getElementById('call-screen').style.display = 'block';

  currentStream = await navigator.mediaDevices.getUserMedia({ 
    audio: true, 
    video: incomingData.isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false 
  });
  
  const grid = document.getElementById('video-grid');
  grid.innerHTML = `<video id="local-video" autoplay muted></video><video id="remote-video" autoplay></video>`;
  document.getElementById('local-video').srcObject = currentStream;

  peer = new SimplePeer({ initiator: false, trickle: false, stream: currentStream });

  peer.on('signal', signal => socket.emit('accept-call', { signal, to: incomingData.from }));
  peer.on('stream', remoteStream => {
    const remoteVideo = document.getElementById('remote-video');
    if(remoteVideo) remoteVideo.srcObject = remoteStream;
  });

  peer.signal(incomingData.signal);
}

function rejectCall() {
  ringtone.pause();
  document.getElementById('call-modal').style.display = 'none';
  socket.emit('reject-call', { to: incomingData.from });
}

socket.on('call-accepted', signal => { if(peer) peer.signal(signal); });
socket.on('call-failed-offline', () => { alert("Maammilli offline waan ta'eef bilbilamuu hin dandeenye."); endCall(); });

// --- FACEBOOK STYLE GROUP CALL LOGIC ---
async function startGroupCall() {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const grid = document.getElementById('video-grid');
    grid.innerHTML = `<video id="local-video" autoplay muted></video>`;
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';

    socket.emit('join-group-call');
  } catch(e) {
    alert("Camera/Mic feedhi barbaachisa!");
  }
}

socket.on('user-joined-group', userId => {
  if(!currentStream) return;
  const p = new SimplePeer({ initiator: true, trickle: false, stream: currentStream });

  p.on('signal', signal => {
    socket.emit('group-signal', { signal, to: userId });
  });

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
    p = new SimplePeer({ initiator: false, trickle: false, stream: currentStream });

    p.on('signal', signal => {
      socket.emit('group-signal', { signal, to: data.from });
    });

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
  if(groupPeers[userId]) {
    groupPeers[userId].destroy();
    delete groupPeers[userId];
  }
  const vid = document.getElementById(`remote-${userId}`);
  if(vid) vid.remove();
});

function endCall() {
  if (peer) { peer.destroy(); peer = null; }
  Object.values(groupPeers).forEach(p => p.destroy());
  groupPeers = {};
  socket.emit('leave-group-call');

  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  document.getElementById('call-screen').style.display = 'none';
}

// POST SUBMISSION
function submitPost() {
  const content = document.getElementById('post-text').value;
  const fileInput = document.getElementById('post-file');
  const file = fileInput.files[0];

  if (file) {
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : 'image';
      socket.emit('create-post', { username: currentUser.username, content, mediaUrl: e.target.result, mediaType: type });
      alert("Faayiliin keessan fe'amaa jira, xumuramnaan Admin-ni akka raggaasisuuf eegama.");
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

socket.on('post-submitted-silent', post => {});

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
