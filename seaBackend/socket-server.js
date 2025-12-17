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

  // Listen for new messages - Real-time message sending function
  socket.on('sendMessage', async (messageData, callback) => {
    try {
      logEvent('SEND_MESSAGE_ATTEMPT', socket.id, messageData);

      // Get user token from handshake auth
      const token = socket.handshake.auth?.token;
      if (!token) {
        logEvent('AUTH_ERROR', socket.id, { error: 'No authentication token provided' });
        callback({ error: 'Authentication required' });
        return;
      }

      // Validate message data
      const { sender_id, receiver_id, content, reply_to, is_mention } = messageData;

      if (!sender_id || !receiver_id || !content) {
        logEvent('ERROR', socket.id, {
          error: 'Missing required message fields',
          data: messageData
        });
        callback({ error: 'Missing required fields: sender_id, receiver_id, or content' });
        return;
      }

      if (content.length > 1000) {
        logEvent('ERROR', socket.id, {
          error: 'Message too long',
          length: content.length
        });
        callback({ error: 'Message exceeds maximum length of 1000 characters' });
        return;
      }

      // Create authenticated Supabase client for the user
      const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        },
        db: {
          schema: 'public',
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });

      // Validate token by checking user authentication
      const { data: userData, error: authError } = await userSupabase.auth.getUser();
      if (authError || !userData.user) {
        logEvent('AUTH_ERROR', socket.id, {
          error: 'Invalid or expired token',
          authError: authError?.message
        });
        callback({ error: 'Authentication failed. Please log in again.' });
        return;
      }

      // Verify sender_id matches authenticated user
      if (userData.user.id !== sender_id) {
        logEvent('AUTH_ERROR', socket.id, {
          error: 'Sender ID mismatch',
          authenticatedUser: userData.user.id,
          providedSenderId: sender_id
        });
        callback({ error: 'Authentication mismatch. Please log in again.' });
        return;
      }

      // First, insert the message into Supabase database
      let data, error;
      try {
        const result = await userSupabase
          .from('messages')
          .insert([{
            sender_id,
            receiver_id,
            content,
            reply_to: reply_to || null,
            is_mention: is_mention || false
          }])
          .select('*')
          .single();

        data = result.data;
        error = result.error;
      } catch (dbError) {
        logEvent('SUPABASE_ERROR', socket.id, {
          error: dbError.message,
          code: dbError.code,
          details: dbError.details,
          hint: dbError.hint
        });
        callback({ error: `Database error: ${dbError.message}` });
        return;
      }

      if (error) {
        logEvent('SUPABASE_ERROR', socket.id, {
          error: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint
        });
        callback({ error: `Failed to save message to database: ${error.message}` });
        return;
      }

      const savedMessage = data;
      logEvent('MESSAGE_SAVED', socket.id, {
        messageId: savedMessage.id,
        sender_id,
        receiver_id
      });

      // Emit the saved message to the receiver for real-time delivery
      io.to(receiver_id).emit('receiveMessage', savedMessage);

      // Emit confirmation back to sender (optional, for status update)
      socket.emit('messageSent', {
        tempId: messageData.tempId,
        messageId: savedMessage.id,
        status: 'sent'
      });

      logEvent('MESSAGE_DELIVERED', socket.id, {
        messageId: savedMessage.id,
        deliveredTo: receiver_id
      });

      // Acknowledge the sendMessage emit
      callback({ message: savedMessage });

    } catch (error) {
      logEvent('UNEXPECTED_ERROR', socket.id, {
        error: error.message,
        stack: error.stack
      });
      callback({ error: 'An unexpected error occurred. Please try again.' });
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

  // Join group room
  socket.on('joinGroup', (groupId) => {
    if (!groupId) {
      logEvent('ERROR', socket.id, { error: 'Missing groupId in joinGroup' });
      return;
    }

    socket.join(`group-${groupId}`);
    connectedUsers.set(socket.id, {
      ...connectedUsers.get(socket.id),
      groupId,
      groupRoom: `group-${groupId}`
    });
    logEvent('JOIN_GROUP', socket.id, { groupId });
  });

  // Leave group room
  socket.on('leaveGroup', (groupId) => {
    if (!groupId) {
      logEvent('ERROR', socket.id, { error: 'Missing groupId in leaveGroup' });
      return;
    }

    socket.leave(`group-${groupId}`);
    const userData = connectedUsers.get(socket.id);
    if (userData) {
      connectedUsers.set(socket.id, { ...userData, groupId: null, groupRoom: null });
    }
    logEvent('LEAVE_GROUP', socket.id, { groupId });
  });

  // Listen for group messages - Real-time group message sending
  socket.on('sendGroupMessage', async (messageData, callback) => {
    try {
      logEvent('SEND_GROUP_MESSAGE_ATTEMPT', socket.id, messageData);

      // Get user token from handshake auth
      const token = socket.handshake.auth?.token;
      if (!token) {
        logEvent('AUTH_ERROR', socket.id, { error: 'No authentication token provided' });
        callback({ error: 'Authentication required' });
        return;
      }

      // Validate message data
      const { sender_id, group_id, content, reply_to } = messageData;

      if (!sender_id || !group_id || !content) {
        logEvent('ERROR', socket.id, {
          error: 'Missing required group message fields',
          data: messageData
        });
        callback({ error: 'Missing required fields: sender_id, group_id, or content' });
        return;
      }

      if (content.length > 1000) {
        logEvent('ERROR', socket.id, {
          error: 'Group message too long',
          length: content.length
        });
        callback({ error: 'Message exceeds maximum length of 1000 characters' });
        return;
      }

      // Create authenticated Supabase client for the user
      const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        },
        db: {
          schema: 'public',
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });

      // Validate token by checking user authentication
      const { data: userData, error: authError } = await userSupabase.auth.getUser();
      if (authError || !userData.user) {
        logEvent('AUTH_ERROR', socket.id, {
          error: 'Invalid or expired token',
          authError: authError?.message
        });
        callback({ error: 'Authentication failed. Please log in again.' });
        return;
      }

      // Verify sender_id matches authenticated user
      if (userData.user.id !== sender_id) {
        logEvent('AUTH_ERROR', socket.id, {
          error: 'Sender ID mismatch',
          authenticatedUser: userData.user.id,
          providedSenderId: sender_id
        });
        callback({ error: 'Authentication mismatch. Please log in again.' });
        return;
      }

      // First, insert the message into Supabase database
      const { data, error } = await userSupabase
        .from('group_messages')
        .insert([{
          sender_id,
          group_id,
          content,
          reply_to: reply_to || null
        }])
        .select('*')
        .single();

      if (error) {
        logEvent('SUPABASE_ERROR', socket.id, {
          error: error.message,
          code: error.code
        });
        callback({ error: 'Failed to save group message to database' });
        return;
      }

      const savedMessage = data;
      logEvent('GROUP_MESSAGE_SAVED', socket.id, {
        messageId: savedMessage.id,
        sender_id,
        group_id
      });

      // Emit the saved message to all group members for real-time delivery
      io.to(`group-${group_id}`).emit('receiveGroupMessage', savedMessage);

      // Emit confirmation back to sender (optional, for status update)
      socket.emit('groupMessageSent', {
        tempId: messageData.tempId,
        messageId: savedMessage.id,
        status: 'sent'
      });

      logEvent('GROUP_MESSAGE_DELIVERED', socket.id, {
        messageId: savedMessage.id,
        deliveredTo: `group-${group_id}`
      });

      // Acknowledge the sendGroupMessage emit
      callback({ message: savedMessage });

    } catch (error) {
      logEvent('UNEXPECTED_ERROR', socket.id, {
        error: error.message,
        stack: error.stack
      });
      callback({ error: 'An unexpected error occurred. Please try again.' });
    }
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
