// public/script.js
console.log("Script loaded.");

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const roomNameInput = document.getElementById('roomName');
const joinButton = document.getElementById('joinButton');
const statusText = document.getElementById('statusText');
const hangupButton = document.getElementById('hangupButton');

let localStream;
let remoteStream;
let peerConnection;
let currentRoomName;
let isCaller; // True if this client created the room

const socket = io();

// STUN server configuration
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// Helper function to update status messages
function updateStatus(message, isError = false) {
  console.log(`Status: ${message}`);
  statusText.textContent = message;
  statusText.style.color = isError ? 'var(--error-color)' : 'var(--success-color)'; // Use CSS variables
  if (isError) {
      // Optionally add a class for more distinct styling
      statusText.classList.add('error-message');
  } else {
      statusText.classList.remove('error-message');
  }
}

// --- Socket.IO Event Handlers ---
socket.on('created', (room, clientId) => {
  console.log(`Room ${room} created by ${clientId}. You are the creator.`);
  isCaller = true;
  updateStatus('Room created. Waiting for another user to join...');
  hangupButton.style.display = 'inline-block'; // Show hangup button
  joinButton.disabled = true; // Disable join while in a room
  roomNameInput.disabled = true;
});

socket.on('joined', (room, clientId) => {
  console.log(`Successfully joined room ${room}. Your ID is ${clientId}.`);
  isCaller = false;
  updateStatus('Successfully joined room. Waiting for connection...');
  hangupButton.style.display = 'inline-block'; // Show hangup button
  joinButton.disabled = true; // Disable join while in a room
  roomNameInput.disabled = true;
  // The joiner will initiate media access and then the offer process is triggered by 'other user joined' on creator side
  // For the joiner, 'other user joined' is not directly relevant for starting, they wait for 'offer'
});

socket.on('other user joined', (room, otherUserId) => {
  console.log(`Another user ${otherUserId} joined room ${room}.`);
  if (isCaller) {
    updateStatus('Another user joined. Setting up call...');
    // ... (rest of the existing logic for creating peer connection and offer)
    // (Make sure createPeerConnection and getUserMedia calls have .catch for errors and updateStatus)
    createPeerConnection(); // Ensure this is called
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        localStream = stream;
        localVideo.srcObject = localStream;
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        updateStatus('Creating offer...');
        return peerConnection.createOffer();
      })
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => {
        updateStatus('Offer created. Sending to other user...');
        socket.emit('offer', currentRoomName, peerConnection.localDescription);
      })
      .catch(error => {
          console.error('Error in other user joined sequence (caller):', error);
          updateStatus(`Error: ${error.message}`, true);
          hangup(); // Clean up if error occurs
      });
  } else {
      updateStatus('Connected with another user.'); // For the joiner
  }
});

socket.on('offer', (fromId, offer) => {
  console.log(`Received offer from ${fromId}:`, offer);
  if (!isCaller && !peerConnection) { // Ensure PC is not already made and this client is joiner
    updateStatus('Received offer. Getting your media and creating answer...');
    createPeerConnection(); // Ensure this is called
    peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
      .then(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true }))
      .then(stream => {
        localStream = stream;
        localVideo.srcObject = localStream;
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        updateStatus('Creating answer...');
        return peerConnection.createAnswer();
      })
      .then(answer => peerConnection.setLocalDescription(answer))
      .then(() => {
        updateStatus('Answer created. Sending to other user...');
        socket.emit('answer', currentRoomName, peerConnection.localDescription);
      })
      .catch(error => {
        console.error('Error handling offer or creating answer:', error);
        updateStatus(`Error processing offer: ${error.message}`, true);
        hangup();
      });
  } else if (peerConnection && isCaller) {
      // This scenario (caller receiving an offer) should ideally not happen if flow is correct
      console.warn("Caller received an offer, which is unusual. Ignoring.");
  } else if (peerConnection && !isCaller) {
      // If joiner receives another offer (e.g. due to glare), handle appropriately
      // For simplicity, current logic might just try to process it if PC exists
      console.log("Joiner received another offer. Current logic will attempt to process.");
       peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
      .then(() => { /* ... continue answer process ... */ })
      .catch(error => updateStatus(`Error processing subsequent offer: ${error.message}`, true));
  }
});

socket.on('answer', (fromId, answer) => {
  console.log(`Received answer from ${fromId}:`, answer);
  if (isCaller) {
    updateStatus('Received answer. Connecting...');
    peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
      .then(() => {
        updateStatus('Call connected!');
        // Connection is established
      })
      .catch(error => {
        console.error('Error setting remote description from answer:', error);
        updateStatus(`Error connecting: ${error.message}`, true);
        hangup();
      });
  }
});

socket.on('candidate', (fromId, candidate) => {
  console.log(`Received ICE candidate from ${fromId}`);
  const iceCandidate = new RTCIceCandidate(candidate);
  if (peerConnection) { // Ensure peerConnection exists
    peerConnection.addIceCandidate(iceCandidate)
      .catch(error => {
          console.error('Error adding received ICE candidate:', error);
          // Don't show this specific error to user unless it causes connection failure
      });
  } else {
      console.warn("Received ICE candidate but peerConnection is not initialized.");
  }
});


socket.on('full', (room) => {
  console.log(`Room ${room} is full.`);
  updateStatus(`Room "${room}" is full. Try another room.`, true);
  // Re-enable UI
  roomNameInput.disabled = false;
  joinButton.disabled = false;
  currentRoomName = null; // Reset current room name
  hangupButton.style.display = 'none';
});

socket.on('user left', (userId) => {
  console.log(`User ${userId} left the room.`);
  updateStatus('The other user has left the call. Call ended.', false);
  hangup(); // Perform cleanup
});

socket.on('room expired notification', (room) => {
  console.log(`Room ${room} has expired.`);
  updateStatus(`Room "${room}" has expired. Call ended.`, true);
  if (currentRoomName === room) {
    hangup();
  }
  // Ensure UI is fully reset if not already handled by hangup
  roomNameInput.disabled = false;
  joinButton.disabled = false;
  hangupButton.style.display = 'none';
  if (currentRoomName === room) {
      currentRoomName = null;
  }
});


// --- WebRTC Logic Functions ---
function createPeerConnection() {
  console.log('Creating PeerConnection...');
  // updateStatus('Initializing connection...'); // Moved to more specific points
  peerConnection = new RTCPeerConnection(iceServers);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('Sending ICE candidate:', event.candidate);
      socket.emit('candidate', currentRoomName, event.candidate);
    }
  };

  peerConnection.ontrack = (event) => {
    console.log('Remote track received:', event.streams[0]);
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteStream = event.streams[0];
      updateStatus('Remote video connected.'); // Good place for this
    }
  };

  // Handle ICE connection state changes for debugging
  peerConnection.oniceconnectionstatechange = () => {
    console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
    switch (peerConnection.iceConnectionState) {
      case 'checking':
        updateStatus('Connecting to peer...');
        break;
      case 'connected': //This means transport is established, but media might still be setting up.
        // 'Call connected!' is better placed after answer is set by caller.
        // updateStatus('ICE connection established.');
        break;
      case 'completed':
        // updateStatus('ICE connection completed.'); // All ICE exchanges are done
        break;
      case 'failed':
        updateStatus('Connection failed. Please try again.', true);
        hangup();
        break;
      case 'disconnected':
        updateStatus('User disconnected. Attempting to reconnect...', true);
        // WebRTC can sometimes self-recover from 'disconnected'
        break;
      case 'closed':
        // updateStatus('Connection closed.'); // Usually handled by user left or hangup
        break;
    }
  };
}

function joinRoom() {
  const room = roomNameInput.value.trim();
  if (!room) {
    updateStatus('Please enter a room name to join or create.', true);
    return;
  }

  if (currentRoomName) {
      updateStatus('You are already in a room. Please leave before joining another.', true);
      return;
  }

  updateStatus(`Attempting to join/create room: "${room}"...`);
  currentRoomName = room;
  socket.emit('create or join', currentRoomName);

  roomNameInput.disabled = true;
  joinButton.disabled = true;
  // hangupButton will be displayed on 'created' or 'joined'
}

function hangup() {
  console.log('Hanging up call.');
  updateStatus('Call ended.');
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
  if (remoteStream) {
    remoteVideo.srcObject = null;
    remoteStream = null;
  }

  if (currentRoomName) { // Only emit 'bye' if actually in a room
    socket.emit('bye', currentRoomName);
  }

  roomNameInput.disabled = false;
  joinButton.disabled = false;
  hangupButton.style.display = 'none';
  currentRoomName = null;
  isCaller = null;
  // Reset status text to default after a short delay
  setTimeout(() => {
      if (!currentRoomName) { // Only reset if not immediately joining another room
          updateStatus("Enter a room name and click 'Join' to start.");
          statusText.style.color = 'var(--primary-text)'; // Reset color
          statusText.classList.remove('error-message');
      }
  }, 2000);
  console.log('Call cleanup complete.');
}

// --- Event Listeners ---
joinButton.addEventListener('click', joinRoom);
hangupButton.addEventListener('click', hangup); // Add listener for new hangup button

console.log('Frontend script initialized with UI enhancements.');

// Make sure createPeerConnection is defined before it's called in socket.on('other user joined') and socket.on('offer')
// This is already the case as it's a function declaration.
