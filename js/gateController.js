/**
 * SMARTPARK AI - Configurable Gate Controller Abstraction
 * js/gateController.js
 * 
 * Provides a decoupled controller interface allowing independent testing
 * with a Mock Controller by default, while supporting future integration with
 * an Existing HTTP Controller or Existing Serial Bridge once hardware is confirmed.
 * 
 * Safety Principles:
 * 1. AI system requests gate opening ONLY upon confirmed car detection.
 * 2. NO automatic physical closing in frontend (hardware remains in charge of closing & safety).
 * 3. Command de-bouncing prevents repeated triggers.
 * 4. Simulated gate movements are strictly labeled as MOCK / SIMULATED.
 */

const GateState = {
  IDLE: 'IDLE',
  DETECTING: 'DETECTING',
  CAR_CONFIRMED: 'CAR_CONFIRMED',
  OPEN_REQUESTED: 'OPEN_REQUESTED',
  COMMAND_TRANSMITTED: 'COMMAND_TRANSMITTED',
  ACK_RECEIVED: 'ACK_RECEIVED',
  HARDWARE_CONFIRMED: 'HARDWARE_CONFIRMED',
  OPEN_COMMAND_SENT: 'OPEN_COMMAND_SENT',
  SIMULATED_CYCLE: 'SIMULATED_CYCLE',
  DISCONNECTED: 'DISCONNECTED',
  ERROR: 'ERROR'
};

const AutomationState = {
  IDLE: 'IDLE',
  VEHICLE_APPROACHING: 'VEHICLE_APPROACHING',
  CAR_CONFIRMED: 'CAR_CONFIRMED',
  GATE_OPEN: 'GATE_OPEN',
  VEHICLE_CLEARING: 'VEHICLE_CLEARING',
  GATE_CLOSING: 'GATE_CLOSING',
  ERROR: 'ERROR'
};

const ConnectionState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  ERROR: 'ERROR'
};

const ControllerMode = {
  MOCK: 'MOCK',
  SERIAL: 'SERIAL',
  EXISTING_HTTP_CONTROLLER: 'EXISTING_HTTP_CONTROLLER',
  EXISTING_SERIAL_BRIDGE: 'EXISTING_SERIAL_BRIDGE' // Backward compatibility alias
};

/**
 * Base Abstract Adapter
 */
class BaseGateControllerAdapter {
  constructor(name) {
    this.name = name;
  }

  async requestOpen(metadata, onStageUpdate) {
    throw new Error('requestOpen() must be implemented by adapter');
  }

  async requestClose(metadata, onStageUpdate) {
    throw new Error('requestClose() must be implemented by adapter');
  }

  async getStatus() {
    return { isConnected: false, statusText: 'Not Implemented' };
  }

  async emergencyStop() {
    console.warn(`[${this.name}] Emergency stop requested.`);
  }

  isSimulated() {
    return false;
  }
}

/**
 * 1. Mock Controller Adapter (Default)
 * Fully local in-browser simulation. Clearly labeled as simulated.
 */
class MockGateControllerAdapter extends BaseGateControllerAdapter {
  constructor() {
    super('Mock Simulator (Virtual Gate)');
    this.simulatedAngle = 0; // 0 = closed, 90 = open
    this.cycleTimer = null;
    this.vehicleCount = 0;
    this.obstacleDetected = false;
  }

  isSimulated() {
    return true;
  }

  setObstacleDetected(detected) {
    this.obstacleDetected = !!detected;
    return this.obstacleDetected;
  }

  async getStatus() {
    return {
      isConnected: true,
      connectionState: ConnectionState.CONNECTED,
      isSimulated: true,
      hardwareConfirmed: false,
      gateState: this.simulatedAngle > 0 ? 'OPEN' : 'CLOSED',
      gateAngle: this.simulatedAngle,
      obstacleDetected: !!this.obstacleDetected,
      port: null,
      baudRate: null,
      statusText: this.simulatedAngle > 0 ? 'SIMULATED OPEN (90°)' : 'SIMULATED CLOSED (0°)',
      vehicleCount: this.vehicleCount
    };
  }

  async requestOpen(metadata = {}, onCycleUpdate = null) {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);

    console.log('[MockAdapter] Simulating gate barrier opening (0° -> 90°)...');
    this.simulatedAngle = 90;
    if (onCycleUpdate) onCycleUpdate('SIMULATED_OPEN', 90);

    // If managed by IR-First workflow or manual open, keep open until explicit close command
    if (metadata.workflowManaged || metadata.keepOpen || !metadata.standaloneCycle) {
      return {
        success: true,
        isSimulated: true,
        message: 'Mock barrier opened (90°)',
        vehicleCount: this.vehicleCount
      };
    }

    // Default standalone legacy behavior: 3.5s auto-close
    return new Promise((resolve) => {
      this.cycleTimer = setTimeout(() => {
        console.log('[MockAdapter] Simulating vehicle clearing entrance. Resetting virtual barrier (90° -> 0°)...');
        this.simulatedAngle = 0;
        this.vehicleCount++;
        if (onCycleUpdate) onCycleUpdate('SIMULATED_CLOSED', 0);
        resolve({
          success: true,
          isSimulated: true,
          message: 'Mock cycle completed (Simulated vehicle passed)',
          vehicleCount: this.vehicleCount
        });
      }, 3500);
    });
  }

  async requestClose(metadata = {}, onCycleUpdate = null) {
    // Safety check: reject CLOSE if obstacle is detected
    if (this.obstacleDetected) {
      throw new Error('Command rejected: Obstacle detected in gate area!');
    }
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.simulatedAngle = 0;
    this.vehicleCount++;
    if (onCycleUpdate) onCycleUpdate('SIMULATED_CLOSED', 0);
    return { success: true, isSimulated: true, message: 'Simulated gate closed.' };
  }

  async emergencyStop() {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.simulatedAngle = 90;
    console.warn('[MockAdapter] Mock Emergency Stop active. Simulated barrier raised.');
    return { success: true, message: 'Mock E-Stop Engaged' };
  }
}

/**
 * 2. Serial Gate Controller Adapter (Arduino UNO R3 via USB Serial Bridge)
 * Distinguishes 4 verification stages:
 * Stage 1: Command Requested (Client-side)
 * Stage 2: Command Transmitted (Dispatched across Node.js serial bridge)
 * Stage 3: Arduino Acknowledgment Received (Arduino returned GATE_OPENED / GATE_CLOSED)
 * Stage 4: Physical Gate State Confirmed (Open-loop actuator feedback & IR sensor telemetry)
 */
class SerialGateControllerAdapter extends BaseGateControllerAdapter {
  constructor(config = {}) {
    super('Arduino UNO R3 (USB Serial)');
    this.bridgeUrl = config.bridgeUrl || '/api/serial';
    this.lastTelemetry = null;
    this.isConnecting = false;
    this.activeConnectPromise = null;
  }

  setBridgeUrl(url) {
    this.bridgeUrl = url;
  }

  /**
   * Safely connect to Arduino serial port with duplicate attempt prevention.
   */
  async connect(port, baudRate = 9600) {
    if (this.isConnecting && this.activeConnectPromise) {
      console.warn('[SerialGateController] Connection attempt already in progress.');
      return this.activeConnectPromise;
    }

    if (this.lastTelemetry && this.lastTelemetry.connected && this.lastTelemetry.port === port) {
      console.log(`[SerialGateController] Already connected to ${port}.`);
      return { success: true, alreadyConnected: true, status: this.lastTelemetry };
    }

    this.isConnecting = true;
    const connectUrl = `${this.bridgeUrl.replace(/\/$/, '')}/connect`;
    this.activeConnectPromise = (async () => {
      try {
        const resp = await fetch(connectUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, baudRate })
        });
        const data = await resp.json().catch(() => ({}));
        if (data && data.status) {
          this.lastTelemetry = data.status;
        }
        return data;
      } finally {
        this.isConnecting = false;
        this.activeConnectPromise = null;
      }
    })();
    return this.activeConnectPromise;
  }

  async requestOpen(metadata = {}, onStageUpdate = null) {
    const openUrl = `${this.bridgeUrl.replace(/\/$/, '')}/open`;

    if (onStageUpdate) onStageUpdate('COMMAND_TRANSMITTED', 'Transmitting OPEN\\n to Arduino UNO via USB...');

    try {
      const resp = await fetch(openUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'OPEN', timestamp: Date.now(), metadata })
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data.success) {
        const errorMsg = data.error || `Serial bridge returned HTTP ${resp.status}`;
        throw new Error(errorMsg);
      }

      if (onStageUpdate) {
        onStageUpdate('ACK_RECEIVED', `Arduino Acknowledgment: ${data.ack || 'GATE_OPENED'}`);
        onStageUpdate('HARDWARE_CONFIRMED', `Gate Commanded: ${data.gateState || 'OPEN'} (Open-Loop Actuator Acknowledged)`);
      }

      return {
        success: true,
        isSimulated: false,
        stage: 'HARDWARE_CONFIRMED',
        message: data.message || 'Arduino confirmed gate open',
        ack: data.ack,
        gateState: data.gateState,
        hardwareFeedback: data.hardwareFeedback
      };
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes('disconnected')) {
        throw new Error('Arduino UNO controller is disconnected. Please check USB cable.');
      }
      throw err;
    }
  }

  async requestClose(metadata = {}, onStageUpdate = null) {
    const closeUrl = `${this.bridgeUrl.replace(/\/$/, '')}/close`;

    if (onStageUpdate) onStageUpdate('COMMAND_TRANSMITTED', 'Transmitting CLOSE\\n to Arduino UNO...');

    try {
      const resp = await fetch(closeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CLOSE', timestamp: Date.now(), metadata })
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data.success) {
        throw new Error(data.error || `Serial bridge HTTP ${resp.status}`);
      }

      if (onStageUpdate) {
        onStageUpdate('ACK_RECEIVED', `Arduino Acknowledgment: ${data.ack || 'GATE_CLOSED'}`);
        onStageUpdate('HARDWARE_CONFIRMED', `Gate Position: ${data.gateState || 'CLOSED'}`);
      }

      return {
        success: true,
        isSimulated: false,
        stage: 'HARDWARE_CONFIRMED',
        message: data.message || 'Arduino confirmed gate closed',
        ack: data.ack,
        gateState: data.gateState
      };
    } catch (err) {
      throw err;
    }
  }

  async getStatus() {
    const statusUrl = `${this.bridgeUrl.replace(/\/$/, '')}/status`;
    try {
      const resp = await fetch(statusUrl);
      if (!resp.ok) {
        return {
          isConnected: false,
          connectionState: ConnectionState.ERROR,
          isSimulated: false,
          hardwareConfirmed: false,
          gateState: 'CLOSED',
          gateAngle: 0,
          obstacleDetected: false,
          port: null,
          baudRate: 9600,
          lastAck: 'None',
          lastError: `HTTP ${resp.status}`,
          lastCommand: 'None',
          lastCommandStage: 'ERROR',
          hardwareFeedback: 'OPEN_LOOP_SERVO',
          firmwareCompatibility: 'UNKNOWN',
          statusText: 'Serial Bridge Offline',
          vehicleCount: 0
        };
      }
      const data = await resp.json();
      this.lastTelemetry = data;

      const isConnected = !!data.connected;
      let connectionState = ConnectionState.DISCONNECTED;
      if (this.isConnecting) {
        connectionState = ConnectionState.CONNECTING;
      } else if (isConnected) {
        connectionState = ConnectionState.CONNECTED;
      } else if (data.lastError) {
        connectionState = ConnectionState.ERROR;
      }

      let statusText = 'Ready';
      if (!isConnected) {
        statusText = 'ARDUINO DISCONNECTED';
      } else if (data.obstacleDetected) {
        statusText = 'OBSTACLE DETECTED (IR ACTIVE)';
      } else {
        statusText = `CONNECTED (${data.port || 'USB'})`;
      }

      return {
        isConnected,
        connectionState,
        isSimulated: !!data.isMockMode,
        hardwareConfirmed: isConnected,
        gateState: data.gateState || 'CLOSED',
        gateAngle: data.gateState === 'OPEN' ? 90 : 0,
        obstacleDetected: !!data.obstacleDetected,
        port: data.port || null,
        baudRate: data.baudRate || 9600,
        lastAck: data.lastAck || 'None',
        lastError: data.lastError || null,
        lastCommand: data.lastCommand || 'None',
        lastCommandStage: data.lastCommandStage || 'IDLE',
        hardwareFeedback: data.hardwareFeedback || 'OPEN_LOOP_SERVO',
        firmwareCompatibility: data.firmwareCompatibility || 'UNKNOWN',
        statusText,
        vehicleCount: 0
      };
    } catch (err) {
      return {
        isConnected: false,
        connectionState: ConnectionState.ERROR,
        isSimulated: false,
        hardwareConfirmed: false,
        gateState: 'CLOSED',
        gateAngle: 0,
        obstacleDetected: false,
        port: null,
        baudRate: 9600,
        lastAck: 'None',
        lastError: err.message,
        lastCommand: 'None',
        lastCommandStage: 'ERROR',
        hardwareFeedback: 'OPEN_LOOP_SERVO',
        firmwareCompatibility: 'UNKNOWN',
        statusText: `Bridge Error: ${err.message}`,
        vehicleCount: 0
      };
    }
  }

  async emergencyStop() {
    console.warn('[SerialGateController] Emergency Stop dispatched to Arduino.');
    return await this.requestOpen({ emergency: true });
  }
}

/**
 * 3. Existing HTTP Controller Adapter
 */
class ExistingHttpControllerAdapter extends BaseGateControllerAdapter {
  constructor(config = {}) {
    super('Existing HTTP Controller');
    this.url = config.url || '';
    this.method = config.method || 'POST';
    this.timeoutMs = config.timeoutMs || 4000;
  }

  setUrl(url) {
    this.url = url;
  }

  async requestOpen(metadata = {}) {
    if (!this.url) {
      throw new Error(
        'HTTP Controller URL is not configured. Please enter your existing controller endpoint in settings.'
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: this.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'OPEN_GATE',
          source: 'SMARTPARK_AI',
          timestamp: Date.now(),
          ...metadata
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Controller HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json().catch(() => ({}));
      return {
        success: true,
        isSimulated: false,
        message: 'Open command sent to existing HTTP controller',
        rawResponse: data
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`Controller connection timed out (${this.timeoutMs}ms)`);
      }
      throw err;
    }
  }

  async requestClose(metadata = {}) {
    return { success: true, message: 'Close command sent to HTTP controller' };
  }

  async getStatus() {
    if (!this.url) {
      return { isConnected: false, isSimulated: false, statusText: 'URL Not Configured' };
    }
    return { isConnected: true, isSimulated: false, statusText: 'Endpoint Configured' };
  }
}

/**
 * 4. Existing Serial Bridge Adapter (Alias for backward compatibility)
 */
class ExistingSerialBridgeAdapter extends SerialGateControllerAdapter {
  constructor(config = {}) {
    super(config);
    this.name = 'Existing Serial Bridge';
  }
}

/**
 * Gate Controller Manager
 * Orchestrates the active adapter, enforces anti-bounce de-duplication,
 * maintains event latching, and handles 4-stage hardware verification.
 */
class GateController {
  constructor(config = null) {
    this.config = config || (typeof CONFIG !== 'undefined' ? CONFIG : {
      ACTIVE_CONTROLLER_MODE: 'MOCK',
      COMMAND_DEBOUNCE_MS: 3000,
      AUTO_GATE_ENABLED: true,
      SERIAL_BRIDGE_URL: '/api/serial',
      CLEARANCE_DELAY_MS: 2000,
      IR_FIRST_AUTOMATION: true
    });

    this.state = GateState.IDLE;
    this.automationState = AutomationState.IDLE;
    this.lastCommandTime = 0;
    this.lastCommandResult = 'None';
    this.isOperationInProgress = false;

    // Event Latch: ensures a single visible vehicle triggers OPEN only once per approach
    this.eventLatched = false;

    // Diagnostic tracking for open attempts
    this.openAttemptCounter = 0;
    this.lastOpenDiagnostics = null;

    // Diagnostic tracking for close attempts & error recovery
    this.closeAttemptCounter = 0;
    this.lastCloseDiagnostics = null;
    this.lastClosureError = null;

    // IR Sensor & Vehicle Clearance Timing
    this.isObstacleDetected = false;
    this.clearanceTimer = null;
    this.clearanceDelayMs = this.config.CLEARANCE_DELAY_MS || 2000;
    this.clearanceStartTime = null;

    // Approach Sensor Debounce Timing (filters optical noise / flutter before confirmation)
    this.approachClearTimer = null;
    this.approachClearDelayMs = this.config.APPROACH_CLEAR_DELAY_MS || 1000;

    // Available adapters
    const serialAdapter = new SerialGateControllerAdapter({
      bridgeUrl: this.config.SERIAL_BRIDGE_URL || '/api/serial'
    });

    this.adapters = {
      [ControllerMode.MOCK]: new MockGateControllerAdapter(),
      [ControllerMode.SERIAL]: serialAdapter,
      [ControllerMode.EXISTING_SERIAL_BRIDGE]: serialAdapter,
      [ControllerMode.EXISTING_HTTP_CONTROLLER]: new ExistingHttpControllerAdapter({
        url: this.config.HTTP_CONTROLLER_URL,
        method: this.config.HTTP_CONTROLLER_METHOD,
        timeoutMs: this.config.CONTROLLER_TIMEOUT_MS
      })
    };

    // Default to MOCK
    this.activeMode = ControllerMode.MOCK;
    this.adapter = this.adapters[ControllerMode.MOCK];

    this.onStateChange = null;
    this.onTelemetryUpdate = null;
    this.onAutomationStateChange = null;
    this.onCameraAction = null; // ({ action: 'START' | 'STOP', reason: string }) => void
  }

  init(onState = null, onTelemetry = null, onAutomationState = null, onCameraAction = null) {
    this.onStateChange = onState;
    this.onTelemetryUpdate = onTelemetry;
    this.onAutomationStateChange = onAutomationState;
    this.onCameraAction = onCameraAction;
    this.setMode(this.config.ACTIVE_CONTROLLER_MODE || ControllerMode.MOCK);
  }

  _cancelApproachClearTimer() {
    if (this.approachClearTimer) {
      clearTimeout(this.approachClearTimer);
      this.approachClearTimer = null;
    }
  }

  setMode(mode) {
    if (!this.adapters[mode]) {
      console.warn(`[GateController] Unknown mode "${mode}", falling back to MOCK.`);
      mode = ControllerMode.MOCK;
    }

    this.activeMode = mode;
    this.adapter = this.adapters[mode];
    this.state = GateState.IDLE;
    this.automationState = AutomationState.IDLE;
    this._cancelClearanceCountdown();
    this._cancelApproachClearTimer();
    this.isOperationInProgress = false;
    this.eventLatched = false;
    this.openAttemptCounter = 0;
    this.lastOpenDiagnostics = null;
    this.closeAttemptCounter = 0;
    this.lastCloseDiagnostics = null;
    this.lastClosureError = null;

    this._notifyState(
      GateState.IDLE,
      `Controller mode set to: ${this.adapter.name} (${this.adapter.isSimulated() ? 'SIMULATED' : 'HARDWARE INTERFACE'})`
    );
    this._setAutomationState(AutomationState.IDLE, 'System initialized. Waiting for vehicle approach.');
    this._emitTelemetry();
  }

  /**
   * Resets the vehicle event latch.
   * STRICT SAFETY RULE:
   * The latch may ONLY be reset when the vehicle clearance workflow has safely completed
   * and the system returns to IDLE (or when explicitly forced during verified recovery).
   * It must NEVER be reset merely because one or more camera frames have no car.
   */
  resetEventLatch(force = false) {
    if (this.eventLatched) {
      const now = Date.now();
      if (!force && (now - this.lastCommandTime < this.config.COMMAND_DEBOUNCE_MS)) {
        return false;
      }
      if (!force && this.automationState !== AutomationState.IDLE) {
        return false;
      }
      console.log('[GateController] Vehicle event latch released.');
      this.eventLatched = false;
      return true;
    }
    return false;
  }

  /**
   * Central IR Telemetry Handler:
   * Drives the IR-first camera activation, obstacle safety, and vehicle clearance workflow.
   */
  handleObstacleStateChange(obstacleDetected) {
    const isDetected = !!obstacleDetected;
    const changed = (this.isObstacleDetected !== isDetected);
    this.isObstacleDetected = isDetected;

    // Propagate to mock adapter if active
    if (this.adapter && typeof this.adapter.setObstacleDetected === 'function') {
      this.adapter.setObstacleDetected(isDetected);
    }

    if (!this.config.IR_FIRST_AUTOMATION) {
      return;
    }

    // State 1: IDLE -> Obstacle detected -> Transition to VEHICLE_APPROACHING & start camera
    if (this.automationState === AutomationState.IDLE) {
      this._cancelApproachClearTimer();
      if (isDetected) {
        this._setAutomationState(
          AutomationState.VEHICLE_APPROACHING,
          'Vehicle detected at entrance by IR sensor. Activating camera & AI verification.'
        );
        if (this.onCameraAction) {
          this.onCameraAction({ action: 'START', reason: 'IR_OBSTACLE_DETECTED' });
        }
      }
      return;
    }

    // State 2: VEHICLE_APPROACHING -> Sensor debounce to filter jitter / gap reflections
    if (this.automationState === AutomationState.VEHICLE_APPROACHING) {
      if (isDetected) {
        // Obstacle reaffirmed; cancel any clear timer
        this._cancelApproachClearTimer();
      } else {
        // Obstacle reported clear: wait for stable clearance before aborting approach
        if (!this.approachClearTimer) {
          this.approachClearTimer = setTimeout(() => {
            this.approachClearTimer = null;
            if (this.automationState === AutomationState.VEHICLE_APPROACHING && !this.isObstacleDetected) {
              console.log('[GateController] IR sensor stably cleared during approach. Returning to IDLE.');
              this._setAutomationState(
                AutomationState.IDLE,
                'IR sensor cleared before car confirmation. Deactivating camera and returning to IDLE.'
              );
              this.resetEventLatch(true);
              if (this.onCameraAction) {
                this.onCameraAction({ action: 'STOP', reason: 'IR_CLEARED_BEFORE_CONFIRMATION' });
              }
            }
          }, this.approachClearDelayMs);
        }
      }
      return;
    }

    // State 3: CAR_CONFIRMED -> Gate opening command in-flight (do not interrupt)
    if (this.automationState === AutomationState.CAR_CONFIRMED) {
      this._cancelApproachClearTimer();
      return;
    }

    // State 4: GATE_OPEN -> Vehicle clears IR sensor -> Transition to VEHICLE_CLEARING
    if (this.automationState === AutomationState.GATE_OPEN) {
      this._cancelApproachClearTimer();
      if (!isDetected) {
        this._startClearanceCountdown();
      }
      return;
    }

    // State 5: VEHICLE_CLEARING -> Obstacle re-detected during countdown -> Cancel countdown!
    if (this.automationState === AutomationState.VEHICLE_CLEARING) {
      this._cancelApproachClearTimer();
      if (isDetected) {
        this._cancelClearanceCountdown();
        this._setAutomationState(
          AutomationState.GATE_OPEN,
          'Obstacle re-detected in gate area during clearance delay! Gate remains OPEN.'
        );
      }
      return;
    }

    // State 6: GATE_CLOSING
    if (this.automationState === AutomationState.GATE_CLOSING) {
      this._cancelApproachClearTimer();
      if (isDetected) {
        console.warn('[GateController] Hazard warning: Obstacle detected while gate barrier is closing. Actuator is open-loop (SG90 servo does not support mid-transit reversal). Hardware safety caution active.');
        this._notifyState(
          this.state,
          'Caution: Obstacle detected while gate is closing (Open-loop servo cannot reverse mid-transit)'
        );
      }
      return;
    }

    // State 7: ERROR -> Only if gate is verified physically OPEN do we resume clearance
    if (this.automationState === AutomationState.ERROR) {
      this._cancelApproachClearTimer();
      const isPhysicallyOpen = (
        this.state === GateState.HARDWARE_CONFIRMED ||
        (this.adapter && typeof this.adapter.simulatedAngle === 'number' && this.adapter.simulatedAngle >= 45) ||
        (this.adapter && this.adapter.lastTelemetry && this.adapter.lastTelemetry.gateState === 'OPEN')
      );
      if (isDetected && isPhysicallyOpen) {
        console.log('[GateController] Obstacle detected while in ERROR with open barrier. Resuming GATE_OPEN clearance workflow.');
        this._setAutomationState(
          AutomationState.GATE_OPEN,
          'Obstacle detected in gate area with barrier OPEN. Resuming clearance workflow.'
        );
      }
      return;
    }
  }

  _startClearanceCountdown() {
    this._cancelClearanceCountdown();
    this._setAutomationState(
      AutomationState.VEHICLE_CLEARING,
      `Vehicle cleared IR sensor. Starting ${this.clearanceDelayMs}ms clearance delay...`
    );
    this.clearanceStartTime = Date.now();
    this.clearanceTimer = setTimeout(async () => {
      await this._finalizeClearanceClosure();
    }, this.clearanceDelayMs);
  }

  _cancelClearanceCountdown() {
    if (this.clearanceTimer) {
      clearTimeout(this.clearanceTimer);
      this.clearanceTimer = null;
    }
    this.clearanceStartTime = null;
  }

  async _finalizeClearanceClosure() {
    this.clearanceTimer = null;
    this.clearanceStartTime = null;

    if (this.automationState !== AutomationState.VEHICLE_CLEARING) {
      console.log(`[GateController] _finalizeClearanceClosure skipped: automation state is ${this.automationState}`);
      return;
    }

    // Critical safety verification: confirm IR sensor is STILL clear
    if (this.isObstacleDetected) {
      console.warn('[GateController] Clearance timer expired, but IR sensor is not clear. Refusing closure. Gate remains OPEN.');
      this._setAutomationState(
        AutomationState.GATE_OPEN,
        'Clearance delay completed but obstacle is present. Gate remains OPEN.'
      );
      return;
    }

    // Query adapter to ensure sensor status and controller are connected and not blocked
    const status = await this.adapter.getStatus();
    if (status && status.obstacleDetected) {
      console.warn('[GateController] Hardware telemetry reports obstacle detected before close transmission. Gate remains OPEN.');
      this._setAutomationState(
        AutomationState.GATE_OPEN,
        'Hardware reports obstacle detected before close transmission. Gate remains OPEN.'
      );
      return;
    }

    if (!status.isConnected && !this.adapter.isSimulated()) {
      console.warn('[GateController] Controller disconnected during clearance. Gate remains OPEN for safety.');
      this._setAutomationState(
        AutomationState.ERROR,
        'Controller disconnected during vehicle clearance. Gate remains OPEN for safety.'
      );
      return;
    }

    this.closeAttemptCounter = (this.closeAttemptCounter || 0) + 1;
    const attemptId = `CLEARANCE-CLOSE-${this.closeAttemptCounter}-${Date.now()}`;

    this._setAutomationState(
      AutomationState.GATE_CLOSING,
      `Clearance delay complete and entrance is clear. Closing gate (Attempt ${attemptId})...`
    );

    try {
      const closed = await this.requestCloseGate('AUTO_CLEARANCE', attemptId);
      if (closed) {
        // Lifecycle complete: turn off camera & return to IDLE
        if (this.onCameraAction) {
          this.onCameraAction({ action: 'STOP', reason: 'GATE_LIFECYCLE_COMPLETED' });
        }
        this.resetEventLatch(true);
        this._setAutomationState(
          AutomationState.IDLE,
          'Gate closed. Camera turned OFF. System IDLE.'
        );
      } else {
        const reason = this.lastCloseDiagnostics?.failureReason || 'Operation suppressed';
        this._handleClosureFailure(attemptId, `Automatic gate closure failed: ${reason}`);
      }
    } catch (err) {
      this._handleClosureFailure(attemptId, `Automatic gate closure failed: ${err.message}`);
    }
  }

  /**
   * Central failure handler when gate closure fails or is rejected:
   * - Preserves actual gate state as OPEN (angle 90°)
   * - Stops repeated automatic close attempts
   * - Keeps camera and monitoring active
   * - Does NOT reset vehicle event latch until safely recovered
   */
  _handleClosureFailure(attemptId, errorMessage) {
    console.error(`[GateController][${attemptId}] Closure Failure:`, errorMessage);
    this.lastClosureError = {
      attemptId,
      error: errorMessage,
      timestamp: Date.now()
    };

    this._cancelClearanceCountdown();
    this.isOperationInProgress = false;

    // Do NOT falsely mark gate closed
    // Do NOT reset event latch until safely recovered
    this._setAutomationState(
      AutomationState.ERROR,
      `${errorMessage}. Gate remains OPEN for safety. Click Retry Close or clear entrance.`
    );
  }

  /**
   * Safe retry path for gate closure when in ERROR or GATE_OPEN state.
   * Verifies current IR state and controller readiness before retrying.
   */
  async retryClearanceClosure() {
    if (this.automationState !== AutomationState.ERROR && this.automationState !== AutomationState.GATE_OPEN) {
      throw new Error(`Cannot retry closure from state: ${this.automationState}`);
    }

    if (this.isOperationInProgress) {
      throw new Error('Cannot retry gate closure: Another operation is currently in progress.');
    }

    // Verify current IR state: never close when IR reports an obstacle
    if (this.isObstacleDetected) {
      throw new Error('Cannot retry gate closure: IR obstacle sensor detects hazard in gate area!');
    }

    // Verify adapter status
    const status = await this.adapter.getStatus();
    if (!status.isConnected && !this.adapter.isSimulated()) {
      throw new Error('Cannot retry gate closure: Arduino UNO is disconnected.');
    }

    if (status && status.obstacleDetected) {
      throw new Error('Cannot retry gate closure: Hardware reports obstacle detected in gate area.');
    }

    this._cancelApproachClearTimer();
    console.log('[GateController] Initiating safe retry of gate closure...');
    this._setAutomationState(
      AutomationState.GATE_CLOSING,
      'Initiating safe retry of gate closure...'
    );

    try {
      const closed = await this.requestCloseGate('MANUAL_RETRY');
      if (closed) {
        if (this.onCameraAction) {
          this.onCameraAction({ action: 'STOP', reason: 'GATE_LIFECYCLE_COMPLETED' });
        }
        this.resetEventLatch(true);
        this._setAutomationState(
          AutomationState.IDLE,
          'Gate closed successfully on retry. Camera turned OFF. System IDLE.'
        );
        return true;
      } else {
        const reason = this.lastCloseDiagnostics?.failureReason || 'Operation suppressed';
        this._handleClosureFailure('RETRY', `Retry closure failed: ${reason}`);
        return false;
      }
    } catch (err) {
      this._handleClosureFailure('RETRY', `Retry closure error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Resumes vehicle clearance monitoring when the gate is already verified OPEN.
   * Useful for recovering from an ERROR state or synchronizing with an open barrier.
   */
  resumeClearanceMonitoring() {
    const isPhysicallyOpen = (
      this.state === GateState.HARDWARE_CONFIRMED ||
      (this.adapter && typeof this.adapter.simulatedAngle === 'number' && this.adapter.simulatedAngle >= 45) ||
      (this.adapter && this.adapter.lastTelemetry && this.adapter.lastTelemetry.gateState === 'OPEN')
    );
    if (!isPhysicallyOpen) {
      throw new Error('Cannot resume clearance monitoring: Gate is not confirmed OPEN.');
    }
    console.log('[GateController] Resuming vehicle clearance monitoring for already-open gate.');
    this.eventLatched = true;
    this._setAutomationState(
      AutomationState.GATE_OPEN,
      'Gate verified OPEN. Resuming vehicle clearance monitoring.'
    );
    this._emitTelemetry(90, 'OPEN (Monitoring Resumed)');
    if (!this.isObstacleDetected) {
      this._startClearanceCountdown();
    }
    return true;
  }

  /**
   * Handle camera initialization failure safely:
   * Keep the gate closed, set ERROR state, do NOT open automatically.
   */
  handleCameraStartupFailure(err) {
    console.error('[GateController] Camera startup error:', err);
    this._setAutomationState(
      AutomationState.ERROR,
      `Camera startup failure: ${err.message || err}. Gate remains CLOSED.`
    );
  }

  /**
   * Evaluates AI car confirmation and requests gate opening if allowed.
   * Implements ONE-SHOT VEHICLE CONFIRMATION:
   * - Triggers gate opening only once per vehicle approach.
   * - Repeated detections while gate is already OPEN do not issue repeated OPEN commands.
   * - If gate is already OPEN, advances directly to GATE_OPEN and continues clearance workflow.
   */
  async handleCarConfirmed(evaluation) {
    if (!this.config.AUTO_GATE_ENABLED) {
      console.log('[GateController] Automatic gate opening is disabled in configuration.');
      return false;
    }

    // Accept confirmation ONLY when vehicle is approaching
    const allowedState = this.config.IR_FIRST_AUTOMATION
      ? (this.automationState === AutomationState.VEHICLE_APPROACHING)
      : (this.automationState === AutomationState.IDLE || this.automationState === AutomationState.VEHICLE_APPROACHING);

    if (!allowedState) {
      console.log(`[GateController] Car confirmed, but automation state is ${this.automationState}. Gate opening ignored.`);
      return false;
    }

    // Event Latch check: vehicle confirmation triggers gate opening only once per vehicle approach
    if (this.eventLatched) {
      console.log('[GateController] Vehicle event is currently LATCHED. Gate already requested for this vehicle.');
      return false;
    }

    // Debounce / Anti-bounce check before transmitting OPEN
    const now = Date.now();
    if (this.isOperationInProgress || (now - this.lastCommandTime < this.config.COMMAND_DEBOUNCE_MS)) {
      console.log('[GateController] Gate is currently busy or debouncing. Open command suppressed.');
      return false;
    }

    // Engage event latch and mark operation in progress synchronously
    this.eventLatched = true;
    this.isOperationInProgress = true;

    // Cancel any approach clear debounce timer when car is confirmed!
    this._cancelApproachClearTimer();

    // Inspect controller and adapter state BEFORE requesting OPEN
    const status = await this.adapter.getStatus();

    // Handle UNKNOWN or disconnected state safely
    const isUnknownState = (
      !status ||
      status.gateState === 'UNKNOWN' ||
      (!status.isConnected && !this.adapter.isSimulated())
    );

    if (isUnknownState) {
      this.isOperationInProgress = false;
      const reason = (!status || !status.isConnected)
        ? 'Arduino controller disconnected'
        : 'Controller gate state is UNKNOWN';
      console.warn(`[GateController] Cannot open gate: ${reason}.`);
      this.openAttemptCounter = (this.openAttemptCounter || 0) + 1;
      const opId = `OPEN-UNKNOWN-${this.openAttemptCounter}-${Date.now()}`;
      this.lastOpenDiagnostics = {
        operationId: opId,
        requestSource: 'AI_AUTOMATIC',
        workflowStateBefore: this.automationState,
        controllerStateBefore: this.state,
        isAlreadyOpen: false,
        isOperationActive: false,
        openTransmitted: false,
        ackReceived: false,
        timeoutOccurred: false,
        failureReason: reason,
        workflowStateAfter: AutomationState.ERROR
      };
      this._setAutomationState(
        AutomationState.ERROR,
        `Cannot open gate: ${reason}. Check controller connection.`
      );
      return false;
    }

    // Check if gate is already OPEN
    const isAlreadyOpen = (
      this.state === GateState.HARDWARE_CONFIRMED ||
      (status && status.gateState === 'OPEN') ||
      (this.adapter && typeof this.adapter.simulatedAngle === 'number' && this.adapter.simulatedAngle >= 45)
    );

    if (isAlreadyOpen) {
      this.isOperationInProgress = false;
      this.openAttemptCounter = (this.openAttemptCounter || 0) + 1;
      const opId = `OPEN-ALREADY-OPEN-${this.openAttemptCounter}-${Date.now()}`;
      const diag = {
        operationId: opId,
        requestSource: 'AI_AUTOMATIC',
        workflowStateBefore: this.automationState,
        controllerStateBefore: this.state,
        isAlreadyOpen: true,
        isOperationActive: false,
        openTransmitted: false,
        ackReceived: true,
        timeoutOccurred: false,
        failureReason: null,
        workflowStateAfter: AutomationState.GATE_OPEN
      };
      this.lastOpenDiagnostics = diag;
      console.log(`[GateController][${opId}] Car confirmed and gate is already OPEN. Continuing clearance workflow without redundant serial OPEN.`);

      this.eventLatched = true;
      this.state = GateState.HARDWARE_CONFIRMED;
      this._setAutomationState(
        AutomationState.GATE_OPEN,
        'Gate is already OPEN. Monitoring IR sensor for vehicle passage.'
      );
      this._emitTelemetry(90, 'OPEN (Already Open Verified)');

      // If obstacle is already clear, start clearance countdown immediately
      if (!this.isObstacleDetected) {
        this._startClearanceCountdown();
      }
      return true;
    }

    this._setAutomationState(
      AutomationState.CAR_CONFIRMED,
      `Car confirmed (${evaluation.qualifyingCar?.percentage || 0}%). Opening gate...`
    );

    const opened = await this.requestOpenGate('AI_AUTOMATIC', {
      ...evaluation,
      workflowManaged: true
    });

    if (opened) {
      this._setAutomationState(
        AutomationState.GATE_OPEN,
        'Gate OPEN confirmed. Monitoring IR sensor for vehicle passage.'
      );

      // If obstacle is already clear when opened, start clearance countdown immediately
      if (!this.isObstacleDetected) {
        this._startClearanceCountdown();
      }
      return true;
    } else {
      const reason = this.lastOpenDiagnostics?.failureReason || 'Failed to open gate after car confirmation';
      this._setAutomationState(
        AutomationState.ERROR,
        `Automatic gate open failed: ${reason}`
      );
      return false;
    }
  }

  /**
   * Requests gate open via active adapter, stepping through the 4 verification stages.
   * Tracks structured diagnostics across operation lifecycle.
   */
  async requestOpenGate(source = 'MANUAL', metadata = {}) {
    this.openAttemptCounter = (this.openAttemptCounter || 0) + 1;
    const operationId = `OPEN-${this.openAttemptCounter}-${Date.now()}`;

    const diag = {
      operationId,
      requestSource: source,
      workflowStateBefore: this.automationState,
      controllerStateBefore: this.state,
      isAlreadyOpen: false,
      isOperationActive: this.isOperationInProgress,
      openTransmitted: false,
      ackReceived: false,
      timeoutOccurred: false,
      failureReason: null,
      workflowStateAfter: null
    };

    if (this.isOperationInProgress && source !== 'AI_AUTOMATIC') {
      diag.failureReason = 'Another gate operation is currently in progress';
      diag.workflowStateAfter = this.automationState;
      this.lastOpenDiagnostics = diag;
      console.log(`[GateController][${operationId}] Another operation in progress. OPEN command suppressed.`);
      return false;
    }

    // Prevent duplicate command if already open
    const currentStatus = await this.adapter.getStatus();
    const isAlreadyOpen = (
      this.state === GateState.HARDWARE_CONFIRMED ||
      this.automationState === AutomationState.GATE_OPEN ||
      (currentStatus && currentStatus.gateState === 'OPEN') ||
      (this.adapter && typeof this.adapter.simulatedAngle === 'number' && this.adapter.simulatedAngle >= 45)
    );

    if (isAlreadyOpen) {
      diag.isAlreadyOpen = true;
      diag.failureReason = 'Gate is already OPEN';
      diag.workflowStateAfter = this.automationState;
      this.lastOpenDiagnostics = diag;
      console.log(`[GateController][${operationId}] Gate is already OPEN. Duplicate OPEN command suppressed.`);
      return false;
    }

    const now = Date.now();
    this.lastCommandTime = now;
    this.isOperationInProgress = true;

    // Stage 1: Command Requested
    this.state = GateState.OPEN_REQUESTED;
    this._notifyState(GateState.OPEN_REQUESTED, `[Stage 1] Gate open requested by ${source}`);

    try {
      if (this.adapter.isSimulated()) {
        diag.openTransmitted = true;
        this.state = GateState.SIMULATED_CYCLE;
        this._notifyState(GateState.SIMULATED_CYCLE, 'Simulating gate barrier open cycle (MOCK MODE)...');
        this._emitTelemetry(90, 'SIMULATED OPEN');

        // Execute mock cycle
        const result = await this.adapter.requestOpen(metadata, (stage, angle) => {
          this._emitTelemetry(angle, stage === 'SIMULATED_OPEN' ? 'SIMULATED OPEN (90°)' : 'SIMULATED CLOSED (0°)');
        });

        diag.ackReceived = true;
        this.lastCommandResult = result.message;
        if (metadata.standaloneCycle) {
          this.state = GateState.IDLE;
          this._notifyState(GateState.IDLE, 'Simulated cycle finished. Ready.');
          this._emitTelemetry(0, 'SIMULATED CLOSED');
        } else {
          this.state = GateState.HARDWARE_CONFIRMED;
          this._notifyState(GateState.HARDWARE_CONFIRMED, 'Simulated barrier open (90°).');
          this._emitTelemetry(90, 'SIMULATED OPEN');
        }
        diag.workflowStateAfter = this.automationState;
        this.lastOpenDiagnostics = diag;
        return true;
      } else {
        // Physical interface adapter with 4-stage tracking
        diag.openTransmitted = true;
        const result = await this.adapter.requestOpen(metadata, (stage, stageMessage) => {
          if (stage === 'COMMAND_TRANSMITTED') {
            diag.openTransmitted = true;
            this.state = GateState.COMMAND_TRANSMITTED;
            this._notifyState(GateState.COMMAND_TRANSMITTED, `[Stage 2] ${stageMessage}`);
            this._emitTelemetry(null, 'TRANSMITTED (Awaiting Arduino Acknowledgment)');
          } else if (stage === 'ACK_RECEIVED') {
            diag.ackReceived = true;
            this.state = GateState.ACK_RECEIVED;
            this._notifyState(GateState.ACK_RECEIVED, `[Stage 3] ${stageMessage}`);
            this._emitTelemetry(90, 'ARDUINO ACKNOWLEDGED (Barrier Raising)');
          } else if (stage === 'HARDWARE_CONFIRMED') {
            this.state = GateState.HARDWARE_CONFIRMED;
            this._notifyState(GateState.HARDWARE_CONFIRMED, `[Stage 4] ${stageMessage}`);
            this._emitTelemetry(90, 'ACTUATOR COMMANDED (Open-Loop Actuator Acknowledged)');
          }
        });

        diag.ackReceived = true;
        this.lastCommandResult = result.message || 'Arduino Confirmed';
        this.state = GateState.HARDWARE_CONFIRMED;
        this._emitTelemetry(90, 'OPEN (Open-Loop Actuator Acknowledged)');
        diag.workflowStateAfter = this.automationState;
        this.lastOpenDiagnostics = diag;
        return true;
      }
    } catch (err) {
      diag.failureReason = err.message;
      diag.timeoutOccurred = err.message && err.message.toLowerCase().includes('timeout');
      diag.workflowStateAfter = this.automationState;
      this.lastOpenDiagnostics = diag;

      const isDisconnect = err.message && err.message.toLowerCase().includes('disconnect');
      this.state = isDisconnect ? GateState.DISCONNECTED : GateState.ERROR;
      this.lastCommandResult = `Error: ${err.message}`;

      this._notifyState(
        this.state,
        isDisconnect ? `Controller Disconnected: ${err.message}` : `Controller request failed: ${err.message}`
      );
      this._emitTelemetry(null, isDisconnect ? 'DISCONNECTED' : `ERROR: ${err.message}`);
      return false;
    } finally {
      // Physical operation complete; release lock immediately to allow future serialized operations
      this.isOperationInProgress = false;
    }
  }

  /**
   * Request gate close with strict serialization, IR safety enforcement, and diagnostic logging.
   */
  async requestCloseGate(source = 'MANUAL', existingAttemptId = null) {
    this.closeAttemptCounter = (this.closeAttemptCounter || 0) + 1;
    const attemptId = existingAttemptId || `CLOSE-${this.closeAttemptCounter}-${Date.now()}`;

    const diag = {
      attemptId,
      source,
      workflowState: this.automationState,
      gateState: this.state,
      irState: this.isObstacleDetected ? 'OBSTACLE_DETECTED' : 'CLEAR',
      closeRequested: true,
      commandTransmitted: false,
      ackReceived: false,
      operationInProgress: this.isOperationInProgress,
      timeoutOccurred: false,
      failureReason: null
    };

    console.log(`[GateController][${attemptId}] Close initiated by ${source}. Diagnostics:`, JSON.stringify(diag));

    // 1. Safety check: reject CLOSE if obstacle is detected
    if (this.isObstacleDetected) {
      diag.failureReason = 'IR obstacle detected in gate area';
      console.warn(`[GateController][${attemptId}] Refusing CLOSE: ${diag.failureReason}`);
      this.lastCloseDiagnostics = diag;
      const err = new Error('Command rejected: Obstacle detected in gate area!');
      throw err;
    }

    // 2. Prevent overlapping operations
    if (this.isOperationInProgress) {
      diag.operationInProgress = true;
      diag.failureReason = 'Another gate operation is currently in progress';
      console.warn(`[GateController][${attemptId}] CLOSE suppressed: ${diag.failureReason}`);
      this.lastCloseDiagnostics = diag;
      return false;
    }

    // 3. Prevent duplicate CLOSE if already closed
    const currentStatus = await this.adapter.getStatus();
    const isAlreadyClosed = (currentStatus.gateState === 'CLOSED' && (!currentStatus.gateAngle || currentStatus.gateAngle === 0));
    if (isAlreadyClosed && this.automationState !== AutomationState.GATE_CLOSING && this.automationState !== AutomationState.VEHICLE_CLEARING) {
      diag.failureReason = 'Gate is already CLOSED';
      console.log(`[GateController][${attemptId}] Duplicate CLOSE suppressed: ${diag.failureReason}`);
      this.lastCloseDiagnostics = diag;
      return false;
    }

    // 4. Serialize operation
    this.isOperationInProgress = true;
    diag.commandTransmitted = true;
    console.log(`[GateController][${attemptId}] Transmitting CLOSE command to adapter...`);

    try {
      const result = await this.adapter.requestClose({ attemptId }, (stage, stageMsg) => {
        if (stage === 'COMMAND_TRANSMITTED') {
          diag.commandTransmitted = true;
        } else if (stage === 'ACK_RECEIVED') {
          diag.ackReceived = true;
        }
        this._notifyState(stage, stageMsg);
      });

      diag.ackReceived = true;
      this.lastCloseDiagnostics = diag;
      this.state = GateState.IDLE;
      this._notifyState(GateState.IDLE, result.message || 'Gate closed (Open-Loop Actuator Acknowledged).');
      this._emitTelemetry(0, 'CLOSED (Open-Loop Actuator Acknowledged)');
      console.log(`[GateController][${attemptId}] Gate successfully closed.`);
      return true;
    } catch (err) {
      diag.failureReason = err.message;
      diag.timeoutOccurred = err.message.toLowerCase().includes('timeout');
      this.lastCloseDiagnostics = diag;
      console.error(`[GateController][${attemptId}] Gate close failed:`, err.message, 'Timeout:', diag.timeoutOccurred);

      // Preserve actual gate state! The gate physically remains open
      // Do NOT set gateAngle = 0 or mark gate as CLOSED
      this.state = GateState.ERROR;
      this._notifyState(GateState.ERROR, `Close failed [${attemptId}]: ${err.message}`);
      throw err;
    } finally {
      this.isOperationInProgress = false;
    }
  }

  async emergencyStop() {
    this._cancelClearanceCountdown();
    this._cancelApproachClearTimer();
    this.isOperationInProgress = false;
    this.state = GateState.ERROR;
    this._notifyState(GateState.ERROR, 'EMERGENCY STOP TRIGGERED');
    return await this.adapter.emergencyStop();
  }

  _setAutomationState(state, message) {
    this.automationState = state;
    if (this.onAutomationStateChange) {
      this.onAutomationStateChange({
        state: this.automationState,
        message,
        timestamp: Date.now()
      });
    }
  }

  _notifyState(state, message) {
    this.state = state;
    if (this.onStateChange) {
      this.onStateChange({
        state,
        message,
        isSimulated: this.adapter.isSimulated(),
        timestamp: Date.now()
      });
    }
  }

  async _emitTelemetry(forcedAngle = null, customStatus = null) {
    if (!this.onTelemetryUpdate) return;
    const status = await this.adapter.getStatus();
    this.onTelemetryUpdate({
      mode: this.activeMode,
      adapterName: this.adapter.name,
      isSimulated: this.adapter.isSimulated(),
      state: this.state,
      automationState: this.automationState,
      gateAngle: forcedAngle !== null ? forcedAngle : (status.gateAngle || 0),
      statusText: customStatus || status.statusText || 'Ready',
      lastCommandResult: this.lastCommandResult,
      vehicleCount: status.vehicleCount || 0,
      clearanceDelayMs: this.clearanceDelayMs,
      // Fully forward all hardware state fields
      isConnected: !!status.isConnected,
      connectionState: status.connectionState || (status.isConnected ? ConnectionState.CONNECTED : ConnectionState.DISCONNECTED),
      hardwareConfirmed: !!status.hardwareConfirmed,
      gateState: status.gateState || (this.state === GateState.IDLE ? 'CLOSED' : this.state),
      obstacleDetected: !!status.obstacleDetected || this.isObstacleDetected,
      port: status.port || null,
      baudRate: status.baudRate || null,
      lastAck: status.lastAck || 'None',
      lastError: status.lastError || null,
      lastCommand: status.lastCommand || 'None',
      lastCommandStage: status.lastCommandStage || 'IDLE',
      hardwareFeedback: status.hardwareFeedback || 'OPEN_LOOP_SERVO',
      firmwareCompatibility: status.firmwareCompatibility || 'UNKNOWN'
    });
  }
}

// Export for ES modules and standard browser window scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GateController,
    GateState,
    AutomationState,
    ConnectionState,
    ControllerMode,
    MockGateControllerAdapter,
    SerialGateControllerAdapter,
    ExistingHttpControllerAdapter,
    ExistingSerialBridgeAdapter
  };
} else if (typeof window !== 'undefined') {
  window.GateController = GateController;
  window.GateState = GateState;
  window.AutomationState = AutomationState;
  window.ConnectionState = ConnectionState;
  window.ControllerMode = ControllerMode;
  window.MockGateControllerAdapter = MockGateControllerAdapter;
  window.SerialGateControllerAdapter = SerialGateControllerAdapter;
  window.ExistingHttpControllerAdapter = ExistingHttpControllerAdapter;
  window.ExistingSerialBridgeAdapter = ExistingSerialBridgeAdapter;
}
