/**
 * SMARTPARK AI - USB Serial Bridge Module
 * server/serialBridge.js
 * 
 * Provides robust USB serial communication between Node.js and Arduino UNO R3.
 * 
 * Architecture & Safety Principles:
 * 1. Node.js manages the physical USB Serial port (/dev/cu.usbmodem* or COM*).
 * 2. Newline-terminated command protocol: OPEN\n, CLOSE\n, STATUS\n.
 * 3. Handles connection errors, unexpected disconnections, and auto-reconnection.
 * 4. Awaits and validates Arduino acknowledgments (SMARTPARK_READY, GATE_OPENED, etc.).
 * 5. Distinguishes 4 stages: Requested -> Transmitted -> Acknowledged -> Hardware Feedback.
 * 6. Includes a mock serial fallback mode for automated testing without hardware.
 */

const EventEmitter = require('events');

let SerialPortClass = null;
let ReadlineParserClass = null;
try {
  const serialportPkg = require('serialport');
  SerialPortClass = serialportPkg.SerialPort;
  const parserPkg = require('@serialport/parser-readline');
  ReadlineParserClass = parserPkg.ReadlineParser;
} catch (e) {
  // If native bindings fail or optional dependency missing, will run in mock mode
  console.warn('[SerialBridge] serialport package not available, mock serial mode only:', e.message);
}

class SerialBridge extends EventEmitter {
  constructor(options = {}) {
    super();

    // Configuration from options or environment variables
    this.portPath = options.port || process.env.SERIAL_PORT || null;
    this.baudRate = parseInt(options.baudRate || process.env.SERIAL_BAUD_RATE || '9600', 10);
    this.timeoutMs = parseInt(options.timeoutMs || process.env.SERIAL_TIMEOUT_MS || '3000', 10);
    this.autoReconnect = options.autoReconnect !== false;
    this.isMockMode = options.isMockMode || process.env.SERIAL_MOCK === 'true';

    // Connection state
    this.port = null;
    this.parser = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectTimer = null;

    // Gate & Hardware state tracked via Arduino telemetry
    this.gateState = 'CLOSED';           // 'OPEN' | 'CLOSED' | 'UNKNOWN'
    this.obstacleDetected = false;       // IR sensor state reported by Arduino
    this.firmwareCompatibility = 'UNKNOWN'; // 'COMPATIBLE_SMARTPARK' | 'INCOMPATIBLE_LEGACY_SKETCH' | 'UNKNOWN'
    this.lastCommand = 'None';
    this.lastCommandStage = 'IDLE';      // 'IDLE' | 'REQUESTED' | 'TRANSMITTED' | 'ACKNOWLEDGED' | 'ERROR' | 'TIMEOUT'
    this.lastAck = 'None';
    this.lastError = null;
    this.activeCommandPending = null;    // { command, resolve, reject, timer }
  }

  /**
   * List all available hardware serial ports on the host.
   */
  static async listPorts() {
    if (!SerialPortClass) return [];
    try {
      const ports = await SerialPortClass.list();
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        isArduino: (p.manufacturer && p.manufacturer.toLowerCase().includes('arduino')) ||
                   p.vendorId === '2341' || p.vendorId === '9025' ||
                   (p.path && (p.path.includes('usbmodem') || p.path.includes('usbserial')))
      }));
    } catch (err) {
      console.error('[SerialBridge] Failed to list ports:', err.message);
      return [];
    }
  }

  /**
   * Find default Arduino port if not explicitly configured.
   */
  static async findDefaultArduinoPort() {
    const ports = await SerialBridge.listPorts();
    const arduino = ports.find(p => p.isArduino);
    if (arduino) return arduino.path;
    // Fallback: look for common mac/linux modem paths
    const modem = ports.find(p => p.path && (p.path.includes('usbmodem') || p.path.includes('ttyUSB')));
    return modem ? modem.path : null;
  }

  /**
   * Initialize and connect to serial port.
   */
  async connect(targetPort = null) {
    if (targetPort) this.portPath = targetPort;
    this.autoReconnect = true;

    if (this.isMockMode || !SerialPortClass) {
      this._initMockPort();
      return true;
    }

    // Auto-discover port if none provided
    if (!this.portPath) {
      const autoPort = await SerialBridge.findDefaultArduinoPort();
      if (autoPort) {
        console.log(`[SerialBridge] Auto-detected Arduino UNO port: ${autoPort}`);
        this.portPath = autoPort;
      } else {
        console.warn('[SerialBridge] No Arduino serial port configured or detected. Waiting for configuration...');
        this.isConnected = false;
        return false;
      }
    }

    if (this.isConnected || this.isConnecting) {
      return true;
    }

    this.isConnecting = true;
    console.log(`[SerialBridge] Attempting connection to ${this.portPath} at ${this.baudRate} baud...`);

    return new Promise((resolve) => {
      try {
        this.port = new SerialPortClass({
          path: this.portPath,
          baudRate: this.baudRate,
          autoOpen: false
        });

        this.parser = this.port.pipe(new ReadlineParserClass({ delimiter: '\n' }));

        this.port.open((err) => {
          this.isConnecting = false;
          if (err) {
            console.error(`[SerialBridge] Port open error on ${this.portPath}:`, err.message);
            this.isConnected = false;
            this.lastError = err.message;
            this._scheduleReconnect();
            resolve(false);
            return;
          }

          this.isConnected = true;
          this.lastError = null;
          console.log(`[SerialBridge] Connected to Arduino on ${this.portPath}`);
          this.emit('connected', { port: this.portPath, baudRate: this.baudRate });
          resolve(true);
        });

        // Set up event listeners
        this.parser.on('data', (line) => this._handleIncomingData(line));

        this.port.on('error', (err) => {
          console.error('[SerialBridge] Serial port error:', err.message);
          this.lastError = err.message;
          this._handleDisconnection();
        });

        this.port.on('close', () => {
          console.warn('[SerialBridge] Serial port closed.');
          this._handleDisconnection();
        });

      } catch (err) {
        this.isConnecting = false;
        this.isConnected = false;
        this.lastError = err.message;
        console.error('[SerialBridge] Exception initializing serial port:', err.message);
        this._scheduleReconnect();
        resolve(false);
      }
    });
  }

  /**
   * Handle unexpected port disconnection.
   */
  _handleDisconnection() {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.isConnecting = false;

    // Reject any in-flight pending command
    if (this.activeCommandPending) {
      clearTimeout(this.activeCommandPending.timer);
      this.activeCommandPending.reject(new Error('Serial port disconnected during command execution'));
      this.activeCommandPending = null;
    }

    if (wasConnected) {
      this.emit('disconnected', { port: this.portPath });
      console.warn('[SerialBridge] Controller disconnected! Halting commands.');
    }

    this._scheduleReconnect();
  }

  /**
   * Schedule automatic reconnection.
   */
  _scheduleReconnect() {
    if (!this.autoReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isConnected && !this.isConnecting) {
        console.log('[SerialBridge] Auto-reconnect triggered...');
        await this.connect();
      }
    }, 5000);
  }

  /**
   * Parse incoming newline-terminated messages from Arduino.
   */
  _handleIncomingData(rawLine) {
    const line = rawLine.toString().trim();
    if (!line) return;

    console.log(`[SerialBridge <- Arduino] "${line}"`);
    this.lastAck = line;
    this.emit('raw_message', line);

    // Check for SMARTPARK firmware vs legacy sketch
    if (line === 'SMARTPARK_READY') {
      this.firmwareCompatibility = 'COMPATIBLE_SMARTPARK';
      this.isConnected = true;
      this.emit('ready');
      setTimeout(() => {
        if (this.isConnected && !this.activeCommandPending) {
          this.sendCommand('STATUS').catch(() => {});
        }
      }, 200);
      return;
    }

    // Detect legacy sketch strings (obstacle_detection_system_hc_sr041.ino)
    if (line.includes('Automatic Parking Barrier') || line.includes('Barrier Ready') || line.includes('Vehicle Passed!')) {
      if (this.firmwareCompatibility !== 'COMPATIBLE_SMARTPARK') {
        this.firmwareCompatibility = 'INCOMPATIBLE_LEGACY_SKETCH';
        console.warn(`[SerialBridge] WARNING: Legacy sketch detected on Arduino: "${line}". Physical servo will not move until firmware/smartpark_gate_uno/smartpark_gate_uno.ino is uploaded.`);
      }
      this.isConnected = true;
      return;
    }

    // Gate movements (strict matching to avoid "Gate Opening..." triggering GATE_OPENED prematurely)
    if (line === 'GATE_OPENED' || line === 'STATUS:OPEN' || line === 'GATE:OPEN') {
      this.gateState = 'OPEN';
      this._resolvePendingCommand(this.activeCommandPending?.command === 'STATUS' ? 'STATUS' : 'OPEN', line);
      this.emit('gate_opened');
      return;
    }

    if (line === 'GATE_CLOSED' || line === 'STATUS:CLOSED' || line === 'GATE:CLOSED') {
      this.gateState = 'CLOSED';
      this._resolvePendingCommand(this.activeCommandPending?.command === 'STATUS' ? 'STATUS' : 'CLOSE', line);
      this.emit('gate_closed');
      return;
    }

    // IR Safety sensor events
    if (line === 'OBSTACLE:DETECTED' || line === 'OBSTACLE_DETECTED') {
      this.obstacleDetected = true;
      this.emit('obstacle', true);
      // If a close was pending and refused due to obstacle:
      if (this.activeCommandPending && this.activeCommandPending.command === 'CLOSE') {
        this._resolvePendingCommand('CLOSE', line, false, 'Command rejected: Obstacle detected in gate area!');
      }
      return;
    }

    if (line === 'OBSTACLE:CLEAR' || line === 'OBSTACLE_CLEAR') {
      this.obstacleDetected = false;
      this.emit('obstacle', false);
      return;
    }

    // Error messages from firmware
    if (line.startsWith('ERROR:')) {
      const errReason = line.replace('ERROR:', '').trim();
      this.lastError = errReason;
      if (this.activeCommandPending) {
        clearTimeout(this.activeCommandPending.timer);
        this.activeCommandPending.reject(new Error(`Arduino firmware error: ${errReason}`));
        this.activeCommandPending = null;
      }
      return;
    }

    // General status acknowledgment
    if (this.activeCommandPending && this.activeCommandPending.command === 'STATUS') {
      this._resolvePendingCommand('STATUS', line);
    }
  }

  /**
   * Resolve a pending command promise upon matching acknowledgment.
   */
  _resolvePendingCommand(cmd, ackMessage, success = true, errorMsg = null) {
    if (!this.activeCommandPending) return;

    if (this.activeCommandPending.command === cmd || this.activeCommandPending.command === 'STATUS') {
      clearTimeout(this.activeCommandPending.timer);
      const pending = this.activeCommandPending;
      this.activeCommandPending = null;
      this.lastCommandStage = success ? 'ACKNOWLEDGED' : 'ERROR';

      if (success) {
        pending.resolve({
          success: true,
          command: pending.command,
          stage: 'ACKNOWLEDGED',
          ackMessage,
          gateState: this.gateState,
          obstacleDetected: this.obstacleDetected,
          hardwareFeedback: 'OPEN_LOOP_SERVO_CONFIRMED'
        });
      } else {
        pending.reject(new Error(errorMsg || `Command ${cmd} failed: ${ackMessage}`));
      }
    }
  }

  /**
   * Send a newline-terminated command to Arduino (OPEN\n, CLOSE\n, STATUS\n).
   */
  async sendCommand(command) {
    const validCommands = ['OPEN', 'CLOSE', 'STATUS'];
    const cmd = command.toUpperCase().trim();

    if (!validCommands.includes(cmd)) {
      throw new Error(`Invalid command "${cmd}". Supported commands: ${validCommands.join(', ')}`);
    }

    if (!this.isConnected) {
      this.lastCommandStage = 'ERROR';
      throw new Error('Arduino controller is disconnected. Command refused.');
    }

    // Duplicate command prevention: do not queue multiple overlapping commands
    if (this.activeCommandPending) {
      throw new Error(`Another command (${this.activeCommandPending.command}) is currently in flight.`);
    }

    this.lastCommand = cmd;
    this.lastCommandStage = 'REQUESTED';

    return new Promise((resolve, reject) => {
      // Setup command timeout
      const timer = setTimeout(() => {
        if (this.activeCommandPending) {
          console.warn(`[SerialBridge] Command "${cmd}" timed out after ${this.timeoutMs}ms.`);
          this.lastCommandStage = 'TIMEOUT';
          this.activeCommandPending = null;
          const hint = this.firmwareCompatibility === 'INCOMPATIBLE_LEGACY_SKETCH'
            ? ' (Arduino UNO is running legacy firmware without servo support. Upload firmware/smartpark_gate_uno/smartpark_gate_uno.ino via Arduino IDE).'
            : '';
          reject(new Error(`Controller command timeout (${this.timeoutMs}ms) without acknowledgment.${hint}`));
        }
      }, this.timeoutMs);

      this.activeCommandPending = { command: cmd, resolve, reject, timer };

      // In mock mode, simulate immediate Arduino reaction
      if (this.isMockMode) {
        this.lastCommandStage = 'TRANSMITTED';
        this._mockProcessCommand(cmd);
        return;
      }

      // Transmit newline-terminated command over serial
      this.lastCommandStage = 'TRANSMITTED';
      console.log(`[SerialBridge -> Arduino] Transmitting "${cmd}\\n"...`);

      this.port.write(`${cmd}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.activeCommandPending = null;
          this.lastCommandStage = 'ERROR';
          this.lastError = err.message;
          reject(new Error(`Failed to transmit serial command: ${err.message}`));
        }
      });
    });
  }

  /**
   * Return comprehensive telemetry snapshot.
   */
  getStatus() {
    return {
      connected: this.isConnected,
      port: this.portPath || 'Not Configured',
      baudRate: this.baudRate,
      gateState: this.gateState,
      obstacleDetected: this.obstacleDetected,
      firmwareCompatibility: this.firmwareCompatibility,
      lastCommand: this.lastCommand,
      lastCommandStage: this.lastCommandStage,
      lastAck: this.lastAck,
      lastError: this.lastError,
      isMockMode: this.isMockMode,
      hardwareFeedback: 'OPEN_LOOP_SERVO', // Standard SG90 provides no potentiometer feedback
      timestamp: Date.now()
    };
  }

  /**
   * Close the serial port cleanly.
   */
  async close() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.port && this.port.isOpen) {
      return new Promise((resolve) => {
        this.port.close(() => {
          this.isConnected = false;
          resolve();
        });
      });
    }
    this.isConnected = false;
  }

  /**
   * Manually disconnect to release port for Arduino IDE / Serial Monitor.
   */
  async disconnect() {
    console.log('[SerialBridge] Manual disconnect requested. Releasing port...');
    this.autoReconnect = false;
    await this.close();
    this.emit('disconnected', { port: this.portPath, manual: true });
    return true;
  }

  /**
   * Initialize in-memory Mock Serial Port for testing and simulation.
   */
  _initMockPort() {
    console.log('[SerialBridge] Initialized in MOCK SERIAL MODE.');
    this.isConnected = true;
    this.isMockMode = true;
    this.portPath = 'MOCK_SERIAL_PORT';
  }

  /**
   * Simulate Arduino responses in Mock Serial Mode.
   */
  _mockProcessCommand(cmd) {
    setTimeout(() => {
      if (cmd === 'OPEN') {
        this._handleIncomingData('GATE_OPENED');
      } else if (cmd === 'CLOSE') {
        if (this.obstacleDetected) {
          this._handleIncomingData('OBSTACLE_DETECTED');
        } else {
          this._handleIncomingData('GATE_CLOSED');
        }
      } else if (cmd === 'STATUS') {
        this._handleIncomingData(`STATUS:${this.gateState}`);
        this._handleIncomingData(`OBSTACLE:${this.obstacleDetected ? 'DETECTED' : 'CLEAR'}`);
      }
    }, 150);
  }

  /**
   * Set simulated obstacle state in Mock Serial Mode.
   */
  setMockObstacle(detected) {
    this.obstacleDetected = !!detected;
    console.log(`[SerialBridge] Mock obstacle set to: ${this.obstacleDetected}`);
    this.emit('obstacle', this.obstacleDetected);
    this._handleIncomingData(this.obstacleDetected ? 'OBSTACLE:DETECTED' : 'OBSTACLE:CLEAR');
    return this.obstacleDetected;
  }
}

module.exports = SerialBridge;
