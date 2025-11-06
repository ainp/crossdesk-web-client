const iceConnectionLog = document.getElementById('ice-connection-state'),
  signalingLog = document.getElementById('signaling-state'),
  dataChannelStateSpan = document.getElementById('datachannel-state'),
  dataChannelLog = document.getElementById('data-channel'),
  dcInput = document.getElementById('dc-input'),
  dcSendBtn = document.getElementById('dc-send');

// New: Audio capture and display controls
const audioCaptureChk = document.getElementById('audio-capture');
const displayIdInput = document.getElementById('display-id');
// Provide button onClick usage
function setDisplayId() {
  if (!displayIdInput) return;
  const id = parseInt(displayIdInput.value || '0', 10) || 0;
  sendDisplayId(id);
}

clientId = '000000';
const websocket = new WebSocket('wss://api.crossdesk.cn:9090');
let pc = null;
let dc = null;

let heartbeatInterval = null;
let lastPongTime = Date.now();

const clientProperties = {
  "remote1": {
    control_mouse_: true,
    stream_render_rect_: { x: 0, y: 0, w: 800, h: 600 },
    peer_: "remote_peer_1",
    data_label_: "remote_label_1"
  },
  "remote2": {
    control_mouse_: true,
    stream_render_rect_: { x: 0, y: 0, w: 800, h: 600 },
    peer_: "remote_peer_2",
    data_label_: "remote_label_2"
  }
};

let lastMouseEvent = { button: { x: 0, y: 0 } };

// New: Used to calculate movement increments (pointer/touch)
let lastPointerPos = null;

// New: Pointer state and tooltips
let isPointerLocked = false;
let videoRect = null;
let normalizedPos = { x: 0.5, y: 0.5 };

let _pointerlock_toast_timeout = null;
// 协议：ControlType 与 MouseFlag（需发送为数字枚举）
const ControlType = {
  mouse: 0,
  keyboard: 1,
  audio_capture: 2,
  host_infomation: 3,
  display_id: 4
};

const MouseFlag = {
  move: 0,
  left_down: 1,
  left_up: 2,
  right_down: 3,
  right_up: 4,
  middle_down: 5,
  middle_up: 6,
  wheel_vertical: 7,
  wheel_horizontal: 8
};
function showPointerLockToast(text, duration = 2500) {
  let el = document.getElementById('pointerlock-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pointerlock-toast';
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '6px',
      fontSize: '13px',
      zIndex: '9999',
      pointerEvents: 'none',
      opacity: '1',
      transition: 'opacity 0.2s'
    });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  if (_pointerlock_toast_timeout) clearTimeout(_pointerlock_toast_timeout);
  _pointerlock_toast_timeout = setTimeout(() => {
    el.style.opacity = '0';
    _pointerlock_toast_timeout = null;
  }, duration);
}

function setupMouseListeners() {
  const video = document.getElementById('video');
  if (!video) return;

  // Prevent default browser touch behavior (such as scrolling/zooming)
  try { video.style.touchAction = 'none'; } catch (e) { }

  // pointer lock state change
  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = (document.pointerLockElement === video);
    if (dataChannelLog) {
      dataChannelLog.textContent += `[pointerlock ${isPointerLocked ? 'entered' : 'exited'}]\n`;
      dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
    }
    // update rect when entering/exiting
    if (isPointerLocked) {
      videoRect = video.getBoundingClientRect();
    } else {
      videoRect = null;
      // Show toast message when exiting pointer lock
      showPointerLockToast('Exited mouse lock, press Esc or click video to re-lock (release with Ctrl+Esc)', 3000);
    }
  });

  document.addEventListener('pointerlockerror', () => {
    console.warn('pointer lock error');
    showPointerLockToast('Mouse lock failed', 2500);
  });

  // Ctrl+Esc to exit pointer lock
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Escape') {
      if (document.exitPointerLock) document.exitPointerLock();
    }
  });

  // --- Pointer Events ---
  // pointerdown on video triggers mousedown and requests pointer lock
  video.addEventListener('pointerdown', (e) => {
    if (e.button < 0) return;
    e.preventDefault();
    lastPointerPos = { x: e.clientX, y: e.clientY };
    try { video.setPointerCapture && video.setPointerCapture(e.pointerId); } catch (err) { }
    sendMouseEvent({
      type: 'mousedown',
      clientX: e.clientX,
      clientY: e.clientY,
      button: (typeof e.button === 'number') ? e.button : 0
    });
  }, { passive: false });

  // pointermove handled at document level, compatible with mouse/touch/stylus
  document.addEventListener('pointermove', (e) => {
    const movementX = (lastPointerPos ? (e.clientX - lastPointerPos.x) : 0);
    const movementY = (lastPointerPos ? (e.clientY - lastPointerPos.y) : 0);
    lastPointerPos = { x: e.clientX, y: e.clientY };

    sendMouseEvent({
      type: 'mousemove',
      clientX: e.clientX,
      clientY: e.clientY,
      movementX: movementX,
      movementY: movementY
    });
  }, { passive: false });

  // pointerup / pointercancel mapped to mouseup
  document.addEventListener('pointerup', (e) => {
    try { video.releasePointerCapture && video.releasePointerCapture(e.pointerId); } catch (err) { }
    sendMouseEvent({
      type: 'mouseup',
      clientX: e.clientX,
      clientY: e.clientY,
      button: (typeof e.button === 'number') ? e.button : 0
    });
    lastPointerPos = null;
  });
  document.addEventListener('pointercancel', () => { lastPointerPos = null; });

  // --- Fallback: touch events (if pointer events are not supported) ---
  // In environments where pointer events are not supported, browsers may also trigger touch events
  if (!window.PointerEvent) {
    video.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      const t = e.touches[0];
      lastPointerPos = { x: t.clientX, y: t.clientY };
      e.preventDefault();
      sendMouseEvent({ type: 'mousedown', clientX: t.clientX, clientY: t.clientY, button: 0 });
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      const t = e.touches[0];
      const movementX = (lastPointerPos ? (t.clientX - lastPointerPos.x) : 0);
      const movementY = (lastPointerPos ? (t.clientY - lastPointerPos.y) : 0);
      lastPointerPos = { x: t.clientX, y: t.clientY };
      e.preventDefault();
      sendMouseEvent({ type: 'mousemove', clientX: t.clientX, clientY: t.clientY, movementX, movementY });
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      const t = (e.changedTouches && e.changedTouches[0]) || null;
      if (t) {
        sendMouseEvent({ type: 'mouseup', clientX: t.clientX, clientY: t.clientY, button: 0 });
      } else {
        sendMouseEvent({ type: 'mouseup', clientX: 0, clientY: 0, button: 0 });
      }
      lastPointerPos = null;
    }, { passive: false });
  }

  // Keep original wheel behavior (trackpad two-finger swipe generates wheel events)
  document.addEventListener('wheel', sendMouseEvent, { passive: true });
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function sendRemoteActionAt(normX, normY, flag, s = 0) {
  // Compatibility with old calls: flag can be string name or number
  const numericFlag = (typeof flag === 'string') ? (MouseFlag[flag] ?? MouseFlag.move) : (flag | 0);
  const remote_action = {
    type: ControlType.mouse,
    mouse: {
      x: clamp01(normX),
      y: clamp01(normY),
      s: (s | 0),
      flag: numericFlag
    }
  };
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(remote_action));
  }
  if (dataChannelLog) {
    dataChannelLog.textContent += '> ' + JSON.stringify(remote_action) + '\n';
    dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
  }
}

function sendKeyboardAction(keyValue, isDown) {
  const remote_action = {
    type: ControlType.keyboard,
    keyboard: {
      key_value: keyValue | 0,
      flag: isDown ? 0 : 1 // KeyFlag: key_down=0, key_up=1
    }
  };
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(remote_action));
  }
  if (dataChannelLog) {
    dataChannelLog.textContent += '> ' + JSON.stringify(remote_action) + '\n';
    dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
  }
}

function sendAudioCapture(enabled) {
  const remote_action = {
    type: ControlType.audio_capture,
    audio_capture: !!enabled
  };
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(remote_action));
  }
  if (dataChannelLog) {
    dataChannelLog.textContent += '> ' + JSON.stringify(remote_action) + '\n';
    dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
  }
}

function sendDisplayId(id) {
  const remote_action = {
    type: ControlType.display_id,
    display_id: id | 0
  };
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(remote_action));
  }
  if (dataChannelLog) {
    dataChannelLog.textContent += '> ' + JSON.stringify(remote_action) + '\n';
    dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
  }
}

function setupKeyboardListeners() {
  // Use keydown/keyup, send numerical keyCode (can be mapped to platform key values on backend if needed)
  const onKeyDown = (e) => {
    const keyValue = (typeof e.keyCode === 'number') ? e.keyCode : 0;
    sendKeyboardAction(keyValue, true);
  };
  const onKeyUp = (e) => {
    const keyValue = (typeof e.keyCode === 'number') ? e.keyCode : 0;
    sendKeyboardAction(keyValue, false);
  };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
}

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
        console.log('Data channel opened');
        if (dataChannelStateSpan) dataChannelStateSpan.textContent = 'open';
        if (dataChannelLog) {
          dataChannelLog.textContent += '[datachannel open]\n';
          dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
        }

        setupMouseListeners();
        setupKeyboardListeners();

        if (audioCaptureChk) {
          audioCaptureChk.disabled = false;
          audioCaptureChk.onchange = (e) => sendAudioCapture(!!e.target.checked);
        }
        if (displayIdInput) {
          displayIdInput.disabled = false;
        }
        const setDisplayBtn = document.getElementById('set-display');
        if (setDisplayBtn) setDisplayBtn.disabled = false;

        if (dcInput) { dcInput.disabled = false; console.log('Data channel is open'); }
        if (dcSendBtn) { dcSendBtn.disabled = false; console.log('Data channel is open'); }
      };

      let dcTimeout = null;
      dc.onmessage =
        (evt) => {
          if (typeof evt.data !== 'string') {
            return;
          }

          console.log('Received datachannel message: ' + evt.data);
        }

      dc.onclose = () => {
        clearTimeout(dcTimeout);
        dcTimeout = null;
        if (dataChannelStateSpan) dataChannelStateSpan.textContent = 'closed';
        if (dataChannelLog) {
          dataChannelLog.textContent += '[datachannel closed]\n';
          dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
        }
        if (dcInput) {
          dcInput.disabled = true;
          dcInput.value = '';
        }
        if (dcSendBtn) dcSendBtn.disabled = true;

        if (audioCaptureChk) {
          audioCaptureChk.disabled = true;
          audioCaptureChk.checked = false;
          audioCaptureChk.onchange = null;
        }
        if (displayIdInput) {
          displayIdInput.disabled = true;
        }
        const setDisplayBtn = document.getElementById('set-display');
        if (setDisplayBtn) setDisplayBtn.disabled = true;
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
  if (dcInput) {
    dcInput.disabled = true;
    dcInput.value = '';
  }
  if (dcSendBtn) dcSendBtn.disabled = true;

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


// Send user input messages through data channel
function sendDataChannelMessage() {
  const msg = (dcInput && dcInput.value) ? dcInput.value.trim() : '';
  if (!msg) return;
  if (!dc || dc.readyState !== 'open') {
    alert('Data channel is not open, cannot send message.');
    return;
  }
  // Only allow sending JSON that conforms to RemoteAction protocol to avoid backend parsing errors
  try {
    const obj = JSON.parse(msg);
    const isObject = obj && typeof obj === 'object' && !Array.isArray(obj);
    const hasNumericType = isObject && typeof obj.type === 'number';
    const hasValidPayload = (
      ('mouse' in obj) || ('keyboard' in obj) || ('audio_capture' in obj) || ('display_id' in obj)
    );
    if (!hasNumericType || !hasValidPayload) {
      alert('Only RemoteAction protocol JSON is supported (must have numeric type and one of: mouse/keyboard/audio_capture/display_id)');
      return;
    }
    dc.send(JSON.stringify(obj));
    if (dataChannelLog) {
      dataChannelLog.textContent += '> ' + JSON.stringify(obj) + '\n';
      dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
    }
    if (dcInput) dcInput.value = '';
  } catch (e) {
    alert('请输入合法的 JSON。');
  }
}

function sendMouseEvent(event) {
  const video = document.getElementById('video');
  if (!video) return;

  // If no videoRect (or size changed), get it again
  if (!videoRect) videoRect = video.getBoundingClientRect();

  if (event.type === 'mousedown') {
    // Only enter pointer lock when user clicks within the video area
    if (event.clientX >= videoRect.left && event.clientX <= videoRect.right &&
      event.clientY >= videoRect.top && event.clientY <= videoRect.bottom) {
      // 初始化 normalizedPos 为点击位置
      normalizedPos.x = (event.clientX - videoRect.left) / videoRect.width;
      normalizedPos.y = (event.clientY - videoRect.top) / videoRect.height;

      // 请求 Pointer Lock（必须在用户手势处理函数中调用）
      try {
        video.requestPointerLock && video.requestPointerLock();
      } catch (e) {
        console.warn('requestPointerLock failed', e);
      }

      const flag = event.button === 0 ? 'left_down' : (event.button === 2 ? 'right_down' : 'middle_down');
      sendRemoteActionAt(normalizedPos.x, normalizedPos.y, flag);
    }
    return;
  }

  if (event.type === 'mouseup') {
    // Send up event at relative position when in pointer lock; otherwise only send within video area
    if (isPointerLocked) {
      const flag = event.button === 0 ? 'left_up' : (event.button === 2 ? 'right_up' : 'middle_up');
      sendRemoteActionAt(normalizedPos.x, normalizedPos.y, flag);
    } else if (event.clientX >= videoRect.left && event.clientX <= videoRect.right &&
      event.clientY >= videoRect.top && event.clientY <= videoRect.bottom) {
      const x = (event.clientX - videoRect.left) / videoRect.width;
      const y = (event.clientY - videoRect.top) / videoRect.height;
      const flag = event.button === 0 ? 'left_up' : (event.button === 2 ? 'right_up' : 'middle_up');
      sendRemoteActionAt(x, y, flag);
    }
    return;
  }

  if (event.type === 'mousemove') {
    if (isPointerLocked) {
      // movementX/movementY provides pixel-level increments
      videoRect = video.getBoundingClientRect(); // Keep latest dimensions
      normalizedPos.x = clamp01(normalizedPos.x + (event.movementX / videoRect.width));
      normalizedPos.y = clamp01(normalizedPos.y + (event.movementY / videoRect.height));
      sendRemoteActionAt(normalizedPos.x, normalizedPos.y, 'move');
    } else {
      // 非锁定情况下，只有当在 video 区域内才发送移动（可选）
      if (event.clientX >= videoRect.left && event.clientX <= videoRect.right &&
        event.clientY >= videoRect.top && event.clientY <= videoRect.bottom) {
        const x = (event.clientX - videoRect.left) / videoRect.width;
        const y = (event.clientY - videoRect.top) / videoRect.height;
        sendRemoteActionAt(x, y, 'move');
      }
    }
    return;
  }

  if (event.type === 'wheel') {
    // Send scroll events from current position (normalizedPos when in pointer lock)
    let x, y;
    if (isPointerLocked) {
      x = normalizedPos.x; y = normalizedPos.y;
    } else {
      videoRect = video.getBoundingClientRect();
      if (!(event.clientX >= videoRect.left && event.clientX <= videoRect.right &&
        event.clientY >= videoRect.top && event.clientY <= videoRect.bottom)) {
        return;
      }
      x = (event.clientX - videoRect.left) / videoRect.width;
      y = (event.clientY - videoRect.top) / videoRect.height;
    }
    const flag = event.deltaY === 0 ? 'wheel_horizontal' : 'wheel_vertical';
    sendRemoteActionAt(x, y, flag, event.deltaY || event.deltaX);
    return;
  }
}
