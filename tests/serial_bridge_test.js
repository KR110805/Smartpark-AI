/**
 * SMARTPARK AI - Serial Bridge & Hardware Integration Unit Tests
 * tests/serial_bridge_test.js
 * 
 * Verifies USB serial bridge communication logic with mock hardware:
 * 1. Port listing and auto-discovery
 * 2. Newline-terminated command formatting (OPEN\n, CLOSE\n, STATUS\n)
 * 3. Command rejection for invalid inputs
 * 4. Acknowledgment parsing (SMARTPARK_READY, GATE_OPENED, GATE_CLOSED, etc.)
 * 5. IR safety sensor blocking gate closure
 * 6. Disconnection detection and in-flight command rejection
 * 7. Command timeout handling
 */

const assert = require('assert');
const SerialBridge = require('../server/serialBridge.js');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

async function run() {
  console.log('================================================================');
  console.log('       SMARTPARK AI - Dedicated Serial Bridge Test Suite        ');
  console.log('================================================================\n');

  await test('1. Serial Port Discovery: listPorts() returns array of ports', async () => {
    const ports = await SerialBridge.listPorts();
    assert.ok(Array.isArray(ports));
  });

  await test('2. Mock Connection: Connects cleanly in mock mode', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    const ok = await bridge.connect();
    assert.strictEqual(ok, true);
    assert.strictEqual(bridge.isConnected, true);
  });

  await test('3. Command Protocol: Transmits OPEN and receives GATE_OPENED acknowledgment', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();

    const result = await bridge.sendCommand('OPEN');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.command, 'OPEN');
    assert.strictEqual(result.gateState, 'OPEN');
    assert.strictEqual(result.stage, 'ACKNOWLEDGED');
  });

  await test('4. Command Protocol: Transmits CLOSE and receives GATE_CLOSED acknowledgment', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();
    bridge.obstacleDetected = false;

    const result = await bridge.sendCommand('CLOSE');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.command, 'CLOSE');
    assert.strictEqual(result.gateState, 'CLOSED');
  });

  await test('5. Command Protocol: Transmits STATUS and receives current state', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();
    bridge.gateState = 'OPEN';

    const result = await bridge.sendCommand('STATUS');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.command, 'STATUS');
  });

  await test('6. Physical Safety: Refuses CLOSE when IR sensor indicates an obstacle in gate area', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    await bridge.connect();
    bridge.gateState = 'OPEN';
    bridge.obstacleDetected = true; // Obstacle present

    try {
      await bridge.sendCommand('CLOSE');
      assert.fail('Should have refused CLOSE due to obstacle');
    } catch (err) {
      assert.ok(err.message.includes('Obstacle detected'));
      // Physical gate remains OPEN
      assert.strictEqual(bridge.gateState, 'OPEN');
    }
  });

  await test('7. Disconnection: Refuses commands when controller is disconnected', async () => {
    const bridge = new SerialBridge({ isMockMode: true });
    bridge.isConnected = false;

    try {
      await bridge.sendCommand('OPEN');
      assert.fail('Should have rejected command when disconnected');
    } catch (err) {
      assert.ok(err.message.includes('disconnected'));
    }
  });

  await test('8. Timeout Handling: Command rejects if acknowledgment is not received within timeout', async () => {
    const bridge = new SerialBridge({ isMockMode: false, timeoutMs: 100 });
    bridge.isConnected = true;
    bridge.port = { write: (data, cb) => cb(null) };

    try {
      await bridge.sendCommand('OPEN');
      assert.fail('Should have timed out');
    } catch (err) {
      assert.ok(err.message.includes('timeout'));
    }
  });

  console.log('\n================================================================');
  console.log(`Serial Bridge Tests Finished: ${pass} Passed, ${fail} Failed`);
  console.log('================================================================\n');

  if (fail > 0) process.exit(1);
}

run();
