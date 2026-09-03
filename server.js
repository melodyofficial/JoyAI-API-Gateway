const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// ⚙️ CONFIGURATION (CHANGED TO PORT 8081)
// ==========================================
const PAYSTACK_SECRET_KEY = "sk_test_YOUR_PAYSTACK_KEY_HERE"; 
const JWT_SECRET = "super_secret_joyai_key_2026";
const DB_FILE = './database.json';
const RUNPOD_FLEET = ["ws://157.157.221.29:12345/ws"];
const PORT = 8081; 

// --- DATABASE MANAGEMENT WITH FAILSAFE ---
let db = { users: {} };
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE));
    } catch (e) {
        console.error("[SYSTEM WARNING] database.json was corrupted. Resetting...");
        db = { users: {} };
    }
}

// FORCE admin account to exist for silent login
if (!db.users["admin@joyai.com"]) {
    db.users["admin@joyai.com"] = { password: "password123", credits: 5000 };
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log("[SYSTEM] Created default Admin account (admin@joyai.com)");
}

const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

app.use(cors());

// --- PAYSTACK WEBHOOK ---
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.status(401).send('Invalid signature');

    const event = JSON.parse(req.body);
    if (event.event === 'charge.success') {
        const email = event.data.customer.email;
        if (db.users[email]) {
            db.users[email].credits += 100;
            saveDb();
            console.log(`[PAYSTACK] ₦5,000 received! Added 100 credits to ${email}`);
        }
    }
    res.status(200).send('OK');
});

app.use(express.json());

// --- SILENT AUTHENTICATION ROUTE ---
app.post('/api/login', (req, res) => {
    try {
        const { email, password } = req.body;
        console.log(`[LOGIN ATTEMPT] Received request for: ${email}`);
        
        const user = db.users[email];
        if (!user || user.password !== password) {
            console.log("[LOGIN FAILED] Invalid credentials");
            return res.status(401).json({ error: "Invalid credentials" });
        }
        
        const token = jwt.sign({ email }, JWT_SECRET);
        console.log("[LOGIN SUCCESS] Authorized admin@joyai.com");
        res.json({ token, credits: user.credits });
    } catch (e) {
        console.error("[SERVER ERROR on /api/login]", e);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/api/me', (req, res) => {
    try {
        const decoded = jwt.verify(req.headers.authorization, JWT_SECRET);
        res.json({ credits: db.users[decoded.email].credits });
    } catch {
        res.status(401).json({ error: "Unauthorized" });
    }
});

// --- PAYSTACK CHECKOUT ROUTE ---
app.post('/api/checkout', async (req, res) => {
    try {
        const decoded = jwt.verify(req.body.token, JWT_SECRET);
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: decoded.email,
                amount: 500000, 
                callback_url: 'http://localhost:3000?payment=success',
                metadata: { custom_fields: [{ display_name: "Product", variable_name: "product", value: "100 JoyAI Credits" }] }
            })
        });

        const paystackData = await response.json();
        if (paystackData.status) res.json({ url: paystackData.data.authorization_url });
        else res.status(400).json({ error: "Failed to connect to Nigerian bank gateway." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// ⚙️ SECURE WEBSOCKET FLEET BALANCER
// ==========================================
let availableGPUs = [...RUNPOD_FLEET];
let activeSessions = new Map();
let waitingQueue = [];

function broadcastQueuePositions() {
    waitingQueue.forEach(({ client }, index) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'system_queue', status: 'queued', position: index + 1 }));
        }
    });
}

function processQueue() {
    waitingQueue = waitingQueue.filter(({ client }) => client.readyState === WebSocket.OPEN);
    while (availableGPUs.length > 0 && waitingQueue.length > 0) {
        const nextUser = waitingQueue.shift();
        const nextGpuUrl = availableGPUs.shift();
        assignGpuToUser(nextUser.client, nextUser.email, nextGpuUrl);
    }
    broadcastQueuePositions();
}

setInterval(() => {
    for (const [client, meta] of activeSessions.entries()) {
        if (db.users[meta.email]) {
            db.users[meta.email].credits -= 1;
            saveDb();
            
            if (db.users[meta.email].credits <= 0) {
                client.send(JSON.stringify({ type: 'system_error', message: 'Out of credits! Please fund your wallet.' }));
                client.close();
            } else {
                client.send(JSON.stringify({ type: 'credit_update', credits: db.users[meta.email].credits }));
            }
        }
    }
}, 10000);

function assignGpuToUser(client, email, gpuUrl) {
    const runpodWs = new WebSocket(gpuUrl);
    activeSessions.set(client, { runpodWs, email, gpuUrl });
    
    client.send(JSON.stringify({ type: 'system_queue', status: 'connecting_to_gpu' }));

    runpodWs.on('open', () => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'system_queue', status: 'ready' }));
    });

    runpodWs.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });

    client.on('message', (data) => {
        if (runpodWs.readyState === WebSocket.OPEN) runpodWs.send(data);
    });

    const cleanup = () => {
        if (activeSessions.has(client)) {
            const meta = activeSessions.get(client);
            if (meta.runpodWs.readyState === WebSocket.OPEN) meta.runpodWs.close();
            activeSessions.delete(client);
            
            if (!availableGPUs.includes(meta.gpuUrl)) availableGPUs.push(meta.gpuUrl);
            processQueue();
        }
    };

    client.on('close', cleanup);
    runpodWs.on('close', cleanup);
    runpodWs.on('error', cleanup);
}

wss.on('connection', (client, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.users[decoded.email];
        
        if (!user || user.credits <= 0) {
            client.send(JSON.stringify({ type: 'system_error', message: 'Insufficient credits.' }));
            return client.close();
        }

        if (availableGPUs.length > 0) {
            assignGpuToUser(client, decoded.email, availableGPUs.shift());
        } else {
            waitingQueue.push({ client, email: decoded.email });
            client.send(JSON.stringify({ type: 'system_queue', status: 'queued', position: waitingQueue.length }));
        }
    } catch (e) {
        client.send(JSON.stringify({ type: 'system_error', message: 'Invalid token.' }));
        client.close();
    }

    client.on('close', () => {
        if (!activeSessions.has(client)) {
            waitingQueue = waitingQueue.filter(u => u.client !== client);
            broadcastQueuePositions();
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Paystack Gateway Server running on port ${PORT}`);
});