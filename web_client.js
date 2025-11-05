const iceConnectionLog = document.getElementById('ice-connection-state'),
  signalingLog = document.getElementById('signaling-state'),
  dataChannelLog = document.getElementById('datachannel-state');

clientId = '000000';
const websocket = new WebSocket('wss://api.crossdesk.cn:9090');
let pc = null;
let dc = null;

let heartbeatInterval = null;
let lastPongTime = Date.now();

function startHeartbeat() {
  stopHeartbeat();
  lastPongTime = Date.now();

  heartbeatInterval = setInterval(() => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }

    if (Date.now() - lastPongTime > 10000) {
      console.warn('WebSocket heartbeat timeout, reconnecting...');
      stopHeartbeat();
      reconnectWebSocket();
    }
  }, 3000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

websocket.addEventListener('message', (evt) => {
  lastPongTime = Date.now();
});


function reconnectWebSocket() {
  try {
    websocket.close();
  } catch (e) {
    console.error('Error closing websocket:', e);
  }

  console.log('Reconnecting WebSocket...');
  setTimeout(() => {
    window.location.reload();
  }, 2000);
}

websocket.onopen =
  () => {
    document.getElementById('connect').disabled = false;
    sendLogin();
    startHeartbeat();
  }

websocket.onmessage =
  async (evt) => {
    if (typeof evt.data !== 'string') {
      return;
    }
    const message = JSON.parse(evt.data);
    if (message.type == 'login') {
      clientId = message.user_id.split('@')[0];
      console.log('Logged in as: ' + clientId);

    } else if (message.type == 'offer') {
      await handleOffer(message)
    } else if (message.type == 'new_candidate_mid') {
      if (pc == null) {
        console.warn('PeerConnection not exist when adding candidate');
      } else {
        // console.log('received new candidate: ' + message.candidate);
        const candidate = new RTCIceCandidate(
          { sdpMid: message.mid, candidate: message.candidate });
        pc.addIceCandidate(candidate).catch(e => {
          console.error('Error adding received ice candidate', e);
        });
      }
    }
  }

function createPeerConnection() {
  const config = {};

  config.iceServers = [
    { urls: ['stun:api.crossdesk.cn:3478'] }, {
      urls: ['turn:api.crossdesk.cn:3478'],
      username: 'crossdesk',
      credential: 'crossdeskpw'
    }
  ];

  config.iceTransportPolicy = 'all';

  pc = new RTCPeerConnection(config);

  // Register some listeners to help debugging
  pc.addEventListener(
    'iceconnectionstatechange',
    () => iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState);
  iceConnectionLog.textContent = pc.iceConnectionState;

  pc.addEventListener(
    'signalingstatechange',
    () => signalingLog.textContent += ' -> ' + pc.signalingState);
  signalingLog.textContent = pc.signalingState;
  
  // onicecandidate
  pc.onicecandidate = function (event) {
    var ice_candidate = event.candidate;
    if (!ice_candidate) return;

    websocket.send(JSON.stringify({
      type: 'new_candidate_mid',
      transmission_id: getTransmissionId(),
      user_id: clientId,
      remote_user_id: getTransmissionId(),
      candidate: ice_candidate.candidate,
      mid: ice_candidate.sdpMid
    }));
    // console.log('sent new candidate: ' + ice_candidate.candidate);
  };

  // Receive audio/video track
  // More robust handling of audio/video track
  pc.ontrack = (evt) => {
    const video = document.getElementById('video');
    const trackIdEl = document.getElementById('track-id');

    // Only handle video track
    if (evt.track.kind !== 'video') return;

    // Update track id display
    if (trackIdEl) {
      trackIdEl.textContent = evt.track.id ? `(${evt.track.id})` : '';
    }

    if (!video.srcObject) {
      const stream = evt.streams && evt.streams[0] ?
        evt.streams[0] :
        new MediaStream([evt.track]);

      video.setAttribute('playsinline', true);
      video.setAttribute('webkit-playsinline', true);
      video.setAttribute('x5-video-player-type', 'h5');
      video.setAttribute('x5-video-player-fullscreen', 'true');
      video.setAttribute('autoplay', true);
      video.muted = true;

      video.srcObject = stream;


      const playVideo = () => {
        video.play().catch(err => {
          console.warn('video.play() failed:', err);
          setTimeout(playVideo, 1000);
        });
      };


      console.log('Attached new video stream:', evt.track.id);
    } else {
      video.srcObject.addTrack(evt.track);
      console.log('Added track to existing stream:', evt.track.id);
    }
  };

  // Receive data channel
  pc.ondatachannel =
    (evt) => {
      dc = evt.channel;

      dc.onopen = () => {

        dataChannelLog.textContent = 'open\n';
        dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
      };

      let dcTimeout = null;
      dc.onmessage =
        (evt) => {
          if (typeof evt.data !== 'string') {
            return;
          }

          dataChannelLog.textContent += '< ' + evt.data + '\n';
          dataChannelLog.scrollTop = dataChannelLog.scrollHeight;

          dcTimeout = setTimeout(() => {
            if (!dc) {
              return;
            }
            const message = `Pong ${currentTimestamp()}`;
            dataChannelLog.textContent += '> ' + message + '\n';
            dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
            dc.send(message);
          }, 1000);
        }

      dc.onclose = () => {
        clearTimeout(dcTimeout);
        dcTimeout = null;
        dataChannelLog.textContent = '';
        dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
      };
    }

  return pc;
}

async function waitGatheringComplete() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
    } else {
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        }
      });
    }
  });
}

async function sendAnswer(pc) {
  await pc.setLocalDescription(await pc.createAnswer());
  await waitGatheringComplete();

  const answer = pc.localDescription;

  msg = JSON.stringify({
    type: 'answer',
    transmission_id: getTransmissionId(),
    user_id: clientId,
    remote_user_id: getTransmissionId(),
    sdp: answer.sdp,
  });
  // console.log("send answer: " + msg);

  websocket.send(msg);
}

async function handleOffer(offer) {
  pc = createPeerConnection();
  await pc.setRemoteDescription(offer);
  await sendAnswer(pc);
}

function sendLogin() {
  websocket.send(JSON.stringify({
    type: 'login',
    user_id: 'web',
  }));
  console.log('Send login');
}

function leaveTransmission() {
  websocket.send(JSON.stringify({
    type: 'leave_transmission',
    user_id: clientId,
    transmission_id: getTransmissionId(),
  }));
  console.log('Leave transmission: ' + getTransmissionId());
}

function getTransmissionId() {
  return document.getElementById('transmission-id').value;
}

// Add function to get password
function getTransmissionPwd() {
  return document.getElementById('transmission-pwd').value;
}

// Modify sendRequest function to use dynamic password
function sendRequest() {
  websocket.send(JSON.stringify({
    type: 'join_transmission',
    user_id: clientId,
    transmission_id: getTransmissionId() + '@' + getTransmissionPwd(),
  }));
  console.log('Join transmission: ' + getTransmissionId());
}

function connect() {
  document.getElementById('connect').style.display = 'none';
  document.getElementById('disconnect').style.display = 'inline-block';
  document.getElementById('media').style.display = 'block';
  sendRequest();
}

function disconnect() {
  document.getElementById('disconnect').style.display = 'none';
  document.getElementById('media').style.display = 'none';
  document.getElementById('connect').style.display = 'inline-block';

  leaveTransmission();

  // close data channel
  if (dc) {
    dc.close();
    dc = null;
  }

  // close transceivers
  if (pc.getTransceivers) {
    pc.getTransceivers().forEach((transceiver) => {
      if (transceiver.stop) {
        transceiver.stop();
      }
    });
  }

  // close local audio/video
  pc.getSenders().forEach((sender) => {
    const track = sender.track;
    if (track !== null) {
      sender.track.stop();
    }
  });

  // close peer connection
  pc.close();
  pc = null;


  const video = document.getElementById('video');
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }

  const trackIdEl = document.getElementById('track-id');
  if (trackIdEl) {
    trackIdEl.textContent = '';
  }
  
  iceConnectionLog.textContent = '';
  signalingLog.textContent = '';
  dataChannelLog.textContent += '- disconnected\n';
}


// Helper function to generate a timestamp
let startTime = null;
function currentTimestamp() {
  if (startTime === null) {
    startTime = Date.now();
    return 0;
  } else {
    return Date.now() - startTime;
  }
}
