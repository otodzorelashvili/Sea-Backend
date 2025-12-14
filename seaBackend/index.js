const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Supabase
const supabaseUrl = 'https://kirsnvselaqtdaloxfuu.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpcnNudnNlbGFxdGRhbG94ZnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxOTAxMDcsImV4cCI6MjA3MDc2NjEwN30.PrsXn_KkEZbNUXNYpKdvmR8ljUQLzvxy6EXYpKBdd5A';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware
app.use(express.json());

// Photo upload endpoint
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Check file type
  if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
    return res.status(400).json({ error: 'Only images and videos allowed' });
  }

  // Check file size (10MB)
  if (file.size > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large' });
  }

  try {
    const fileName = `photos/${Date.now()}-${Math.random().toString(36).substring(7)}.${file.originalname.split('.').pop()}`;
    const { data, error } = await supabase.storage
      .from('avatars')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (error) {
      console.error('Upload error:', error);
      return res.status(500).json({ error: 'Upload failed' });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('avatars')
      .getPublicUrl(fileName);

    res.json({ url: publicUrl });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

// Connected users
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // Join room
  socket.on('joinRoom', (userId) => {
    if (!userId) return;
    socket.join(userId);
    connectedUsers.set(socket.id, { userId });
    emitOnlineUsers();
  });

  // Leave room
  socket.on('leaveRoom', (userId) => {
    if (!userId) return;
    socket.leave(userId);
    connectedUsers.delete(socket.id);
    emitOnlineUsers();
  });

  // Send message
  socket.on('sendMessage', async (messageData, callback) => {
    const { sender_id, receiver_id, content, reply_to } = messageData || {};
    if (!sender_id || !receiver_id || !content) {
      if (callback) callback({ error: 'Missing fields' });
      return;
    }

    try {
      const { data, error } = await supabase
        .from('messages')
        .insert([{ sender_id, receiver_id, content, reply_to: reply_to || null }])
        .select('*');

      if (error) {
        if (callback) callback({ error: 'Failed to send message' });
        return;
      }

      const newMessage = data[0];
      io.to(receiver_id).emit('receiveMessage', newMessage);
      if (callback) callback({ success: true, message: newMessage });

    } catch (err) {
      if (callback) callback({ error: 'Unexpected error' });
    }
  });

  // Typing event
  socket.on('typing', ({ to, typing }) => {
    const fromUserId = connectedUsers.get(socket.id)?.userId;
    if (fromUserId) {
      // Emit only to recipient (not to all users)
      io.to(to).emit('userTyping', { from: fromUserId, typing });
    }
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    emitOnlineUsers();
  });

  function emitOnlineUsers() {
    const onlineIds = Array.from(connectedUsers.values()).map(u => u.userId);
    io.emit('onlineUsers', onlineIds);
  }
});

server.listen(25588, () => console.log('🚀 Server running on port 25588'));
