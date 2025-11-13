const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Supabase client
const supabaseUrl = 'https://kirsnvselaqtdaloxfuu.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpcnNudnNlbGFxdGRhbG94ZnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxOTAxMDcsImV4cCI6MjA3MDc2NjEwN30.PrsXn_KkEZbNUXNYpKdvmR8ljUQLzvxy6EXYpKBdd5A';
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  },
  db: { 
    schema: 'public',
  },
  auth:  {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Track connected users
const connectedUsers = new Map();

// Enhanced logging function
function logEvent(event, socketId, details = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${event}] Socket: ${socketId}`, details);
}

// Socket.io connection
io.on('connection', (socket) => {
  logEvent('CONNECTION', socket.id);
  connectedUsers.set(socket.id, { connectedAt: new Date() });

  // Join room with user ID
  socket.on('joinRoom', (userId) => {
    if (!userId) {
      logEvent('ERROR', socket.id, { error: 'Missing userId in joinRoom' });
      return;
    }
    
    socket.join(userId);
    connectedUsers.set(socket.id, { 
      ...connectedUsers.get(socket.id), 
      userId, 
      room: userId 
    });
    logEvent('JOIN_ROOM', socket.id, { userId });
  });

  // Leave room
  socket.on('leaveRoom', (userId) => {
    if (!userId) {
      logEvent('ERROR', socket.id, { error: 'Missing userId in leaveRoom' });
      return;
    }
    
    socket.leave(userId);
    const userData = connectedUsers.get(socket.id);
    if (userData) {
      connectedUsers.set(socket.id, { ...userData, room: null });
    }
    logEvent('LEAVE_ROOM', socket.id, { userId });
  });

  // Listen for new messages
  socket.on('sendMessage', async (messageData) => {
    try {
      logEvent('SEND_MESSAGE_ATTEMPT', socket.id, messageData);
      
      // Validate message data
      const { sender_id, receiver_id, content, reply_to } = messageData;
      
      if (!sender_id || !receiver_id || !content) {
        logEvent('ERROR', socket.id, { 
          error: 'Missing required message fields', 
          data: messageData 
        });
        socket.emit('messageError', { 
          error: 'Missing required fields: sender_id, receiver_id, or content' 
        });
        return;
      }

      if (content.length > 1000) {
        logEvent('ERROR', socket.id, { 
          error: 'Message too long', 
          length: content.length 
        });
        socket.emit('messageError', { 
          error: 'Message exceeds maximum length of 1000 characters' 
        });
        return;
      }

      // Insert message into Supabase
      const { data, error } = await supabase
        .from('messages')
        .insert([{ 
          sender_id, 
          receiver_id, 
          content,
          reply_to: reply_to || null
        }])
        .select('*');

      if (error) {
        logEvent('SUPABASE_ERROR', socket.id, { 
          error: error.message, 
          code: error.code 
        });
        socket.emit('messageError', { 
          error: 'Failed to send message. Please try again.' 
        });
        return;
      }

      const newMessage = data[0];
      
      // Emit the new message to both sender and receiver
      logEvent('MESSAGE_SENT', socket.id, { 
        messageId: newMessage.id, 
        sender_id, 
        receiver_id 
      });
      
      io.to(sender_id).emit('receiveMessage', newMessage);
      io.to(receiver_id).emit('receiveMessage', newMessage);
      
    } catch (error) {
      logEvent('UNEXPECTED_ERROR', socket.id, { 
        error: error.message, 
        stack: error.stack 
      });
      socket.emit('messageError', { 
        error: 'An unexpected error occurred. Please try again.' 
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    const userData = connectedUsers.get(socket.id);
    logEvent('DISCONNECT', socket.id, { 
      reason, 
      userId: userData?.userId,
      duration: userData ? (new Date() - userData.connectedAt) / 1000 + 's' : 'unknown'
    });
    connectedUsers.delete(socket.id);
  });

  // Handle connection errors
  socket.on('error', (error) => {
    logEvent('SOCKET_ERROR', socket.id, { error: error.message });
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    connectedUsers: connectedUsers.size,
    timestamp: new Date().toISOString()
  });
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Photo upload endpoint
app.post('/upload', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  try {
    const fileName = `photo_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const filePath = path.join(uploadsDir, fileName);

    // Write file to disk
    fs.writeFileSync(filePath, req.body);

    // Return the URL
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const photoUrl = `${baseUrl}/uploads/${fileName}`;

    res.json({
      success: true,
      url: photoUrl,
      fileName: fileName
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload photo'
    });
  }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Start the server
const PORT = process.env.PORT || 25607;
server.listen(PORT, () => {
  console.log(`🚀 Socket.io server is running on port ${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logEvent('SHUTDOWN', 'system', { reason: 'SIGTERM' });
  server.close(() => {
    console.log('Server closed gracefully');
    process.exit(0);
  });
});
