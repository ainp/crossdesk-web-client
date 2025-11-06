// WebRTC + WebSocket 信令模块
(function () {
  const iceConnectionLog = document.getElementById('ice-connection-state');
  const signalingLog = document.getElementById('signaling-state');

  let clientId = '000000';
  const websocket = new WebSocket('wss://api.crossdesk.cn:9090');
  let pc = null;

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
  function stopHeartbeat() { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } }

  websocket.addEventListener('message', (evt) => { lastPongTime = Date.now(); });

  function reconnectWebSocket() {
    try { websocket.close(); } catch (e) { }
    console.log('Reconnecting WebSocket...');
    setTimeout(() => { window.location.reload(); }, 2000);
  }

  websocket.onopen = () => {
    document.getElementById('connect').disabled = false;
    sendLogin();
    startHeartbeat();
  };

  websocket.onmessage = async (evt) => {
    if (typeof evt.data !== 'string') return;
    const message = JSON.parse(evt.data);
    if (message.type == 'login') {
      clientId = message.user_id.split('@')[0];
      console.log('Logged in as: ' + clientId);
    } else if (message.type == 'offer') {
      await handleOffer(message);
    } else if (message.type == 'new_candidate_mid') {
      if (!pc) { console.warn('PeerConnection not exist when adding candidate'); }
      else {
        const candidate = new RTCIceCandidate({ sdpMid: message.mid, candidate: message.candidate });
        pc.addIceCandidate(candidate).catch(e => { console.error('Error adding received ice candidate', e); });
      }
    }
  };

  function createPeerConnection() {
    const config = {};
    config.iceServers = [{ urls: ['stun:api.crossdesk.cn:3478'] }, { urls: ['turn:api.crossdesk.cn:3478'], username: 'crossdesk', credential: 'crossdeskpw' }];
    config.iceTransportPolicy = 'all';
    pc = new RTCPeerConnection(config);

    pc.addEventListener('iceconnectionstatechange', () => iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState);
    iceConnectionLog.textContent = pc.iceConnectionState;
    pc.addEventListener('signalingstatechange', () => signalingLog.textContent += ' -> ' + pc.signalingState);
    signalingLog.textContent = pc.signalingState;

    pc.onicecandidate = function (event) {
      var ice_candidate = event.candidate;
      if (!ice_candidate) return;
      websocket.send(JSON.stringify({ type: 'new_candidate_mid', transmission_id: getTransmissionId(), user_id: clientId, remote_user_id: getTransmissionId(), candidate: ice_candidate.candidate, mid: ice_candidate.sdpMid }));
    };

    pc.ontrack = (evt) => {
      const video = document.getElementById('video');
      if (evt.track.kind !== 'video') return;
      // Record track ID and fill it back to the display ID input field
      window.CROSSDESK_TRACK_ID = evt.track.id || '';
      const displayIdInput = document.getElementById('display-id');
      if (displayIdInput) {
        if (displayIdInput.tagName === 'SELECT') {
          const sel = displayIdInput;
          const tid = window.CROSSDESK_TRACK_ID;
          if (tid) {
            let exists = false;
            for (let i = 0; i < sel.options.length; i++) {
              if (sel.options[i].value === tid) { exists = true; break; }
            }
            if (!exists) {
              const opt = document.createElement('option');
              opt.value = tid; opt.textContent = tid; sel.appendChild(opt);
            }
            sel.value = tid;
          }
        } else {
          displayIdInput.value = window.CROSSDESK_TRACK_ID;
        }
      }
      if (!video.srcObject) {
        const stream = evt.streams && evt.streams[0] ? evt.streams[0] : new MediaStream([evt.track]);
        video.setAttribute('playsinline', true);
        video.setAttribute('webkit-playsinline', true);
        video.setAttribute('x5-video-player-type', 'h5');
        video.setAttribute('x5-video-player-fullscreen', 'true');
        video.setAttribute('autoplay', true);
        video.muted = true;
        video.srcObject = stream;
      } else {
        video.srcObject.addTrack(evt.track);
      }
    };

    pc.ondatachannel = (evt) => {
      const dc = evt.channel;
      dc.onopen = () => {
        console.log('Data channel opened');
        if (window.CrossDeskControl && window.CrossDeskControl.onDataChannelOpen) {
          window.CrossDeskControl.onDataChannelOpen(dc);
        }
      };
      dc.onmessage = (evt) => { if (typeof evt.data !== 'string') return; console.log('Received datachannel message: ' + evt.data); };
      dc.onclose = () => {
        if (window.CrossDeskControl && window.CrossDeskControl.onDataChannelClose) {
          window.CrossDeskControl.onDataChannelClose();
        }
      };
    };

    return pc;
  }

  function waitGatheringComplete() { return new Promise((resolve) => { if (pc.iceGatheringState === 'complete') { resolve(); } else { pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { resolve(); } }); } }); }

  async function sendAnswer(pc) {
    await pc.setLocalDescription(await pc.createAnswer());
    await waitGatheringComplete();
    const answer = pc.localDescription;
    websocket.send(JSON.stringify({ type: 'answer', transmission_id: getTransmissionId(), user_id: clientId, remote_user_id: getTransmissionId(), sdp: answer.sdp }));
  }

  async function handleOffer(offer) { pc = createPeerConnection(); await pc.setRemoteDescription(offer); await sendAnswer(pc); }

  function sendLogin() { websocket.send(JSON.stringify({ type: 'login', user_id: 'web' })); }

  function leaveTransmission() { websocket.send(JSON.stringify({ type: 'leave_transmission', user_id: clientId, transmission_id: getTransmissionId(), })); }

  function getTransmissionId() { return document.getElementById('transmission-id').value; }
  function getTransmissionPwd() { return document.getElementById('transmission-pwd').value; }

  function sendRequest() { websocket.send(JSON.stringify({ type: 'join_transmission', user_id: clientId, transmission_id: getTransmissionId() + '@' + getTransmissionPwd(), })); }

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
    if (pc) {
      try {
        // Close local sending tracks
        pc.getSenders().forEach((sender) => { const track = sender.track; if (track !== null) { sender.track.stop(); } });
      } catch (e) { }
      pc.close();
      pc = null;
    }
    const video = document.getElementById('video');
    if (video && video.srcObject) { video.srcObject.getTracks().forEach(track => track.stop()); video.srcObject = null; }
    iceConnectionLog.textContent = ''; signalingLog.textContent = '';
    if (window.CrossDeskControl && window.CrossDeskControl.onDataChannelClose) { window.CrossDeskControl.onDataChannelClose(); }
  }

  // Expose connection control functions
  window.connect = connect;
  window.disconnect = disconnect;
})();


