/**
 * SMARTPARK AI - Automated Test Suite
 * tests/detection_policy_test.js
 * 
 * Verifies:
 * 1. AI Car Detection & Non-Car Rejection Policy
 * 2. Confidence Threshold Filtering
 * 3. Consecutive Detection Confirmation (3/3 threshold)
 * 4. Detection Counter Reset on Interruptions
 * 5. Gate Command Debouncing & Anti-Bounce
 * 6. Mock Controller Behavior (Virtual simulation)
 * 7. Controller Communication Failure Handling
 */

const assert = require('assert');
const CONFIG = require('../js/config.js');
const VehicleDetection = require('../js/vehicleDetection.js');
const {
  GateController,
  GateState,
  ConnectionState,
  ControllerMode,
  MockGateControllerAdapter,
  SerialGateControllerAdapter,
  ExistingHttpControllerAdapter
} = require('../js/gateController.js');
const SerialBridge = require('../server/serialBridge.js');

let passCount = 0;
let failCount = 0;

function it(description, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${description}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    failCount++;
  }
}

async function itAsync(description, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${description}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    failCount++;
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('       SMARTPARK AI - Unit Test Suite: AI Policy & Gate Logic   ');
  console.log('================================================================\n');

  // ---------------------------------------------------------
  // SUITE 1: Car Detection & Non-Car Rejection Policy
  // ---------------------------------------------------------
  console.log('--- SUITE 1: Car Detection & Non-Car Rejection Policy ---');

  const ai = new VehicleDetection({
    CAR_CONFIDENCE_THRESHOLD: 0.80,
    REQUIRED_CONSECUTIVE_DETECTIONS: 3,
    TARGET_CLASS: 'car',
    REJECTED_CLASSES: ['person', 'bicycle', 'motorcycle', 'bus', 'truck']
  });

  it('1.1: Car Detection - Identifies qualifying car (score 0.94)', () => {
    ai.resetConfirmation();
    const predictions = [{ class: 'car', score: 0.94, bbox: [10, 10, 200, 150] }];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, true);
    assert.strictEqual(res.qualifyingCar.class, 'car');
    assert.strictEqual(res.qualifyingCar.percentage, 94);
  });

  it('1.2: Non-Car Rejection - Rejects person even with high confidence (score 0.96)', () => {
    ai.resetConfirmation();
    const predictions = [{ class: 'person', score: 0.96, bbox: [10, 10, 50, 150] }];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, false);
    assert.strictEqual(res.isConfirmed, false);
    assert.ok(res.statusText.includes('REJECTED: PERSON'));
  });

  it('1.3: Non-Car Rejection - Rejects motorcycle (score 0.91)', () => {
    ai.resetConfirmation();
    const predictions = [{ class: 'motorcycle', score: 0.91, bbox: [10, 10, 80, 100] }];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, false);
    assert.ok(res.statusText.includes('REJECTED: MOTORCYCLE'));
  });

  it('1.4: Non-Car Rejection - Rejects bicycle (score 0.88)', () => {
    ai.resetConfirmation();
    const predictions = [{ class: 'bicycle', score: 0.88, bbox: [10, 10, 80, 100] }];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, false);
    assert.ok(res.statusText.includes('REJECTED: BICYCLE'));
  });

  it('1.5: Non-Car Rejection - Rejects bus (0.90) and truck (0.87)', () => {
    ai.resetConfirmation();
    const predictions = [
      { class: 'bus', score: 0.90, bbox: [0, 0, 300, 200] },
      { class: 'truck', score: 0.87, bbox: [10, 10, 250, 180] }
    ];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, false);
  });

  it('1.6: Empty Scene - Correctly reports no object detected', () => {
    ai.resetConfirmation();
    const res = ai.evaluateDetection([]);
    assert.strictEqual(res.hasCar, false);
    assert.strictEqual(res.statusText, 'NO OBJECT DETECTED');
  });

  // ---------------------------------------------------------
  // SUITE 2: Confidence Threshold Filtering
  // ---------------------------------------------------------
  console.log('\n--- SUITE 2: Confidence Threshold Filtering ---');

  it('2.1: Passes car meeting configured threshold (82% >= 80%)', () => {
    ai.resetConfirmation();
    const predictions = [{ class: 'car', score: 0.82, bbox: [0, 0, 100, 100] }];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, true);
  });

  it('2.2: Rejects car below configured threshold (68% < 80%)', () => {
    ai.resetConfirmation();
    const predictions = [{ class: 'car', score: 0.68, bbox: [0, 0, 100, 100] }];
    const res = ai.evaluateDetection(predictions);
    assert.strictEqual(res.hasCar, false);
    assert.ok(res.statusText.includes('LOW CONFIDENCE'));
  });

  // ---------------------------------------------------------
  // SUITE 3: Consecutive Detection Confirmation & Reset
  // ---------------------------------------------------------
  console.log('\n--- SUITE 3: Consecutive Detection Confirmation & Reset ---');

  it('3.1: Consecutive Confirmation - Requires 3 cycles before confirming', () => {
    ai.resetConfirmation();
    const carFrame = [{ class: 'car', score: 0.89, bbox: [0, 0, 100, 100] }];

    const r1 = ai.evaluateDetection(carFrame);
    assert.strictEqual(r1.consecutiveCount, 1);
    assert.strictEqual(r1.isConfirmed, false);

    const r2 = ai.evaluateDetection(carFrame);
    assert.strictEqual(r2.consecutiveCount, 2);
    assert.strictEqual(r2.isConfirmed, false);

    const r3 = ai.evaluateDetection(carFrame);
    assert.strictEqual(r3.consecutiveCount, 3);
    assert.strictEqual(r3.isConfirmed, true);
    assert.strictEqual(r3.statusText, 'CAR CONFIRMED');
  });

  it('3.2: Detection Reset - Resets counter immediately if non-car appears', () => {
    ai.resetConfirmation();
    const carFrame = [{ class: 'car', score: 0.89, bbox: [0, 0, 100, 100] }];
    const personFrame = [{ class: 'person', score: 0.95, bbox: [0, 0, 50, 100] }];

    ai.evaluateDetection(carFrame); // 1/3
    ai.evaluateDetection(carFrame); // 2/3
    assert.strictEqual(ai.consecutiveCarDetections, 2);

    const rInterrupt = ai.evaluateDetection(personFrame);
    assert.strictEqual(rInterrupt.consecutiveCount, 0);
    assert.strictEqual(rInterrupt.isConfirmed, false);
    assert.strictEqual(ai.consecutiveCarDetections, 0);
  });

  it('3.3: Detection Reset - Resets counter immediately if scene becomes empty', () => {
    ai.resetConfirmation();
    const carFrame = [{ class: 'car', score: 0.89, bbox: [0, 0, 100, 100] }];

    ai.evaluateDetection(carFrame); // 1/3
    assert.strictEqual(ai.consecutiveCarDetections, 1);

    const rEmpty = ai.evaluateDetection([]);
    assert.strictEqual(rEmpty.consecutiveCount, 0);
    assert.strictEqual(rEmpty.isConfirmed, false);
    assert.strictEqual(ai.consecutiveCarDetections, 0);
  });

  // ---------------------------------------------------------
  // SUITE 4: Gate Command Debouncing
  // ---------------------------------------------------------
  console.log('\n--- SUITE 4: Gate Command Debouncing ---');

  await itAsync('4.1: Debouncing - Suppresses duplicate open requests during active cycle', async () => {
    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.MOCK,
      COMMAND_DEBOUNCE_MS: 2000,
      AUTO_GATE_ENABLED: true
    });
    gate.init();

    const mockEval = {
      isConfirmed: true,
      qualifyingCar: { percentage: 92 }
    };

    // First request triggers opening
    const firstCall = gate.handleCarConfirmed(mockEval);
    assert.strictEqual(gate.isOperationInProgress, true);

    // Second call during operation is rejected
    const secondCall = await gate.handleCarConfirmed(mockEval);
    assert.strictEqual(secondCall, false);
  });

  // ---------------------------------------------------------
  // SUITE 5: Mock Controller Behavior
  // ---------------------------------------------------------
  console.log('\n--- SUITE 5: Mock Controller Behavior ---');

  it('5.1: Mock Controller - Explicitly flags simulated status and zero physical claim', () => {
    const mockAdapter = new MockGateControllerAdapter();
    assert.strictEqual(mockAdapter.isSimulated(), true);
  });

  await itAsync('5.2: Mock Controller - Emits status and tracks virtual vehicle passages', async () => {
    const mockAdapter = new MockGateControllerAdapter();
    const statusBefore = await mockAdapter.getStatus();
    assert.strictEqual(statusBefore.isSimulated, true);
    assert.strictEqual(statusBefore.hardwareConfirmed, false);
    assert.strictEqual(statusBefore.vehicleCount, 0);
  });

  // ---------------------------------------------------------
  // SUITE 6: Controller Communication Failure Handling
  // ---------------------------------------------------------
  console.log('\n--- SUITE 6: Controller Communication Failure Handling ---');

  await itAsync('6.1: HTTP Controller - Reports error when URL is not configured', async () => {
    const httpAdapter = new ExistingHttpControllerAdapter({ url: '' });
    try {
      await httpAdapter.requestOpen();
      assert.fail('Should have thrown error for unconfigured URL');
    } catch (err) {
      assert.ok(err.message.includes('not configured'));
    }
  });

  await itAsync('6.2: HTTP Controller - Handles network failure gracefully without crashing', async () => {
    // Attempt request to invalid local port (guaranteed to fail connection)
    const httpAdapter = new ExistingHttpControllerAdapter({
      url: 'http://127.0.0.1:59999/nonexistent/open',
      timeoutMs: 800
    });

    try {
      await httpAdapter.requestOpen();
      assert.fail('Should have failed connection');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  await itAsync('6.3: GateController - Sets ERROR state on adapter communication failure', async () => {
    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.EXISTING_HTTP_CONTROLLER,
      HTTP_CONTROLLER_URL: 'http://127.0.0.1:59999/invalid-endpoint',
      CONTROLLER_TIMEOUT_MS: 500,
      AUTO_GATE_ENABLED: true
    });
    gate.init();

    const result = await gate.requestOpenGate('TEST_FAILURE');
    assert.strictEqual(result, false);
    assert.strictEqual(gate.state, GateState.ERROR);
    assert.ok(gate.lastCommandResult.startsWith('Error:'));
  });

  // ---------------------------------------------------------
  // SUITE 7: Event Latching & Duplicate OPEN Prevention
  // ---------------------------------------------------------
  console.log('\n--- SUITE 7: Event Latching & Duplicate Prevention ---');

  await itAsync('7.1: Event Latch - Suppresses repeated OPEN requests while vehicle is in view', async () => {
    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.MOCK,
      COMMAND_DEBOUNCE_MS: 100,
      AUTO_GATE_ENABLED: true
    });
    gate.init();

    const carConfirmedEval = { isConfirmed: true, qualifyingCar: { percentage: 95 } };

    // Initial confirmed detection engages latch and opens
    const trigger1 = await gate.handleCarConfirmed(carConfirmedEval);
    assert.strictEqual(trigger1, true);
    assert.strictEqual(gate.eventLatched, true);

    // Subsequent frame with same car in view -> rejected by latch
    const trigger2 = await gate.handleCarConfirmed(carConfirmedEval);
    assert.strictEqual(trigger2, false);
  });

  it('7.2: Event Latch - Resets automatically when vehicle exits detection zone', () => {
    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.MOCK,
      COMMAND_DEBOUNCE_MS: 100,
      AUTO_GATE_ENABLED: true
    });
    gate.init();
    gate.eventLatched = true;

    // Vehicle clears scene
    gate.resetEventLatch();
    assert.strictEqual(gate.eventLatched, false);
  });

  it('7.3: Event Latch - Preserves latch protection during active vehicle transit window', () => {
    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.MOCK,
      COMMAND_DEBOUNCE_MS: 3000,
      AUTO_GATE_ENABLED: true
    });
    gate.init();
    gate.eventLatched = true;
    gate.lastCommandTime = Date.now(); // Command fired just now

    // Attempt premature unlatch while vehicle is crossing gate area
    const unlatched = gate.resetEventLatch(false);
    assert.strictEqual(unlatched, false);
    assert.strictEqual(gate.eventLatched, true, 'Latch must remain active during transit debounce');

    // Force unlatch (e.g. operator manual override)
    const forced = gate.resetEventLatch(true);
    assert.strictEqual(forced, true);
    assert.strictEqual(gate.eventLatched, false);
  });

  // ---------------------------------------------------------
  // SUITE 8: Serial Bridge Command Formatting & Validation
  // ---------------------------------------------------------
  console.log('\n--- SUITE 8: Serial Bridge Command Formatting & Validation ---');

  await itAsync('8.1: Command Validation - Rejects unsupported serial command', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();
    try {
      await bridge.sendCommand('DESTROY_BARRIER');
      assert.fail('Should have rejected invalid command');
    } catch (err) {
      assert.ok(err.message.includes('Invalid command'));
    }
  });

  await itAsync('8.2: Command Formatting - Accepts and standardizes valid commands (OPEN, CLOSE, STATUS)', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();

    const openResult = await bridge.sendCommand('open');
    assert.strictEqual(openResult.success, true);
    assert.strictEqual(openResult.command, 'OPEN');
    assert.strictEqual(openResult.gateState, 'OPEN');

    const statusResult = await bridge.sendCommand('status');
    assert.strictEqual(statusResult.success, true);
    assert.strictEqual(statusResult.command, 'STATUS');
  });

  // ---------------------------------------------------------
  // SUITE 9: Serial Bridge Acknowledgment Parsing & State Tracking
  // ---------------------------------------------------------
  console.log('\n--- SUITE 9: Serial Bridge Acknowledgment Parsing & State Tracking ---');

  it('9.1: Acknowledgment Parsing - SMARTPARK_READY sets connected flag', () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge.isConnected = false;
    bridge._handleIncomingData('SMARTPARK_READY');
    assert.strictEqual(bridge.isConnected, true);
  });

  it('9.2: Acknowledgment Parsing - GATE_OPENED and GATE_CLOSED update gateState', () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge._handleIncomingData('GATE_OPENED');
    assert.strictEqual(bridge.gateState, 'OPEN');

    bridge._handleIncomingData('GATE_CLOSED');
    assert.strictEqual(bridge.gateState, 'CLOSED');
  });

  it('9.3: Acknowledgment Parsing - STATUS:OPEN and STATUS:CLOSED update gateState', () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge._handleIncomingData('STATUS:OPEN');
    assert.strictEqual(bridge.gateState, 'OPEN');

    bridge._handleIncomingData('STATUS:CLOSED');
    assert.strictEqual(bridge.gateState, 'CLOSED');
  });

  // ---------------------------------------------------------
  // SUITE 10: IR Safety Behavior in Hardware Logic
  // ---------------------------------------------------------
  console.log('\n--- SUITE 10: IR Safety Behavior in Hardware Logic ---');

  it('10.1: IR Sensor - Telemetry reflects obstacle detection events', () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge._handleIncomingData('OBSTACLE:DETECTED');
    assert.strictEqual(bridge.obstacleDetected, true);

    bridge._handleIncomingData('OBSTACLE:CLEAR');
    assert.strictEqual(bridge.obstacleDetected, false);
  });

  await itAsync('10.2: IR Safety - Gate refuses CLOSE command while obstacle is present', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();
    bridge.gateState = 'OPEN';
    bridge.obstacleDetected = true; // Obstacle currently in gate zone

    try {
      await bridge.sendCommand('CLOSE');
      assert.fail('Close command should be rejected when obstacle is present');
    } catch (err) {
      assert.ok(err.message.includes('Obstacle detected'));
      // Verify gate state remains OPEN for safety!
      assert.strictEqual(bridge.gateState, 'OPEN');
    }
  });

  // ---------------------------------------------------------
  // SUITE 11: Serial Disconnection & Recovery Handling
  // ---------------------------------------------------------
  console.log('\n--- SUITE 11: Serial Disconnection & Recovery Handling ---');

  await itAsync('11.1: Disconnection - Commands refused immediately when serial is disconnected', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge.isConnected = false; // Disconnected state
    try {
      await bridge.sendCommand('OPEN');
      assert.fail('Should refuse command when disconnected');
    } catch (err) {
      assert.ok(err.message.includes('disconnected'));
      assert.strictEqual(bridge.lastCommandStage, 'ERROR');
    }
  });

  it('11.2: Disconnection Handling - Aborts in-flight command on sudden disconnection', () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge.isConnected = true;
    let rejected = false;

    bridge.activeCommandPending = {
      command: 'OPEN',
      timer: setTimeout(() => {}, 5000),
      resolve: () => {},
      reject: (err) => {
        rejected = true;
        assert.ok(err.message.includes('disconnected'));
      }
    };

    bridge._handleDisconnection();
    assert.strictEqual(rejected, true);
    assert.strictEqual(bridge.isConnected, false);
    assert.strictEqual(bridge.activeCommandPending, null);
  });

  // ---------------------------------------------------------
  // SUITE 12: Serial Bridge Command Timeout Handling
  // ---------------------------------------------------------
  console.log('\n--- SUITE 12: Serial Bridge Command Timeout Handling ---');

  await itAsync('12.1: Command Timeout - Rejects cleanly if Arduino does not acknowledge within timeout', async () => {
    const bridge = new SerialBridge({
      isMockMode: false, // In non-mock mode without real port, will simulate pending
      timeoutMs: 150
    });
    // Manually simulate connection without automated mock reply
    bridge.isConnected = true;
    bridge.port = { write: (data, cb) => cb(null) };

    try {
      await bridge.sendCommand('OPEN');
      assert.fail('Should have timed out');
    } catch (err) {
      assert.ok(err.message.includes('timeout'));
      assert.strictEqual(bridge.lastCommandStage, 'TIMEOUT');
      assert.strictEqual(bridge.activeCommandPending, null);
    }
  });

  // ---------------------------------------------------------
  // SUITE 13: Frontend Controller State Synchronization & Guards
  // ---------------------------------------------------------
  console.log('\n--- SUITE 13: Controller State Synchronization & Guards ---');

  it('13.1: ConnectionState Constants - Defines CONNECTING, CONNECTED, DISCONNECTED, ERROR', () => {
    assert.strictEqual(ConnectionState.CONNECTING, 'CONNECTING');
    assert.strictEqual(ConnectionState.CONNECTED, 'CONNECTED');
    assert.strictEqual(ConnectionState.DISCONNECTED, 'DISCONNECTED');
    assert.strictEqual(ConnectionState.ERROR, 'ERROR');
  });

  await itAsync('13.2: Telemetry Synchronization - _emitTelemetry forwards complete hardware state', async () => {
    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.SERIAL
    });

    let receivedTelemetry = null;
    gate.init(null, (t) => {
      receivedTelemetry = t;
    });

    // Mock adapter getStatus
    gate.adapter.getStatus = async () => ({
      isConnected: true,
      connectionState: ConnectionState.CONNECTED,
      isSimulated: false,
      hardwareConfirmed: true,
      gateState: 'CLOSED',
      gateAngle: 0,
      obstacleDetected: false,
      port: '/dev/tty.usbmodem11401',
      baudRate: 9600,
      lastAck: 'STATUS:CLOSED',
      hardwareFeedback: 'OPEN_LOOP_SERVO',
      firmwareCompatibility: 'COMPATIBLE_SMARTPARK'
    });

    await gate._emitTelemetry();

    assert.ok(receivedTelemetry, 'Telemetry should have been emitted');
    assert.strictEqual(receivedTelemetry.isConnected, true);
    assert.strictEqual(receivedTelemetry.connectionState, ConnectionState.CONNECTED);
    assert.strictEqual(receivedTelemetry.gateState, 'CLOSED');
    assert.strictEqual(receivedTelemetry.port, '/dev/tty.usbmodem11401');
    assert.strictEqual(receivedTelemetry.baudRate, 9600);
    assert.strictEqual(receivedTelemetry.hardwareFeedback, 'OPEN_LOOP_SERVO');
  });

  await itAsync('13.3: Duplicate Connection Prevention - Guards against duplicate connects to same active port', async () => {
    const adapter = new SerialGateControllerAdapter({ bridgeUrl: '/api/serial' });
    adapter.lastTelemetry = { connected: true, port: '/dev/tty.usbmodem11401' };

    const result = await adapter.connect('/dev/tty.usbmodem11401', 9600);
    assert.strictEqual(result.alreadyConnected, true);
    assert.strictEqual(result.success, true);
  });

  // ---------------------------------------------------------
  // SUITE 14: AI Detection Pipeline Diagnostics & Frame Readiness
  // ---------------------------------------------------------
  console.log('\n--- SUITE 14: AI Detection Pipeline Diagnostics & Frame Readiness ---');

  await itAsync('14.1: Frame Readiness - Unready frame preserves consecutive detection count without crashing', async () => {
    const ai = new VehicleDetection(CONFIG);
    // Simulate initial valid car detection
    ai.evaluateDetection([{ class: 'car', score: 0.90, bbox: [0, 0, 100, 100] }]);
    assert.strictEqual(ai.consecutiveCarDetections, 1);

    // Mock unready video element (readyState 1, 0x0 dimensions)
    const mockUnreadyVideo = { readyState: 1, videoWidth: 0, videoHeight: 0, paused: false };
    ai.isModelReady = true;
    ai.model = { detect: async () => [] };

    const evalResult = await ai.detectCars(mockUnreadyVideo);
    assert.strictEqual(evalResult.isFrameReady, false);
    assert.strictEqual(evalResult.statusText, 'AWAITING CAMERA FRAME');
    // Consecutive count must NOT be wiped out by an unready frame
    assert.strictEqual(ai.consecutiveCarDetections, 1);
  });

  await itAsync('14.2: Model Promise Sharing - Concurrent loadModel calls reuse in-flight promise without throwing', async () => {
    const ai = new VehicleDetection(CONFIG);
    let loadCallCount = 0;
    // Mock cocoSsd global
    global.cocoSsd = {
      load: async () => {
        loadCallCount++;
        await new Promise(r => setTimeout(r, 20));
        return { detect: async () => [] };
      }
    };

    // Trigger concurrent loadModel calls
    const p1 = ai.loadModel();
    const p2 = ai.loadModel();
    const [m1, m2] = await Promise.all([p1, p2]);

    assert.strictEqual(m1, m2, 'Both calls must resolve to the identical model instance');
    assert.strictEqual(loadCallCount, 1, 'Model loading should only execute once');
    assert.strictEqual(ai.isModelReady, true);
  });

  it('14.3: Policy Compliance - Exactly 80% confidence and class "car" qualifies', () => {
    const ai = new VehicleDetection(CONFIG);
    const borderCar = [{ class: 'car', score: 0.80, bbox: [0, 0, 50, 50] }];
    const res = ai.evaluateDetection(borderCar);
    assert.strictEqual(res.hasCar, true);
    assert.strictEqual(res.qualifyingCar.percentage, 80);
    assert.strictEqual(res.consecutiveCount, 1);

    // 79.9% fails
    const lowCar = [{ class: 'car', score: 0.799, bbox: [0, 0, 50, 50] }];
    const resLow = ai.evaluateDetection(lowCar);
    assert.strictEqual(resLow.hasCar, false);
    assert.strictEqual(resLow.consecutiveCount, 0);
  });

  // ---------------------------------------------------------
  // Summary
  // ---------------------------------------------------------
  console.log('\n================================================================');
  console.log(`Test Execution Finished: ${passCount} Passed, ${failCount} Failed`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite();
