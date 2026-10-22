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
  maxHttpBufferSize: 1e9,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(compression());
app.use(express.json({ limit: '1000mb' }));
app.use(express.urlencoded({ extended: true, limit: '1000mb' }));

// Daandii public folder qajeelchuu
app.use(express.static(path.join(__dirname, 'public')));

// Root URL irratti index.html kallattiin akka qaqqabu godhuu
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        post_id INT,
        username VARCHAR(50),
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS private_messages (
        id SERIAL PRIMARY KEY,
        sender VARCHAR(50),
        receiver VARCHAR(50),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP DEFAULT NULL;
    `);

    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("DB Initialization Error:", err);
    process.exit(1);
  }
}

async function startServer() {
  await initDB();
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

app.post('/api/auth/signup', async (req, res) => {
  const { username, password, phone, bio } = req.body;
  try {
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Maqaa fi password guutuun dirqama!" });
    }
    const checkUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: "Maqaan (Username) kun duraan qabameera!" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const userRes = await pool.query(
      'INSERT INTO users (username, password, phone, bio, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, is_admin, is_vip, role',
      [username, hashedPassword, phone || '', bio || '', 'user']
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
    if (userRes.rows.length === 0) return res.status(400).json({ success: false, message: "Maqaan akkasii hin jiru!" });

    const user = userRes.rows[0];
    if (user.banned_until && new Date(user.banned_until) > new Date()) {
      return res.status(403).json({ success: false, message: `Account'n keessan hanga ${user.banned_until}tti ban ta'eera!` });
    }

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ success: false, message: "Password dogoggora!" });

    delete user.password;
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.post('/api/profile/update', async (req, res) => {
  try {
    const { username, phone, bio, avatar } = req.body;
    await pool.query('UPDATE users SET phone = $1, bio = $2, avatar = $3 WHERE username = $4', [phone, bio, avatar || '', username]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const posts = await pool.query('SELECT * FROM posts WHERE approved = TRUE ORDER BY id DESC LIMIT 20');
    res.json(posts.rows);
  } catch (err) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.get('/api/admin/pending-posts', async (req, res) => {
  try {
    const posts = await pool.query('SELECT * FROM posts ORDER BY id DESC');
    res.json(posts.rows);
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/approve-post', async (req, res) => {
  try {
    await pool.query('UPDATE posts SET approved = TRUE WHERE id = $1', [req.body.postId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/delete-post', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.body.postId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/admin/ban-user', async (req, res) => {
  try {
    const { username, days } = req.body;
    const banUntil = new Date();
    banUntil.setDate(banUntil.getDate() + parseInt(days));
    await pool.query('UPDATE users SET banned_until = $1 WHERE username = $2', [banUntil, username]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

const activeUsers = {};

io.on('connection', (socket) => {
  socket.on('register-user', (username) => {
    activeUsers[socket.id] = { id: socket.id, username };
    broadcastUserList();
  });

  async function broadcastUserList() {
    try {
      const allUsersRes = await pool.query('SELECT username, avatar, is_vip FROM users');
      const onlineUsernames = Object.values(activeUsers).map(u => u.username);

      const userList = allUsersRes.rows.map(u => ({
        username: u.username,
        avatar: u.avatar,
        is_vip: u.is_vip,
        isOnline: onlineUsernames.includes(u.username),
        socketId: Object.keys(activeUsers).find(key => activeUsers[key].username === u.username)
      }));

      io.emit('update-user-list', userList);
    } catch (err) {
      console.error(err);
    }
  }

  socket.on('call-user', (data) => {
    const targetSocket = Object.keys(activeUsers).find(k => activeUsers[k].username === data.userToCall);
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', {
        signal: data.signalData,
        from: socket.id,
        callerName: data.callerName,
        isVideo: data.isVideo
      });
    } else {
      socket.emit('call-failed-offline');
    }
  });

  socket.on('accept-call', (data) => io.to(data.to).emit('call-accepted', data.signal));
  socket.on('reject-call', (data) => io.to(data.to).emit('call-rejected'));

  socket.on('join-group-call', () => {
    socket.broadcast.emit('user-joined-group', socket.id);
  });

  socket.on('group-signal', (data) => {
    io.to(data.to).emit('group-signal', { signal: data.signal, from: socket.id });
  });

  socket.on('leave-group-call', () => {
    socket.broadcast.emit('user-left-group', socket.id);
  });

  socket.on('group-chat-message', (data) => io.emit('group-chat-message', data));
  socket.on('private-message', async (data) => {
    const targetSocket = Object.keys(activeUsers).find(k => activeUsers[k].username === data.receiver);
    if (targetSocket) io.to(targetSocket).emit('private-message', data);
  });

  socket.on('create-post', async (data) => {
    try {
      const res = await pool.query(
        'INSERT INTO posts (username, content, media_url, media_type, approved) VALUES ($1, $2, $3, $4, FALSE) RETURNING *',
        [data.username, data.content, data.mediaUrl || null, data.mediaType || null]
      );
      socket.emit('post-submitted-silent', res.rows[0]);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
    broadcastUserList();
    socket.broadcast.emit('user-left-group', socket.id);
  });
});
