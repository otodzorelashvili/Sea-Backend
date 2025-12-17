const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
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

  if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
    return res.status(400).json({ error: 'Only images and videos allowed' });
  }

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

// Connected users - Map of socketId -> userId
const connectedUsers = new Map();
// User rooms - Map of userId -> Set of socketIds
const userRooms = new Map();

io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // Join room
  socket.on('joinRoom', (userId) => {
    if (!userId) {
      console.warn('⚠️ joinRoom called without userId');
      return;
    }
    
    console.log(`👤 User ${userId} joined room (socket: ${socket.id})`);
    
    socket.join(userId);
    connectedUsers.set(socket.id, { userId });
    
    if (!userRooms.has(userId)) {
      userRooms.set(userId, new Set());
    }
    userRooms.get(userId).add(socket.id);
    
    emitOnlineUsers();
  });

  // Leave room
  socket.on('leaveRoom', (userId) => {
    if (!userId) return;
    
    console.log(`👋 User ${userId} left room (socket: ${socket.id})`);
    
    socket.leave(userId);
    connectedUsers.delete(socket.id);
    
    if (userRooms.has(userId)) {
      userRooms.get(userId).delete(socket.id);
      if (userRooms.get(userId).size === 0) {
        userRooms.delete(userId);
      }
    }
    
    emitOnlineUsers();
  });

  // Send message - FIXED VERSION
  socket.on('sendMessage', async (messageData, callback) => {
    const { sender_id, receiver_id, content, reply_to, is_mention } = messageData || {};
    
    if (!sender_id || !receiver_id || !content) {
      console.error('❌ Missing fields:', { sender_id, receiver_id, hasContent: !!content });
      if (callback) callback({ error: 'Missing required fields' });
      return;
    }

    try {
      const { data, error } = await supabase
        .from('messages')
        .insert([{ 
          sender_id, 
          receiver_id, 
          content, 
          reply_to: reply_to || null, 
          is_mention: is_mention || false,
          status: 'sent',
          created_at: new Date().toISOString()
        }])
        .select('*')
        .single();

      if (error) {
        console.error('❌ Database insert error:', error);
        if (callback) callback({ error: 'Failed to send message' });
        return;
      }

      const newMessage = data;
      console.log('✅ Message saved to DB:', newMessage.id);

      // Send to receiver
      io.to(receiver_id).emit('receiveMessage', newMessage);
      console.log(`📤 Message sent to receiver ${receiver_id}`);
      
      // Send to sender
      io.to(sender_id).emit('receiveMessage', newMessage);
      console.log(`📤 Message sent to sender ${sender_id}`);

      if (callback) {
        callback({ 
          success: true, 
          message: newMessage 
        });
      }

    } catch (err) {
      console.error('❌ Unexpected error in sendMessage:', err);
      if (callback) callback({ error: 'Unexpected error occurred' });
    }
  });

  // Send group message
  socket.on('sendGroupMessage', async (messageData, callback) => {
    const { sender_id, group_id, content, reply_to } = messageData || {};
    
    if (!sender_id || !group_id || !content) {
      if (callback) callback({ error: 'Missing required fields' });
      return;
    }

    try {
      const { data, error } = await supabase
        .from('group_messages')
        .insert([{ sender_id, group_id, content, reply_to: reply_to || null }])
        .select('*')
        .single();

      if (error) {
        console.error('Database insert error:', error);
        if (callback) callback({ error: 'Failed to send message' });
        return;
      }

      const newMessage = data;
      
      io.to(group_id).emit('receiveGroupMessage', newMessage);
      
      if (callback) callback({ success: true, message: newMessage });

    } catch (err) {
      console.error('Unexpected error:', err);
      if (callback) callback({ error: 'Unexpected error' });
    }
  });

  // Typing event
  socket.on('typing', ({ to, typing }) => {
    const fromUserId = connectedUsers.get(socket.id)?.userId;
    if (fromUserId && to) {
      io.to(to).emit('userTyping', { from: fromUserId, typing });
    }
  });

  // Message seen status
  socket.on('messageSeen', async ({ messageIds }) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;

    try {
      const { error } = await supabase
        .from('messages')
        .update({ status: 'seen' })
        .in('id', messageIds);

      if (error) {
        console.error('Error updating message status:', error);
        return;
      }

      const { data: messages } = await supabase
        .from('messages')
        .select('sender_id')
        .in('id', messageIds);

      if (messages && messages.length > 0) {
        const senderIds = [...new Set(messages.map(m => m.sender_id))];
        senderIds.forEach(senderId => {
          io.to(senderId).emit('messageSeen', { messageIds });
        });
      }
    } catch (err) {
      console.error('Error in messageSeen:', err);
    }
  });

  // WebRTC signaling
  socket.on('callUser', ({ userToCall, signalData, from, name }) => {
    io.to(userToCall).emit('callUser', { signal: signalData, from, name });
  });

  socket.on('answerCall', ({ to, signal }) => {
    io.to(to).emit('callAccepted', signal);
  });

  socket.on('iceCandidate', ({ to, candidate }) => {
    io.to(to).emit('iceCandidate', candidate);
  });

  socket.on('endCall', ({ to }) => {
    io.to(to).emit('callEnded');
  });

  socket.on('rejectCall', ({ to, callId }) => {
    io.to(to).emit('callRejected', { callId });
  });

  // Chess invites
  socket.on('chessInvite', ({ inviteeId, inviterName, gameId }) => {
    io.to(inviteeId).emit('chessInvite', { 
      inviterId: connectedUsers.get(socket.id)?.userId,
      inviterName, 
      gameId 
    });
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);
    
    const userData = connectedUsers.get(socket.id);
    if (userData) {
      const userId = userData.userId;
      
      connectedUsers.delete(socket.id);
      
      if (userRooms.has(userId)) {
        userRooms.get(userId).delete(socket.id);
        if (userRooms.get(userId).size === 0) {
          userRooms.delete(userId);
        }
      }
    }
    
    emitOnlineUsers();
  });

  function emitOnlineUsers() {
    const onlineUserIds = Array.from(userRooms.keys());
    console.log('📊 Online users:', onlineUserIds.length);
    io.emit('onlineUsers', onlineUserIds);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connections: connectedUsers.size,
    onlineUsers: userRooms.size
  });
});

const PORT = process.env.PORT || 25588;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready`);
});
