// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const port = process.env.PORT || 3000;
const ROOM_EXPIRATION_TIME = 60 * 60 * 1000; // 60 minutes in milliseconds

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for rooms
// rooms = { roomName: { occupants: [socketId1, socketId2], creator: socketId1, timerId: setTimeout(...), expired: false } }
const rooms = {};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('create or join', (roomName) => {
    console.log(`User ${socket.id} attempting to create or join room ${roomName}`);

    if (rooms[roomName] && rooms[roomName].expired) {
        socket.emit('room expired notification', roomName);
        console.log(`User ${socket.id} tried to join expired room ${roomName}.`);
        return;
    }

    if (!rooms[roomName]) {
      // Room does not exist - create it
      rooms[roomName] = {
        occupants: [socket.id],
        creator: socket.id,
        timerId: setTimeout(() => {
          expireRoom(roomName);
        }, ROOM_EXPIRATION_TIME),
        expired: false, // Add an expired flag
      };
      socket.join(roomName);
      socket.emit('created', roomName, socket.id);
      console.log(`Room ${roomName} created by ${socket.id}. Expiration timer started.`);
    } else if (rooms[roomName].occupants.length === 1) {
      // Room exists and has one occupant - join it
      rooms[roomName].occupants.push(socket.id);
      socket.join(roomName);
      socket.emit('joined', roomName, socket.id);
      // Notify the other user in the room
      io.to(rooms[roomName].creator).emit('other user joined', roomName, socket.id);
      console.log(`User ${socket.id} joined room ${roomName}`);
    } else {
      // Room is full (or potentially expired and not yet cleaned up, though 'expired' flag should handle this)
      socket.emit('full', roomName);
      console.log(`Room ${roomName} is full. User ${socket.id} cannot join.`);
    }
  });

  // Relay WebRTC signaling messages
  socket.on('offer', (roomName, description) => {
    if (!rooms[roomName] || rooms[roomName].expired) return; // Ignore if room doesn't exist or expired
    console.log(`Offer from ${socket.id} for room ${roomName}`);
    const room = rooms[roomName]; // Get the room object
    const otherUser = room.occupants.find(id => id !== socket.id);
    if (otherUser) {
      io.to(otherUser).emit('offer', socket.id, description);
    }
  });

  socket.on('answer', (roomName, description) => {
    if (!rooms[roomName] || rooms[roomName].expired) return;
    console.log(`Answer from ${socket.id} for room ${roomName}`);
    const room = rooms[roomName]; // Get the room object
    const otherUser = room.occupants.find(id => id !== socket.id);
    if (otherUser) {
      io.to(otherUser).emit('answer', socket.id, description);
    }
  });

  socket.on('candidate', (roomName, candidate) => {
    if (!rooms[roomName] || rooms[roomName].expired) return;
    console.log(`ICE Candidate from ${socket.id} for room ${roomName}`);
    const room = rooms[roomName]; // Get the room object
    const otherUser = room.occupants.find(id => id !== socket.id);
    if (otherUser) {
      io.to(otherUser).emit('candidate', socket.id, candidate);
    }
  });

  const handleLeaveRoom = (socketId, leavingRoomName = null) => {
    // If leavingRoomName is provided, target that specific room.
    // Otherwise, iterate through all rooms to find the user.
    const roomNamesToProcess = leavingRoomName ? [leavingRoomName] : Object.keys(rooms);

    for (const roomName of roomNamesToProcess) {
        const room = rooms[roomName];
        if (room && !room.expired) { // Process only active rooms
            const userIndex = room.occupants.indexOf(socketId);
            if (userIndex !== -1) {
                console.log(`User ${socketId} left room ${roomName}`);
                room.occupants.splice(userIndex, 1);

                // Make the socket instance leave the room on the server side
                const clientSocket = io.sockets.sockets.get(socketId);
                if(clientSocket) {
                    clientSocket.leave(roomName);
                }

                if (room.occupants.length > 0) {
                    const otherUser = room.occupants[0]; // The only one left
                    io.to(otherUser).emit('user left', socketId);
                } else {
                    // Room is empty, clear timer and delete it
                    console.log(`Room ${roomName} is now empty. Clearing timer and deleting.`);
                    if (room.timerId) {
                        clearTimeout(room.timerId);
                    }
                    delete rooms[roomName];
                }
                // If a specific room was targeted and found, no need to check other rooms for this socketId
                if (leavingRoomName) break;
            }
        }
    }
  };

  socket.on('bye', (roomName) => {
    console.log(`User ${socket.id} sent "bye" for room ${roomName}`);
    // Ensure the room exists and is not expired before processing "bye"
    if (rooms[roomName] && !rooms[roomName].expired) {
        handleLeaveRoom(socket.id, roomName);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    handleLeaveRoom(socket.id); // Pass socket.id, let the function find the room(s)
  });
});

function expireRoom(roomName) {
  console.log(`Room ${roomName} is expiring.`);
  const room = rooms[roomName];
  if (room && !room.expired) { // Check if not already expired (e.g. by manual cleanup or becoming empty)
    room.expired = true; // Mark as expired

    // Notify all occupants in the room
    room.occupants.forEach(socketId => {
      io.to(socketId).emit('room expired notification', roomName);
      // Optionally, force disconnect clients or rely on client-side handling
      const clientSocket = io.sockets.sockets.get(socketId);
      if(clientSocket) {
          clientSocket.leave(roomName); // Make socket instance leave the room on server-side
          // clientSocket.disconnect(true); // Force disconnect the socket
      }
    });
    console.log(`Notified occupants of room ${roomName} about expiration and made them leave.`);

    // Clean up the room data after a short delay to allow notifications to send
    // and ensure all leave operations are processed.
    setTimeout(() => {
        if (rooms[roomName]) { // Check if it wasn't deleted by becoming empty in the meantime
             console.log(`Deleting expired room ${roomName} from server memory.`);
             if (room.timerId) clearTimeout(room.timerId); // Timer should have fired, but clear just in case
             delete rooms[roomName];
        }
    }, 5000); // 5 seconds delay for cleanup
  }
}

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
