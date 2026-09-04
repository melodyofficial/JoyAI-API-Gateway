// 🚨 THIS IS YOUR LIVE CLOUD RENDER URL
const WS_URL = "wss://joyai-gateway.onrender.com";

const localVideo = document.getElementById('localVideo');
const outputImage = document.getElementById('outputImage');
const statusText = document.getElementById('status');
const startBtn = document.getElementById('startBtn');

let socket;
let stream;
let isStreaming = false;

// Invisible canvas to capture frames
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

// 1. Turn on User's Webcam
navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false })
  .then(s => {
    stream = s;
    localVideo.srcObject = stream;
  })
  .catch(err => {
    console.error("Camera Error:", err);
    statusText.innerText = "Error: Cannot access webcam.";
  });

// 2. Connect to Render and Start Streaming
startBtn.addEventListener('click', () => {
  if (isStreaming) return;
  
  statusText.innerText = "Status: Connecting to Render Gateway...";
  startBtn.disabled = true;

  // Connect to the Cloud
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    statusText.innerText = "Status: LIVE 🟢 (Streaming to GPU)";
    statusText.className = "live";
    isStreaming = true;
    sendVideoFrames();
  };

  socket.onmessage = (event) => {
    // When the RunPod GPU sends a swapped face back through Render
    const data = JSON.parse(event.data);
    if (data.image) {
      outputImage.src = "data:image/jpeg;base64," + data.image;
    }
  };

  socket.onclose = () => {
    statusText.innerText = "Status: Disconnected.";
    statusText.className = "";
    isStreaming = false;
    startBtn.disabled = false;
  };

  socket.onerror = (error) => {
    console.error("WebSocket Error:", error);
    statusText.innerText = "Status: Connection Error!";
    startBtn.disabled = false;
  };
});

// 3. Continuously send frames to the Cloud
function sendVideoFrames() {
  if (!isStreaming || socket.readyState !== WebSocket.OPEN) return;

  canvas.width = localVideo.videoWidth;
  canvas.height = localVideo.videoHeight;
  ctx.drawImage(localVideo, 0, 0, canvas.width, canvas.height);
  
  // Compress frame and convert to Base64 to send over internet
  const frameData = canvas.toDataURL('image/jpeg', 0.6).split(',')[1]; 

  socket.send(JSON.stringify({ type: 'video_frame', image: frameData }));

  // Send a frame every 60ms (~16 Frames Per Second)
  setTimeout(sendVideoFrames, 60); 
}