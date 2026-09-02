const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==============================================================================
// 🚀 MULTI-GPU FLEET CONFIGURATION
// Add as many RunPod WebSocket URLs here as you want. 
// If you have 5 URLs here, 5 users can stream video at the exact same time!
// ==============================================================================
const RUNPOD_FLEET = [
    "ws://157.157.221.29:12345/ws", // GPU 1
    // "ws://YOUR_SECOND_IP:PORT/ws", // GPU 2 (Uncomment when you rent more)
    // "ws://YOUR_THIRD_IP:PORT/ws"   // GPU 3
];

// --- STATE MANAGEMENT ---
let availableGPUs = [...RUNPOD_FLEET]; // GPUs currently not being used
let activeSessions = new Map();        // Maps a Client WebSocket to a RunPod WebSocket
let waitingQueue = [];                 // Users waiting in line

// Helper: Broadcast current position to everyone in the queue
function broadcastQueuePositions() {
    waitingQueue.forEach((client, index) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ 
                type: 'system_queue', 
                status: 'queued', 
                position: index + 1,
                totalWaiting: waitingQueue.length
            }));
        }
    });
}

// Helper: Move the next person to an available GPU
function processQueue() {
    // Scrub dead connections from the queue
    waitingQueue = waitingQueue.filter(client => client.readyState === WebSocket.OPEN);
    
    // If we have a free GPU AND someone is waiting, bridge them!
    while (availableGPUs.length > 0 && waitingQueue.length > 0) {
        const nextClient = waitingQueue.shift();
        const nextGpuUrl = availableGPUs.shift();
        assignGpuToUser(nextClient, nextGpuUrl);
    }
    
    broadcastQueuePositions();
}

// Core Engine: Bridge a user to a specific RunPod GPU
function assignGpuToUser(client, gpuUrl) {
    console.log(`[SYSTEM] Assigning user to GPU: ${gpuUrl}`);

    const runpodWs = new WebSocket(gpuUrl);
    activeSessions.set(client, runpodWs);
    
    client.send(JSON.stringify({ type: 'system_queue', status: 'connecting_to_gpu' }));

    runpodWs.on('open', () => {
        console.log(`[SYSTEM] GPU Bridge established for ${gpuUrl}`);
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'system_queue', status: 'ready' }));
        }
    });

    // RELAY: GPU Output ➔ Client Desktop
    runpodWs.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });

    // RELAY: Client Desktop ➔ GPU Input
    client.on('message', (data) => {
        if (runpodWs.readyState === WebSocket.OPEN) runpodWs.send(data);
    });

    // CLEANUP: Free the GPU when the user leaves
    const cleanup = () => {
        if (activeSessions.has(client)) {
            console.log(`[SYSTEM] User disconnected. Freeing GPU: ${gpuUrl}`);
            const assignedGpu = activeSessions.get(client);
            
            if (assignedGpu && assignedGpu.readyState === WebSocket.OPEN) {
                assignedGpu.close();
            }
            
            activeSessions.delete(client);
            
            // Put the GPU back in the available pool
            if (!availableGPUs.includes(gpuUrl)) {
                availableGPUs.push(gpuUrl);
            }
            
            // Instantly check if someone is waiting for this newly freed GPU
            processQueue();
        }
    };

    client.on('close', cleanup);
    runpodWs.on('close', cleanup);
    runpodWs.on('error', cleanup);
}

// --- INCOMING CONNECTION LISTENER ---
wss.on('connection', (client) => {
    console.log("[NETWORK] New user connected to the Gateway.");

    // If a GPU is free, give it to them instantly
    if (availableGPUs.length > 0) {
        const assignedGpuUrl = availableGPUs.shift();
        assignGpuToUser(client, assignedGpuUrl);
    } 
    // If all GPUs are busy, put them in line
    else {
        waitingQueue.push(client);
        console.log(`[QUEUE] All GPUs busy. User added to queue at Position: #${waitingQueue.length}`);
        
        client.send(JSON.stringify({
            type: 'system_queue',
            status: 'queued',
            position: waitingQueue.length,
            totalWaiting: waitingQueue.length
        }));
    }

    // If a waiting user leaves before their turn
    client.on('close', () => {
        if (!activeSessions.has(client)) {
            const index = waitingQueue.indexOf(client);
            if (index > -1) {
                waitingQueue.splice(index, 1);
                console.log("[QUEUE] A waiting user left the line.");
                broadcastQueuePositions();
            }
        }
    });
});

// Cloud providers assign a dynamic port, or fallback to 8080 locally
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 JoyAI API Gateway running on port ${PORT}`);
    console.log(`🖥️  Total GPUs in Fleet: ${RUNPOD_FLEET.length}`);
    console.log(`=========================================`);
});