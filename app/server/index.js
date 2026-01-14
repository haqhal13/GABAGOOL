"use strict";
/**
 * BETABOT Web Dashboard Server
 * Serves static files and broadcasts real-time dashboard updates via WebSocket
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.dashboardDataCollector = exports.AppServer = void 0;
const http_1 = require("http");
const ws_1 = require("ws");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dashboardData_1 = require("./dashboardData");
// MIME types for static file serving
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};
class AppServer {
    constructor(port = 3000) {
        this.clients = new Set();
        this.updateInterval = null;
        this.balanceInterval = null;
        this.port = port;
        this.publicDir = path.join(__dirname, '..', 'public');
        // Create HTTP server for static files
        this.httpServer = (0, http_1.createServer)((req, res) => {
            this.handleHttpRequest(req, res);
        });
        // Create WebSocket server attached to HTTP server
        this.wss = new ws_1.WebSocketServer({ server: this.httpServer });
        this.setupWebSocket();
    }
    /**
     * Start the server
     */
    start() {
        const _this = this;
        return new Promise(function (resolve, reject) {
            const tryListen = function (port) {
                _this.port = port;
                const onError = function (err) {
                    if (err.code === 'EADDRINUSE' && port !== 0) {
                        console.warn(`[APP] Port ${port} is in use, selecting a free port...`);
                        _this.httpServer.off('error', onError);
                        // Ask OS to assign a free port
                        tryListen(0);
                    }
                    else {
                        _this.httpServer.off('error', onError);
                        console.error('[APP] Failed to start dashboard server:', err.message);
                        reject(err);
                    }
                };
                const doListen = function () {
                    _this.httpServer.once('error', onError);
                    try {
                        _this.httpServer.listen(_this.port, function () {
                            _this.httpServer.off('error', onError);
                            const address = _this.httpServer.address();
                            if (address && typeof address === 'object') {
                                _this.port = address.port;
                            }
                            console.log(`[APP] Dashboard available at http://localhost:${_this.port}`);
                            // Start broadcasting updates every 1.5 seconds
                            _this.startBroadcasting();
                            resolve();
                        });
                    }
                    catch (err) {
                        _this.httpServer.off('error', onError);
                        const error = err;
                        if (error.code === 'EADDRINUSE' && port !== 0) {
                            console.warn(`[APP] Port ${port} is in use (sync), selecting a free port...`);
                            tryListen(0);
                        }
                        else {
                            console.error('[APP] Failed to start dashboard server (sync):', error.message);
                            reject(error);
                        }
                    }
                };
                doListen();
            };
            tryListen(_this.port);
        });
    }
    /**
     * Stop the server
     */
    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        if (this.balanceInterval) {
            clearInterval(this.balanceInterval);
            this.balanceInterval = null;
        }
        // Close all client connections
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        this.wss.close();
        this.httpServer.close();
        console.log('[APP] Dashboard server stopped');
    }
    /**
     * Get the actual port the server is listening on
     */
    getPort() {
        return this.port;
    }
    /**
     * Get the data collector for external configuration
     */
    getDataCollector() {
        return dashboardData_1.dashboardDataCollector;
    }
    /**
     * Handle HTTP requests for static files
     */
    handleHttpRequest(req, res) {
        let filePath = req.url || '/';
        // Default to index.html
        if (filePath === '/') {
            filePath = '/index.html';
        }
        // Security: prevent directory traversal
        const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
        const fullPath = path.join(this.publicDir, safePath);
        // Ensure path is within public directory
        if (!fullPath.startsWith(this.publicDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        // Get file extension and MIME type
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        // Read and serve the file
        fs.readFile(fullPath, (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    res.writeHead(404);
                    res.end('Not Found');
                }
                else {
                    res.writeHead(500);
                    res.end('Internal Server Error');
                }
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    }
    /**
     * Set up WebSocket server event handlers
     */
    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            console.log(`[APP] Client connected (${this.clients.size} total)`);
            // Send immediate update on connection
            this.sendUpdate(ws);
            // Handle client disconnect
            ws.on('close', () => {
                this.clients.delete(ws);
                console.log(`[APP] Client disconnected (${this.clients.size} remaining)`);
            });
            // Handle client messages
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this.handleClientMessage(ws, msg);
                }
                catch (e) {
                    // Ignore invalid JSON
                }
            });
            // Handle errors
            ws.on('error', (err) => {
                console.error('[APP] WebSocket error:', err.message);
                this.clients.delete(ws);
            });
        });
    }
    /**
     * Handle incoming client messages
     */
    handleClientMessage(ws, msg) {
        switch (msg.type) {
            case 'refresh':
                this.sendUpdate(ws);
                break;
            case 'ping':
                if (ws.readyState === ws_1.WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                }
                break;
        }
    }
    /**
     * Start the broadcast loop
     */
    startBroadcasting() {
        this.updateInterval = setInterval(() => {
            this.broadcast();
        }, 1500); // 1.5 second refresh
        // Periodically refresh on-chain wallet balance for the dashboard
        const refresh = async () => {
            try {
                await dashboardData_1.dashboardDataCollector.refreshWalletBalance();
            }
            catch (_a) {
                // Ignore balance refresh errors to keep dashboard stable
            }
        };
        // Initial fetch and then every 60 seconds
        refresh();
        this.balanceInterval = setInterval(refresh, 60000);
    }
    /**
     * Broadcast dashboard update to all connected clients
     */
    broadcast() {
        if (this.clients.size === 0)
            return;
        try {
            const update = dashboardData_1.dashboardDataCollector.getDashboardUpdate();
            const message = JSON.stringify(update);
            for (const client of this.clients) {
                if (client.readyState === ws_1.WebSocket.OPEN) {
                    client.send(message);
                }
            }
        }
        catch (err) {
            console.error('[APP] Error broadcasting update:', err);
        }
    }
    /**
     * Send update to a specific client
     */
    sendUpdate(ws) {
        if (ws.readyState !== ws_1.WebSocket.OPEN)
            return;
        try {
            const update = dashboardData_1.dashboardDataCollector.getDashboardUpdate();
            ws.send(JSON.stringify(update));
        }
        catch (err) {
            console.error('[APP] Error sending update:', err);
        }
    }
}
exports.AppServer = AppServer;
// Export for use in main bot
var dashboardData_2 = require("./dashboardData");
Object.defineProperty(exports, "dashboardDataCollector", { enumerable: true, get: function () { return dashboardData_2.dashboardDataCollector; } });
