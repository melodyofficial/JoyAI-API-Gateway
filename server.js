const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- 1. EXPRESS MIDDLEWARE & API ROUTES ---
app.use(express.json());

// Mock user database for auth & economy
const users = {
    "admin@joyai.com": {
        password: "password123",
        token: "mock_jwt_token_12345",
        credits: 50
    }
};

// Health Check Endpoint (For Render)
app.get('/', (req, res) => {
    res.send("JoyAI API Gateway is Live");
});

// Auto-Login Route
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users[email];

    if (user && user.password === password) {
        res.json({ token: user.token, credits: user.credits });
    } else {
        res.status(401).json({ error: "Invalid email or password" });
    }
});

// User Profile & Credits Route
app.get('/api/me', (req, res) => {
    const token = req.headers['authorization'];
    const user = Object.values(users).find(u => u.token === token);
    
    if (user) {
        res.json({ credits: user.credits });
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
});

// Checkout / Wallet Top-Up Route
app.post('/api/checkout', (req, res) => {
    const { token } = req.body;
    const user = Object.values(users).find(u => u.token === token);

    if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    res.json({ url: "https://checkout.paystack.com/mock-payment-page" });
});

// --- 2. WEBSOCKET PROXY TO RUNPOD ENGINE ---
const RUNPOD_WS_URL = process.env.RUNPOD_WS_URL || "wss://jvh98bx7o4clcr-8080.proxy.runpod.net/ws"; 

let activeUser = null;
let waitingQueue = [];

function handleClientConnection(clientWs) {
    activeUser = clientWs;
    clientWs.send(JSON.stringify({ type: "system_queue", status: "connecting_to_gpu" }));

    const runpodWs = new WebSocket(RUNPOD_WS_URL);
    runpodWs.binaryType = "arraybuffer";

    runpodWs.on('open', () => {
        console.log("Bridged client to RunPod AI Engine!");
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "system_queue", status: "ready" }));
        }
    });

    // User ➔ RunPod (Webcam Stream)
    clientWs.on('message', (message) => {
        if (runpodWs.readyState === WebSocket.OPEN) {
            runpodWs.send(message);
        }
    });

    // RunPod ➔ User (AI Output Stream)
    runpodWs.on('message', (message) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(message);
        }
    });

    clientWs.on('close', () => {
        console.log("User disconnected. Freeing GPU...");
        runpodWs.close();
        activeUser = null;

        // Promote next user in line
        if (waitingQueue.length > 0) {
            const nextUser = waitingQueue.shift();
            
            waitingQueue.forEach((queuedUser, index) => {
                if (queuedUser.readyState === WebSocket.OPEN) {
                    queuedUser.send(JSON.stringify({ type: "system_queue", status: "queued", position: index + 1 }));
                }
            });

            handleClientConnection(nextUser);
        }
    });

    runpodWs.on('error', (err) => {
        console.error("RunPod Connection Error:", err.message);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "system_error", message: "GPU Server Unreachable" }));
        }
    });
}

wss.on('connection', (clientWs) => {
    console.log("New user connected to Gateway!");

    if (activeUser) {
        waitingQueue.push(clientWs);
        clientWs.send(JSON.stringify({ type: "system_queue", status: "queued", position: waitingQueue.length }));
        return;
    }

    handleClientConnection(clientWs);
});

// --- 3. BIND TO RENDER PORT ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`JoyAI Gateway active on port ${PORT}`);
});