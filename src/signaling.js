const { Server } = require('socket.io');

let io = null;
const rooms = new Map();

function setupSignaling(server) {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    allowEIO3: true
  });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, 'query:', JSON.stringify(socket.handshake.query));
    socket.role = socket.handshake.query.role || 'phone';

    socket.on('join', (deviceId) => {
      socket.join(deviceId);
      socket.deviceId = deviceId;

      if (!rooms.has(deviceId)) {
        rooms.set(deviceId, { phone: null, dashboard: null });
      }
      const room = rooms.get(deviceId);

      if (socket.role === 'phone') {
        room.phone = socket.id;
        console.log(`Phone joined room: ${deviceId}`);
        if (room.dashboard) {
          io.to(room.dashboard).emit('phone-connected', { deviceId });
        }
      } else {
        room.dashboard = socket.id;
        console.log(`Dashboard joined room: ${deviceId}`);
        if (room.phone) {
          io.to(room.phone).emit('dashboard-connected', { deviceId });
          io.to(room.dashboard).emit('phone-connected', { deviceId });
        }
      }
    });

    // Phone sends camera frame via socket.io (real-time)
    socket.on('frame-binary', (data) => {
      const deviceId = socket.deviceId;
      if (deviceId) {
        io.to(deviceId).emit('frame', data);
      }
    });

    // Phone sends audio chunk via socket.io (real-time)
    socket.on('audio-binary', (data) => {
      const deviceId = socket.deviceId;
      if (deviceId) {
        io.to(deviceId).emit('audio', data);
      }
    });

    // Dashboard sends camera command via socket.io
    socket.on('camera-command', (data) => {
      const deviceId = socket.deviceId;
      if (deviceId) {
        const room = rooms.get(deviceId);
        if (room && room.phone) {
          io.to(room.phone).emit('camera-command', data);
        }
      }
    });

    // Dashboard sends audio command via socket.io
    socket.on('audio-command', (data) => {
      const deviceId = socket.deviceId;
      if (deviceId) {
        const room = rooms.get(deviceId);
        if (room.phone) {
          io.to(room.phone).emit('audio-command', data);
        }
      }
    });

    socket.on('disconnect', () => {
      const deviceId = socket.deviceId;
      if (deviceId && rooms.has(deviceId)) {
        const room = rooms.get(deviceId);
        if (room.phone === socket.id) {
          room.phone = null;
          if (room.dashboard) io.to(room.dashboard).emit('phone-disconnected', { deviceId });
        } else if (room.dashboard === socket.id) {
          room.dashboard = null;
          if (room.phone) io.to(room.phone).emit('dashboard-disconnected', { deviceId });
        }
        if (!room.phone && !room.dashboard) rooms.delete(deviceId);
      }
    });
  });

  return io;
}

function getIO() { return io; }
function getRooms() { return rooms; }

module.exports = { setupSignaling, getIO, getRooms };
