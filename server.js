const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');
const compression = require('compression');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 50 * 1024 * 1024,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 10000;

// === DATABASE ===
let dbUrl = process.env.DATABASE_URL;
if (dbUrl && dbUrl.includes('sslmode=')) {
  try {
    const u = new URL(dbUrl);
    u.searchParams.delete('sslmode');
    dbUrl = u.toString();
  } catch (e) {}
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// === TURN SERVER (Metered.ca API) ===
async function getIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.nextcloud.com:443' }
  ];

  // 1) Yoo TURN static env var jiru fayyadami
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map(s => s.trim());
    const username = process.env.TURN_USERNAME || '';
    const credential = process.env.TURN_CREDENTIAL || '';
    urls.forEach(url => iceServers.push({ urls: url, username, credential }));
    return iceServers;
  }

  // 2) Yoo METERED_API_KEY jiru, credentials haaraa ofiin iyyi
  if (process.env.METERED_API_KEY) {
    try {
      const res = await fetch(
        `https://imaanaacall.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          // data is list of ICE servers
          data.forEach(s => iceServers.push(s));
        }
      }
    } catch (e) {
      console.error('Metered API error:', e);
    }
  }

  // 3) Fallback: OpenRelay (yoo API Key hin jiraanne)
  if (!process.env.METERED_API_KEY && !process.env.TURN_URL) {
    iceServers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    });
  }

  return iceServers;
}

app.get('/api/ice-servers', async (req, res) => {
  try {
    const servers = await getIceServers();
    res.json({ iceServers: servers });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get ICE servers' });
  }
});

// === DB INIT ===
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        phone VARCHAR(20),
        bio TEXT,
        avatar TEXT,
        role VARCHAR(20) DEFAULT 'user',
        is_admin BOOLEAN DEFAULT FALSE,
        is_vip BOOLEAN DEFAULT FALSE,
        banned_until TIMESTAMP DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50),
        content TEXT,
        media_url TEXT,
        media_type VARCHAR(20),
        likes INT DEFAULT 0,
        approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS missed_calls (
        id SERIAL PRIMARY KEY,
        receiver VARCHAR(50),
        caller VARCHAR(50),
        call_type VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS private_messages (
        id SERIAL PRIMARY KEY,
        sender VARCHAR(50),
        receiver VARCHAR(50),
        message TEXT,
        media_url TEXT,
        media_type VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP DEFAULT NULL;
    `);

    await pool.query(
      `UPDATE users SET is_admin = TRUE, role = 'admin' WHERE username = 'admin';`
    );

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('DB Initialization Error:', err);
    process.exit(1);
  }
}

async function startServer() {
  await initDB();
  server.listen(PORT, '0.0.0.0', () =>
    console.log(`Server running on 0.0.0.0:${PORT}`)
  );
}
startServer();

// === AUTH ===
app.post('/api/auth/signup', async (req, res) => {
  const { username, password, phone, bio } = req.body;
  try {
    if (!username || !password)
      return res.status(400).json({ success: false, message: 'Maqaa fi password guutuun dirqama!' });
    const checkUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (checkUser.rows.length > 0)
      return res.status(400).json({ success: false, message: 'Maqaan kun duraan qabameera!' });

    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    const isAdmin = parseInt(userCount.rows[0].count) === 0;
    const role = isAdmin ? 'admin' : 'user';

    const hashedPassword = await bcrypt.hash(password, 10);
    const userRes = await pool.query(
      'INSERT INTO users (username, password, phone, bio, role, is_admin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, username, is_admin, is_vip, role',
      [username, hashedPassword, phone || '', bio || '', role, isAdmin]
    );
    res.json({ success: true, user: userRes.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, message: "Galmaa'uun hin danda'amne: " + err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0)
      return res.status(400).json({ success: false, message: 'Maqaan akkasii hin jiru!' });

    const user = userRes.rows[0];
    if (user.banned_until && new Date(user.banned_until) > new Date())
      return res.status(403).json({ success: false, message: `Account'n keessan hanga ${user.banned_until}tti ban ta'eera!` });

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass)
      return res.status(400).json({ success: false, message: 'Password dogoggora!' });

    delete user.password;
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// === POSTS ===
app.get('/api/posts', async (req, res) => {
  try {
    const posts = await pool.query(
      'SELECT * FROM posts WHERE approved = TRUE ORDER BY id DESC LIMIT 20'
    );
    res.json(posts.rows);
  } catch { res.status(500).json({ success: false }); }
});

// === MESSAGES HISTORY ===
app.get('/api/messages/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const r = await pool.query(
      `SELECT sender, receiver, message, media_url, media_type, created_at
       FROM private_messages
       WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
       ORDER BY id ASC LIMIT 200`,
      [user1, user2]
    );
    res.json(r.rows);
  } catch { res.status(500).json({ success: false }); }
});

// === ADMIN ===
app.get('/api/admin/pending-posts', async (req, res) => {
  try {
    const posts = await pool.query('SELECT * FROM posts ORDER BY id DESC');
    res.json(posts.rows);
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/approve-post', async (req, res) => {
  try {
    await pool.query('UPDATE posts SET approved = TRUE WHERE id = $1', [req.body.postId]);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/delete-post', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.body.postId]);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await pool.query('SELECT username, role, is_admin, banned_until FROM users');
    res.json(users.rows);
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/ban-user', async (req, res) => {
  try {
    const { username, days } = req.body;
    const banUntil = new Date();
    banUntil.setDate(banUntil.getDate() + parseInt(days));
    await pool.query('UPDATE users SET banned_until = $1 WHERE username = $2', [banUntil, username]);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/unban-user', async (req, res) => {
  try {
    await pool.query('UPDATE users SET banned_until = NULL WHERE username = $1', [req.body.username]);
    res.json({ success: true });
  } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/make-admin', async (req, res) => {
  try {
    await pool.query("UPDATE users SET is_admin = TRUE, role = 'admin' WHERE username = $1", [req.body.username]);
    res.json({ success: true, message: `@${req.body.username} amma Admin ta'eera!` });
  } catch { res.status(500).json({ success: false }); }
});

// === SOCKET.IO ===
const activeUsers = {};

function findSocketByUsername(username) {
  return Object.keys(activeUsers).find(k => activeUsers[k].username === username);
}

io.on('connection', (socket) => {
  socket.on('register-user', async (username) => {
    activeUsers[socket.id] = { id: socket.id, username };
    broadcastUserList();

    try {
      const missed = await pool.query(
        'SELECT * FROM missed_calls WHERE receiver = $1 ORDER BY id DESC',
        [username]
      );
      if (missed.rows.length > 0) {
        socket.emit('missed-calls-notification', missed.rows);
        await pool.query('DELETE FROM missed_calls WHERE receiver = $1', [username]);
      }
    } catch (e) { console.error(e); }
  });

  async function broadcastUserList() {
    try {
      const allUsersRes = await pool.query('SELECT username, avatar, is_vip FROM users');
      const onlineUsernames = Object.values(activeUsers).map(u => u.username);
      const userList = allUsersRes.rows.map(u => ({
        username: u.username,
        avatar: u.avatar,
        is_vip: u.is_vip,
        isOnline: onlineUsernames.includes(u.username)
      }));
      io.emit('update-user-list', userList);
    } catch (err) { console.error(err); }
  }

  socket.on('call-user', async (data) => {
    const targetSocket = findSocketByUsername(data.userToCall);
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', {
        signal: data.signalData,
        from: socket.id,
        callerName: data.callerName,
        isVideo: data.isVideo
      });
    } else {
      await pool.query(
        'INSERT INTO missed_calls (receiver, caller, call_type) VALUES ($1,$2,$3)',
        [data.userToCall, data.callerName, data.isVideo ? 'Video' : 'Voice']
      );
      socket.emit('call-failed-offline');
    }
  });

  socket.on('accept-call', (data) => io.to(data.to).emit('call-accepted', data.signal));
  socket.on('reject-call',  (data) => io.to(data.to).emit('call-rejected'));

  socket.on('ice-candidate', (data) => {
    if (data.toUsername) {
      const targetSocket = findSocketByUsername(data.toUsername);
      if (targetSocket) io.to(targetSocket).emit('ice-candidate', data.candidate);
    } else if (data.toSocketId) {
      io.to(data.toSocketId).emit('ice-candidate', data.candidate);
    }
  });

  socket.on('join-group-call', () => socket.broadcast.emit('user-joined-group', socket.id));
  socket.on('leave-group-call', () => socket.broadcast.emit('user-left-group', socket.id));

  socket.on('group-signal', (data) =>
    io.to(data.to).emit('group-signal', { signal: data.signal, from: socket.id })
  );

  socket.on('group-ice-candidate', (data) =>
    io.to(data.to).emit('group-ice-candidate', { candidate: data.candidate, from: socket.id })
  );

  socket.on('group-chat-message', (data) => io.emit('group-chat-message', data));

  socket.on('private-message', async (data) => {
    const targetSocket = findSocketByUsername(data.receiver);
    if (targetSocket) io.to(targetSocket).emit('private-message', data);
    try {
      await pool.query(
        'INSERT INTO private_messages (sender, receiver, message, media_url, media_type) VALUES ($1,$2,$3,$4,$5)',
        [data.sender, data.receiver, data.message || null, data.mediaUrl || null, data.mediaType || null]
      );
    } catch (e) { console.error('save msg err:', e.message); }
  });

  socket.on('create-post', async (data) => {
    try {
      const r = await pool.query(
        'INSERT INTO posts (username, content, media_url, media_type, approved) VALUES ($1,$2,$3,$4,FALSE) RETURNING *',
        [data.username, data.content, data.mediaUrl || null, data.mediaType || null]
      );
      socket.emit('post-submitted-silent', r.rows[0]);
    } catch (err) { console.error(err); }
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
    broadcastUserList();
    socket.broadcast.emit('user-left-group', socket.id);
  });
});
