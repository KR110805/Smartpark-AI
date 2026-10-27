/**
 * SMARTPARK AI - Local Development Web Server
 * server/server.js
 * 
 * Serves the mobile-friendly web application statically and prints
 * local network Wi-Fi IP so users can connect their mobile devices.
 * 
 * Contains NO hardware-specific assumptions or firmware bindings.
 */

const express = require('express');
const path = require('path');
const os = require('os');
const SerialBridge = require('./serialBridge');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Serial Bridge
const serialBridge = new SerialBridge({
  port: process.env.SERIAL_PORT,
  baudRate: process.env.SERIAL_BAUD_RATE || 9600,
  isMockMode: process.env.SIMULATION_MODE === 'true' || process.env.SERIAL_MOCK === 'true'
});

// Enable CORS and JSON body parsing
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -------------------------------------------------------------
// Serial Bridge REST API Endpoints
// -------------------------------------------------------------

// 1. Get Serial Connection & Hardware Status
app.get(['/api/serial/status', '/serial/status'], (req, res) => {
  res.json(serialBridge.getStatus());
});

// 2. Request Gate Open via Serial
app.post(['/api/serial/open', '/serial/open'], async (req, res) => {
  try {
    const result = await serialBridge.sendCommand('OPEN');
    res.json({
      success: true,
      stage: result.stage,
      message: 'Gate OPEN command transmitted and acknowledged by Arduino',
      ack: result.ackMessage,
      gateState: result.gateState,
      hardwareFeedback: result.hardwareFeedback
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      stage: serialBridge.lastCommandStage,
      error: err.message,
      status: serialBridge.getStatus()
    });
  }
});

// 3. Request Gate Close via Serial (Hardware safety rules apply)
app.post(['/api/serial/close', '/serial/close'], async (req, res) => {
  try {
    const result = await serialBridge.sendCommand('CLOSE');
    res.json({
      success: true,
      stage: result.stage,
      message: 'Gate CLOSE command transmitted and acknowledged by Arduino',
      ack: result.ackMessage,
      gateState: result.gateState,
      hardwareFeedback: result.hardwareFeedback
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      stage: serialBridge.lastCommandStage,
      error: err.message,
      status: serialBridge.getStatus()
    });
  }
});

// 4. Send Arbitrary Validated Command (OPEN, CLOSE, STATUS)
app.post('/api/serial/command', async (req, res) => {
  const { command } = req.body || {};
  if (!command) {
    return res.status(400).json({ success: false, error: 'Missing "command" field in request body' });
  }
  try {
    const result = await serialBridge.sendCommand(command);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. List available system serial ports
app.get('/api/serial/ports', async (req, res) => {
  try {
    const ports = await SerialBridge.listPorts();
    res.json({ success: true, ports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Connect / Switch Serial Port dynamically
app.post('/api/serial/connect', async (req, res) => {
  const { port, baudRate } = req.body || {};
  try {
    if (baudRate) serialBridge.baudRate = parseInt(baudRate, 10);
    const connected = await serialBridge.connect(port);
    res.json({ success: connected, status: serialBridge.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Manually disconnect Serial Port (releases port for Arduino IDE / Serial Monitor)
app.post('/api/serial/disconnect', async (req, res) => {
  try {
    await serialBridge.disconnect();
    res.json({
      success: true,
      message: 'Serial port disconnected and released. Available for Arduino IDE.',
      status: serialBridge.getStatus()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Set Mock Obstacle State (for testing / simulation)
app.post('/api/serial/mock-obstacle', (req, res) => {
  const { obstacle } = req.body || {};
  const isDetected = !!obstacle;
  serialBridge.setMockObstacle(isDetected);
  res.json({
    success: true,
    obstacleDetected: serialBridge.obstacleDetected,
    status: serialBridge.getStatus()
  });
});

// Serve frontend static assets from workspace root
const ROOT_DIR = path.join(__dirname, '..');
app.use(express.static(ROOT_DIR));

// Helper: Determine local LAN IP address
function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Start Server
app.listen(PORT, '0.0.0.0', async () => {
  const localIp = getLocalNetworkIp();
  console.log('==================================================================');
  console.log('            SMARTPARK AI - Local Development Server               ');
  console.log('==================================================================');
  console.log(`  Local Computer:    http://localhost:${PORT}`);
  console.log(`  Mobile Network IP: http://${localIp}:${PORT}`);
  console.log('------------------------------------------------------------------');
  console.log('  SERIAL BRIDGE STATUS:');

  // Attempt initial serial port connection
  const connected = await serialBridge.connect();
  if (connected) {
    console.log(`  Connected to Arduino UNO on: ${serialBridge.portPath} (${serialBridge.baudRate} baud)`);
  } else {
    console.log('  No active hardware serial connection yet.');
    console.log('  Running with MOCK Controller as default in UI.');
    console.log('  To connect Arduino: plug in USB and configure SERIAL_PORT or use settings.');
  }
  console.log('------------------------------------------------------------------');
  console.log('  MOBILE CAMERA NOTICE:');
  console.log('  Mobile browsers (iOS Safari & Android Chrome) require HTTPS or');
  console.log('  localhost to grant camera access.');
  console.log('  To test on a physical mobile device:');
  console.log('  1) For Android: Use Chrome USB Remote Debugging (port forwarding):');
  console.log(`     adb reverse tcp:${PORT} tcp:${PORT} -> opens http://localhost:${PORT}`);
  console.log('  2) Or use a secure local tunnel (e.g. ngrok / cloudflared).');
  console.log('  3) Testing on laptop/desktop webcam works directly on:');
  console.log(`     http://localhost:${PORT}`);
  console.log('==================================================================');
});
