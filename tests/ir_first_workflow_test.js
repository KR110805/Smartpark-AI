/**
 * SMARTPARK AI - IR-First Camera & Automatic Gate Control Test Suite
 * tests/ir_first_workflow_test.js
 * 
 * Verifies all 18 core requirements specified in Task 6:
 * 1. Automatic car confirmation when the gate is CLOSED.
 * 2. Automatic car confirmation when the gate is already OPEN.
 * 3. OPEN acknowledgment success.
 * 4. OPEN timeout or rejection.
 * 5. Repeated car inference frames.
 * 6. PERSON detection rejection.
 * 7. IR blocked -> clear -> blocked transitions.
 * 8. IR debounce.
 * 9. IR clear during approach before car confirmation.
 * 10. Stable IR clearance.
 * 11. IR re-detection during clearance.
 * 12. CLOSE attempt while IR is blocked.
 * 13. CLOSE acknowledgment success.
 * 14. CLOSE acknowledgment failure.
 * 15. Workflow recovery after OPEN failure.
 * 16. Workflow recovery after CLOSE failure.
 * 17. Camera activation and deactivation without duplicate calls.
 * 18. No duplicate gate commands from repeated AI confirmation events.
 */

const assert = require('assert');
const CONFIG = require('../js/config.js');
const VehicleDetection = require('../js/vehicleDetection.js');
const {
  GateController,
  GateState,
  AutomationState,
  ConnectionState,
  ControllerMode,
  MockGateControllerAdapter
} = require('../js/gateController.js');

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
  console.log('   SMARTPARK AI - Gate Automation & Verification Test Suite     ');
  console.log('================================================================\n');

  // Helper factory to create an instrumented workflow instance
  function createTestWorkflow(options = {}) {
    const cameraActions = [];
    const automationStates = [];
    const gateStates = [];

    const gate = new GateController({
      ACTIVE_CONTROLLER_MODE: ControllerMode.MOCK,
      COMMAND_DEBOUNCE_MS: 50,
      CLEARANCE_DELAY_MS: options.clearanceDelayMs || 100,
      APPROACH_CLEAR_DELAY_MS: options.approachClearDelayMs || 60,
      AUTO_GATE_ENABLED: true,
      IR_FIRST_AUTOMATION: true,
      ...options
    });

    gate.init(
      (stateUpdate) => {
        gateStates.push(stateUpdate);
      },
      null,
      (autoUpdate) => {
        automationStates.push(autoUpdate);
      },
      (cameraReq) => {
        cameraActions.push(cameraReq);
      }
    );

    const ai = new VehicleDetection(CONFIG);

    return { gate, ai, cameraActions, automationStates, gateStates };
  }

  // -------------------------------------------------------------
  // Test 1: Automatic car confirmation when the gate is CLOSED
  // -------------------------------------------------------------
  await itAsync('1. Automatic car confirmation when the gate is CLOSED', async () => {
    const { gate, ai } = createTestWorkflow();
    assert.strictEqual(gate.adapter.simulatedAngle, 0, 'Gate starts closed');
    assert.strictEqual(gate.automationState, AutomationState.IDLE);

    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_APPROACHING);

    const car = [{ class: 'car', score: 0.92, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    const confirmed = ai.evaluateDetection(car);
    assert.strictEqual(confirmed.isConfirmed, true);

    const opened = await gate.handleCarConfirmed(confirmed);
    assert.strictEqual(opened, true);
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);
    assert.strictEqual(gate.adapter.simulatedAngle, 90, 'Gate barrier opens to 90 degrees');
    assert.strictEqual(gate.state, GateState.HARDWARE_CONFIRMED);
  });

  // -------------------------------------------------------------
  // Test 2: Automatic car confirmation when the gate is already OPEN
  // -------------------------------------------------------------
  await itAsync('2. Automatic car confirmation when the gate is already OPEN', async () => {
    const { gate, ai } = createTestWorkflow();
    // Simulate gate already in open state (e.g. from prior verified open)
    gate.adapter.simulatedAngle = 90;
    gate.state = GateState.HARDWARE_CONFIRMED;

    let openCallCount = 0;
    const origRequestOpen = gate.adapter.requestOpen.bind(gate.adapter);
    gate.adapter.requestOpen = async (meta, cb) => {
      openCallCount++;
      return await origRequestOpen(meta, cb);
    };

    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_APPROACHING);

    const car = [{ class: 'car', score: 0.92, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    const confirmed = ai.evaluateDetection(car);

    const opened = await gate.handleCarConfirmed(confirmed);
    assert.strictEqual(opened, true, 'Confirmation succeeds without error');
    assert.strictEqual(openCallCount, 0, 'No redundant open command transmitted to adapter');
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);
    assert.strictEqual(gate.lastOpenDiagnostics?.isAlreadyOpen, true);
    assert.strictEqual(gate.eventLatched, true);
  });

  // -------------------------------------------------------------
  // Test 3: OPEN acknowledgment success
  // -------------------------------------------------------------
  await itAsync('3. OPEN acknowledgment success', async () => {
    const { gate } = createTestWorkflow();
    assert.strictEqual(gate.adapter.simulatedAngle, 0);

    const success = await gate.requestOpenGate('MANUAL');
    assert.strictEqual(success, true);
    assert.strictEqual(gate.state, GateState.HARDWARE_CONFIRMED);
    assert.strictEqual(gate.adapter.simulatedAngle, 90);
    assert.strictEqual(gate.lastOpenDiagnostics?.ackReceived, true);
    assert.strictEqual(gate.lastOpenDiagnostics?.isAlreadyOpen, false);
  });

  // -------------------------------------------------------------
  // Test 4: OPEN timeout or rejection
  // -------------------------------------------------------------
  await itAsync('4. OPEN timeout or rejection', async () => {
    const { gate } = createTestWorkflow();
    gate.adapter.requestOpen = async () => {
      throw new Error('Communication timeout (4000ms) waiting for Arduino ACK');
    };

    const success = await gate.requestOpenGate('MANUAL');
    assert.strictEqual(success, false);
    assert.strictEqual(gate.state, GateState.ERROR);
    assert.strictEqual(gate.adapter.simulatedAngle, 0, 'Gate remains closed on failed open');
    assert.strictEqual(gate.lastOpenDiagnostics?.timeoutOccurred, true);
    assert.ok(gate.lastOpenDiagnostics?.failureReason.includes('timeout'));
  });

  // -------------------------------------------------------------
  // Test 5: Repeated car inference frames
  // -------------------------------------------------------------
  await itAsync('5. Repeated car inference frames', async () => {
    const { gate, ai } = createTestWorkflow();
    let openCount = 0;
    const origRequestOpen = gate.adapter.requestOpen.bind(gate.adapter);
    gate.adapter.requestOpen = async (meta, cb) => {
      openCount++;
      return await origRequestOpen(meta, cb);
    };

    gate.handleObstacleStateChange(true);
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    const confirmed = ai.evaluateDetection(car);
    await gate.handleCarConfirmed(confirmed);
    assert.strictEqual(openCount, 1);

    // Continuous frames while car remains in view
    for (let i = 0; i < 10; i++) {
      const ongoing = ai.evaluateDetection(car);
      assert.strictEqual(ongoing.isConfirmed, true);
      const res = await gate.handleCarConfirmed(ongoing);
      assert.strictEqual(res, false, 'Repeated frame must not re-trigger gate open');
    }

    assert.strictEqual(openCount, 1, 'Exactly one open command across all repeated frames');
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);
  });

  // -------------------------------------------------------------
  // Test 6: PERSON detection rejection
  // -------------------------------------------------------------
  it('6. PERSON detection rejection', () => {
    const ai = new VehicleDetection(CONFIG);
    const person = [{ class: 'person', score: 0.95, bbox: [10, 10, 80, 150] }];

    const res1 = ai.evaluateDetection(person);
    assert.strictEqual(res1.hasCar, false);
    assert.strictEqual(res1.isConfirmed, false);
    assert.strictEqual(res1.consecutiveCount, 0);
    assert.ok(res1.statusText.includes('REJECTED: PERSON'));

    const res2 = ai.evaluateDetection(person);
    assert.strictEqual(res2.isConfirmed, false);
    assert.strictEqual(res2.consecutiveCount, 0);
  });

  // -------------------------------------------------------------
  // Test 7: IR blocked -> clear -> blocked transitions
  // -------------------------------------------------------------
  await itAsync('7. IR blocked -> clear -> blocked transitions', async () => {
    const { gate, ai } = createTestWorkflow({ clearanceDelayMs: 200 });
    gate.handleObstacleStateChange(true);
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    await gate.handleCarConfirmed(ai.evaluateDetection(car));
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);

    // Vehicle clears IR
    gate.handleObstacleStateChange(false);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_CLEARING);
    assert.ok(gate.clearanceTimer !== null);

    // Vehicle/obstacle re-enters before clearance completes
    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.clearanceTimer, null, 'Clearance timer must be cancelled');
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);
    assert.strictEqual(gate.adapter.simulatedAngle, 90, 'Gate barrier remains OPEN at 90 degrees');
  });

  // -------------------------------------------------------------
  // Test 8: IR debounce
  // -------------------------------------------------------------
  await itAsync('8. IR debounce', async () => {
    const { gate, cameraActions } = createTestWorkflow({ approachClearDelayMs: 60 });
    // Vehicle approaches
    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_APPROACHING);
    assert.strictEqual(cameraActions.filter(a => a.action === 'START').length, 1);

    // Sensor flutter: momentary clear for 20ms (less than 60ms debounce)
    gate.handleObstacleStateChange(false);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_APPROACHING, 'Must not immediately drop to IDLE');
    assert.ok(gate.approachClearTimer !== null);

    // Sensor re-detects obstacle within debounce window
    await new Promise(r => setTimeout(r, 20));
    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.approachClearTimer, null, 'Approach clear timer cancelled');
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_APPROACHING);
    assert.strictEqual(cameraActions.filter(a => a.action === 'STOP').length, 0, 'No camera STOP called');
  });

  // -------------------------------------------------------------
  // Test 9: IR clear during approach before car confirmation
  // -------------------------------------------------------------
  await itAsync('9. IR clear during approach before car confirmation', async () => {
    const { gate, cameraActions } = createTestWorkflow({ approachClearDelayMs: 40 });
    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_APPROACHING);

    // Sensor stably cleared
    gate.handleObstacleStateChange(false);
    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(gate.automationState, AutomationState.IDLE, 'Must return to IDLE after stable clear');
    assert.strictEqual(cameraActions.filter(a => a.action === 'STOP').length, 1, 'Camera STOP invoked');
    assert.strictEqual(gate.eventLatched, false, 'Event latch is released');
  });

  // -------------------------------------------------------------
  // Test 10: Stable IR clearance
  // -------------------------------------------------------------
  await itAsync('10. Stable IR clearance', async () => {
    const { gate, ai, cameraActions } = createTestWorkflow({ clearanceDelayMs: 40 });
    gate.handleObstacleStateChange(true);
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    await gate.handleCarConfirmed(ai.evaluateDetection(car));
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);

    // Sensor clears and remains stably clear
    gate.handleObstacleStateChange(false);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_CLEARING);

    await new Promise(r => setTimeout(r, 70));

    assert.strictEqual(gate.automationState, AutomationState.IDLE, 'Workflow completes to IDLE');
    assert.strictEqual(gate.adapter.simulatedAngle, 0, 'Gate physically closed');
    assert.ok(cameraActions.some(a => a.action === 'STOP'), 'Camera turned OFF upon completion');
  });

  // -------------------------------------------------------------
  // Test 11: IR re-detection during clearance
  // -------------------------------------------------------------
  await itAsync('11. IR re-detection during clearance', async () => {
    const { gate, ai } = createTestWorkflow({ clearanceDelayMs: 50 });
    gate.handleObstacleStateChange(true);
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    await gate.handleCarConfirmed(ai.evaluateDetection(car));

    // Clear then re-detect during clearance countdown
    gate.handleObstacleStateChange(false);
    assert.strictEqual(gate.automationState, AutomationState.VEHICLE_CLEARING);
    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);

    // Wait past the clearance delay
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(gate.automationState, AutomationState.GATE_OPEN);
    assert.strictEqual(gate.adapter.simulatedAngle, 90, 'Gate must not close');
  });

  // -------------------------------------------------------------
  // Test 12: CLOSE attempt while IR is blocked
  // -------------------------------------------------------------
  await itAsync('12. CLOSE attempt while IR is blocked', async () => {
    const { gate } = createTestWorkflow();
    gate.adapter.simulatedAngle = 90;
    gate.isObstacleDetected = true;

    let threw = false;
    try {
      await gate.requestCloseGate('MANUAL');
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Obstacle detected'));
    }

    assert.strictEqual(threw, true, 'CLOSE must throw rejection when IR is blocked');
    assert.strictEqual(gate.adapter.simulatedAngle, 90, 'Gate remains at 90 degrees');
  });

  // -------------------------------------------------------------
  // Test 13: CLOSE acknowledgment success
  // -------------------------------------------------------------
  await itAsync('13. CLOSE acknowledgment success', async () => {
    const { gate } = createTestWorkflow();
    gate.adapter.simulatedAngle = 90;
    gate.automationState = AutomationState.GATE_OPEN;
    gate.isObstacleDetected = false;

    const closed = await gate.requestCloseGate('MANUAL');
    assert.strictEqual(closed, true);
    assert.strictEqual(gate.adapter.simulatedAngle, 0);
    assert.strictEqual(gate.state, GateState.IDLE);
    assert.strictEqual(gate.lastCloseDiagnostics?.ackReceived, true);
  });

  // -------------------------------------------------------------
  // Test 14: CLOSE acknowledgment failure
  // -------------------------------------------------------------
  await itAsync('14. CLOSE acknowledgment failure', async () => {
    const { gate } = createTestWorkflow();
    gate.adapter.simulatedAngle = 90;
    gate.isObstacleDetected = false;
    gate.adapter.requestClose = async () => {
      throw new Error('Arduino timeout (3000ms) waiting for closure confirmation');
    };

    let threw = false;
    try {
      await gate.requestCloseGate('MANUAL');
    } catch (err) {
      threw = true;
    }

    assert.strictEqual(threw, true);
    assert.strictEqual(gate.state, GateState.ERROR);
    assert.strictEqual(gate.adapter.simulatedAngle, 90, 'Gate physically remains open');
    assert.strictEqual(gate.lastCloseDiagnostics?.timeoutOccurred, true);
  });

  // -------------------------------------------------------------
  // Test 15: Workflow recovery after OPEN failure
  // -------------------------------------------------------------
  await itAsync('15. Workflow recovery after OPEN failure', async () => {
    const { gate, ai } = createTestWorkflow();
    gate.adapter.requestOpen = async () => {
      throw new Error('Serial transmission failed');
    };

    gate.handleObstacleStateChange(true);
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    const confirmed = ai.evaluateDetection(car);

    const opened = await gate.handleCarConfirmed(confirmed);
    assert.strictEqual(opened, false);
    assert.strictEqual(gate.automationState, AutomationState.ERROR);
    assert.strictEqual(gate.adapter.simulatedAngle, 0, 'Gate remains closed');

    // Confirm that an obstacle detection while in ERROR with closed barrier does NOT falsely jump to GATE_OPEN
    gate.handleObstacleStateChange(true);
    assert.strictEqual(gate.automationState, AutomationState.ERROR, 'Must not falsely transition to GATE_OPEN');

    // Recovery
    gate.setMode(ControllerMode.MOCK);
    assert.strictEqual(gate.automationState, AutomationState.IDLE);
    assert.strictEqual(gate.eventLatched, false);
  });

  // -------------------------------------------------------------
  // Test 16: Workflow recovery after CLOSE failure
  // -------------------------------------------------------------
  await itAsync('16. Workflow recovery after CLOSE failure', async () => {
    const { gate } = createTestWorkflow();
    gate.adapter.simulatedAngle = 90;
    gate.state = GateState.HARDWARE_CONFIRMED;
    gate.automationState = AutomationState.ERROR;

    // Retry rejected when obstacle present
    gate.isObstacleDetected = true;
    let rejected = false;
    try {
      await gate.retryClearanceClosure();
    } catch (err) {
      rejected = true;
      assert.ok(err.message.includes('hazard in gate area'));
    }
    assert.strictEqual(rejected, true);

    // Obstacle clears -> retry succeeds
    gate.isObstacleDetected = false;
    const recovered = await gate.retryClearanceClosure();
    assert.strictEqual(recovered, true);
    assert.strictEqual(gate.automationState, AutomationState.IDLE);
    assert.strictEqual(gate.adapter.simulatedAngle, 0);
  });

  // -------------------------------------------------------------
  // Test 17: Camera activation and deactivation without duplicate calls
  // -------------------------------------------------------------
  await itAsync('17. Camera activation and deactivation without duplicate calls', async () => {
    const { gate, ai, cameraActions } = createTestWorkflow({ clearanceDelayMs: 40 });

    // Approach event
    gate.handleObstacleStateChange(true);
    gate.handleObstacleStateChange(true); // Redundant poll
    assert.strictEqual(cameraActions.filter(a => a.action === 'START').length, 1, 'Only one START action');

    // Confirm car & open gate
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    await gate.handleCarConfirmed(ai.evaluateDetection(car));

    // Complete clearance
    gate.handleObstacleStateChange(false);
    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(cameraActions.filter(a => a.action === 'STOP').length, 1, 'Only one STOP action');
  });

  // -------------------------------------------------------------
  // Test 18: No duplicate gate commands from repeated AI confirmation events
  // -------------------------------------------------------------
  await itAsync('18. No duplicate gate commands from repeated AI confirmation events', async () => {
    const { gate, ai } = createTestWorkflow();
    let openCount = 0;
    const origRequestOpen = gate.adapter.requestOpen.bind(gate.adapter);
    gate.adapter.requestOpen = async (meta, cb) => {
      openCount++;
      return await origRequestOpen(meta, cb);
    };

    gate.handleObstacleStateChange(true);
    const car = [{ class: 'car', score: 0.90, bbox: [0, 0, 50, 50] }];
    ai.evaluateDetection(car);
    ai.evaluateDetection(car);
    const confirmed = ai.evaluateDetection(car);

    // Simultaneous / repeated confirmation events
    const results = await Promise.all([
      gate.handleCarConfirmed(confirmed),
      gate.handleCarConfirmed(confirmed),
      gate.handleCarConfirmed(confirmed),
      gate.handleCarConfirmed(confirmed)
    ]);

    assert.strictEqual(openCount, 1, 'Exactly one OPEN transmitted');
    assert.strictEqual(results[0], true);
    assert.strictEqual(results[1], false);
    assert.strictEqual(results[2], false);
    assert.strictEqual(results[3], false);
  });

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`IR-First Workflow Test Results: ${passCount} Passed, ${failCount} Failed`);
  console.log('================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
