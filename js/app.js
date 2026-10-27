/**
 * SMARTPARK AI - Application Controller & Dashboard Logic
 * js/app.js
 * 
 * Orchestrates camera stream, AI inference, car policy enforcement,
 * configurable gate controller abstraction, canvas rendering, and audit logging.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // --- DOM Elements ---
  const el = {
    // Status Pills
    statAutomation: document.getElementById('statAutomation'),
    statIrSensor: document.getElementById('statIrSensor'),
    statCamera: document.getElementById('statCamera'),
    statModel: document.getElementById('statModel'),
    statController: document.getElementById('statController'),
    statGate: document.getElementById('statGate'),

    // Automation Banner & Step Tracker
    badgeAutomationState: document.getElementById('badgeAutomationState'),
    automationHeadline: document.getElementById('automationHeadline'),
    automationDetail: document.getElementById('automationDetail'),
    stepIdle: document.getElementById('stepIdle'),
    stepApproaching: document.getElementById('stepApproaching'),
    stepVerifying: document.getElementById('stepVerifying'),
    stepGateOpen: document.getElementById('stepGateOpen'),
    stepClearing: document.getElementById('stepClearing'),
    btnSimulateObstacle: document.getElementById('btnSimulateObstacle'),
    btnSimulateClear: document.getElementById('btnSimulateClear'),

    // Camera
    video: document.getElementById('cameraVideo'),
    canvas: document.getElementById('detectionCanvas'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    btnStartCamera: document.getElementById('btnStartCamera'),
    btnStopCamera: document.getElementById('btnStopCamera'),
    btnStartDetection: document.getElementById('btnStartDetection'),
    btnStopDetection: document.getElementById('btnStopDetection'),
    btnCaptureFrame: document.getElementById('btnCaptureFrame'),

    // Detection
    hero: document.getElementById('detectionHero'),
    statusText: document.getElementById('detectedStatusText'),
    detailText: document.getElementById('detectedDetailText'),
    confirmationRatio: document.getElementById('confirmationRatio'),
    confirmationFill: document.getElementById('confirmationFill'),
    detailClass: document.getElementById('detailClass'),
    detailScore: document.getElementById('detailScore'),
    detailPolicy: document.getElementById('detailPolicy'),
    detailTime: document.getElementById('detailTime'),

    // Gate & Controller
    barrierArm: document.getElementById('barrierArm'),
    gateAngleText: document.getElementById('gateAngleText'),
    textAdapterName: document.getElementById('textAdapterName'),
    detailGateState: document.getElementById('detailGateState'),
    detailLastCommand: document.getElementById('detailLastCommand'),
    detailHwStatus: document.getElementById('detailHwStatus'),
    detailVehicleCount: document.getElementById('detailVehicleCount'),
    detailLatchStatus: document.getElementById('detailLatchStatus'),
    controllerModeBadge: document.getElementById('controllerModeBadge'),
    irSensorBadge: document.getElementById('irSensorBadge'),
    hwFeedbackNotice: document.getElementById('hwFeedbackNotice'),
    stage1Pill: document.getElementById('stage1Pill'),
    stage2Pill: document.getElementById('stage2Pill'),
    stage3Pill: document.getElementById('stage3Pill'),
    stage4Pill: document.getElementById('stage4Pill'),

    // Manual controls
    btnManualOpen: document.getElementById('btnManualOpen'),
    btnManualClose: document.getElementById('btnManualClose'),
    btnEmergencyStop: document.getElementById('btnEmergencyStop'),

    // Settings
    sliderThreshold: document.getElementById('sliderThreshold'),
    valThreshold: document.getElementById('valThreshold'),
    sliderConfirmations: document.getElementById('sliderConfirmations'),
    valConfirmations: document.getElementById('valConfirmations'),
    toggleAutoGate: document.getElementById('toggleAutoGate'),
    toggleIrFirst: document.getElementById('toggleIrFirst'),
    sliderClearanceDelay: document.getElementById('sliderClearanceDelay'),
    valClearanceDelay: document.getElementById('valClearanceDelay'),
    selectHardwareMode: document.getElementById('selectHardwareMode'),
    serialConfigRow: document.getElementById('serialConfigRow'),
    selectSerialPort: document.getElementById('selectSerialPort'),
    btnRefreshPorts: document.getElementById('btnRefreshPorts'),
    btnConnectSerial: document.getElementById('btnConnectSerial'),
    btnDisconnectSerial: document.getElementById('btnDisconnectSerial'),
    serialStatusNote: document.getElementById('serialStatusNote'),
    endpointConfigRow: document.getElementById('endpointConfigRow'),
    endpointLabel: document.getElementById('endpointLabel'),
    inputEndpointUrl: document.getElementById('inputEndpointUrl'),

    // Log
    logBox: document.getElementById('logBox'),
    btnClearLog: document.getElementById('btnClearLog')
  };

  const canvasCtx = el.canvas.getContext('2d');

  // --- Subsystem Instances ---
  const camera = new CameraManager(CONFIG);
  const ai = new VehicleDetection(CONFIG);
  const gate = new GateController(CONFIG);

  // --- Logger Utility ---
  function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    let color = '#a5b4fc';
    if (type === 'success') color = '#34d399';
    if (type === 'warn') color = '#fbbf24';
    if (type === 'error') color = '#f87171';

    entry.innerHTML = `<span class="log-time">[${time}]</span> <span style="color:${color};">${message}</span>`;
    el.logBox.appendChild(entry);
    el.logBox.scrollTop = el.logBox.scrollHeight;
  }

  log('System initialized. Default controller mode: MOCK SIMULATOR.', 'info');

  // --- Model Initialization ---
  async function initAIModel() {
    if (el.statModel) {
      el.statModel.textContent = 'LOADING';
      el.statModel.className = 'val status-loading';
    }
    try {
      log('Starting AI model loading (TensorFlow.js & COCO-SSD)...', 'info');
      await ai.loadModel((prog) => {
        if (prog.status === 'loading') {
          if (el.statModel) el.statModel.textContent = `LOADING (${prog.progress}%)`;
          log(prog.message || 'Loading AI weights...', 'info');
        } else if (prog.status === 'ready') {
          if (el.statModel) {
            el.statModel.textContent = 'READY';
            el.statModel.className = 'val status-ready';
          }
          log('TensorFlow.js & COCO-SSD loaded successfully.', 'success');
        }
      });

      // If camera stream was already activated, start continuous detection now
      if (camera.isActive && !ai.isContinuousDetecting) {
        log('Camera stream is active -> Launching continuous AI vehicle detection...', 'success');
        ai.startContinuousDetection(
          el.video,
          (result) => handleDetectionResult(result),
          (err) => log(`Inference warning: ${err.message}`, 'warn')
        );
        if (el.btnStartDetection) el.btnStartDetection.disabled = true;
        if (el.btnStopDetection) el.btnStopDetection.disabled = false;
      }
    } catch (err) {
      if (el.statModel) {
        el.statModel.textContent = 'ERROR';
        el.statModel.className = 'val status-error';
      }
      log(`AI Model failed to load: ${err.message}`, 'error');
    }
  }

  // --- Verification Pipeline Stage Updater ---
  function updateStagePills(currentStage) {
    const stages = ['stage1Pill', 'stage2Pill', 'stage3Pill', 'stage4Pill'];
    let activeLevel = 0;
    if (currentStage === 'OPEN_REQUESTED') activeLevel = 1;
    else if (currentStage === 'COMMAND_TRANSMITTED') activeLevel = 2;
    else if (currentStage === 'ACK_RECEIVED') activeLevel = 3;
    else if (currentStage === 'HARDWARE_CONFIRMED' || currentStage === 'OPEN') activeLevel = 4;
    else if (currentStage === 'IDLE' || currentStage === 'CLOSED') activeLevel = 0;

    stages.forEach((pillId, idx) => {
      const pill = el[pillId];
      if (!pill) return;
      if (idx + 1 <= activeLevel) {
        pill.style.background = 'rgba(6, 182, 212, 0.25)';
        pill.style.borderColor = '#06b6d4';
        pill.style.color = '#38bdf8';
        pill.style.fontWeight = '700';
      } else {
        pill.style.background = '#0f172a';
        pill.style.borderColor = 'var(--border-color)';
        pill.style.color = 'var(--text-muted)';
        pill.style.fontWeight = '400';
      }
    });
  }

  // --- IR-First Camera & Automation Lifecycle Handlers ---
  let isCameraStarting = false;
  let cameraDesiredState = 'STOPPED';

  async function handleCameraActionRequest(cameraReq) {
    if (cameraReq.action === 'START') {
      cameraDesiredState = 'RUNNING';
      if (camera.isActive || isCameraStarting) {
        return;
      }
      isCameraStarting = true;
      log('IR obstacle sensor triggered approach -> Starting camera for vehicle verification...', 'warn');
      if (el.automationHeadline) el.automationHeadline.textContent = 'Vehicle detected — Starting camera...';

      try {
        await camera.start(el.video, (status) => {
          if (status.state === 'CONNECTED') {
            el.statCamera.textContent = 'ON';
            el.statCamera.className = 'val status-ready';
            if (el.videoPlaceholder) el.videoPlaceholder.style.display = 'none';
            if (el.btnStopCamera) el.btnStopCamera.disabled = false;
            if (el.btnCaptureFrame) el.btnCaptureFrame.disabled = false;
            if (el.btnStartDetection) el.btnStartDetection.disabled = false;
            log('Camera stream connected.', 'success');
          } else if (status.state === 'ERROR') {
            el.statCamera.textContent = 'ERROR';
            el.statCamera.className = 'val status-error';
            if (el.btnStartCamera) el.btnStartCamera.disabled = false;
            log(`Camera stream error: ${status.message}`, 'error');
          } else {
            el.statCamera.textContent = 'OFF';
            el.statCamera.className = 'val status-stopped';
          }
        });

        // Check if desired state transitioned to STOPPED while camera was connecting
        if (cameraDesiredState === 'STOPPED') {
          log('Camera stream connected but desired state is STOPPED. Shutting down camera...', 'info');
          ai.stopContinuousDetection();
          camera.stop();
          if (el.videoPlaceholder) el.videoPlaceholder.style.display = 'block';
          el.statCamera.textContent = 'OFF';
          el.statCamera.className = 'val status-stopped';
          return;
        }

        // Ensure AI model is ready before launching detection
        if (!ai.isModelReady) {
          log('Awaiting AI model weights to finish loading...', 'info');
          await ai.loadModel();
        }

        // Automatically launch continuous detection loop once camera stream is live
        if (cameraDesiredState === 'RUNNING' && camera.isActive && !ai.isContinuousDetecting) {
          log('Camera stream is active -> Initializing continuous AI vehicle detection...', 'success');
          ai.startContinuousDetection(
            el.video,
            (result) => handleDetectionResult(result),
            (err) => log(`Inference warning: ${err.message}`, 'warn')
          );
          if (el.btnStartDetection) el.btnStartDetection.disabled = true;
          if (el.btnStopDetection) el.btnStopDetection.disabled = false;
        }
      } catch (err) {
        log(`Camera startup failure: ${err.message}. Gate remains CLOSED.`, 'error');
        gate.handleCameraStartupFailure(err);
      } finally {
        isCameraStarting = false;
      }
    } else if (cameraReq.action === 'STOP') {
      cameraDesiredState = 'STOPPED';
      if (!camera.isActive && !isCameraStarting) {
        return;
      }
      log('Vehicle clearance workflow completed. Stopping camera and AI detection...', 'info');
      ai.stopContinuousDetection();
      camera.stop();
      canvasCtx.clearRect(0, 0, el.canvas.width, el.canvas.height);
      if (el.videoPlaceholder) el.videoPlaceholder.style.display = 'block';
      el.statCamera.textContent = 'OFF';
      el.statCamera.className = 'val status-stopped';
      if (el.btnStartCamera) el.btnStartCamera.disabled = false;
      if (el.btnStopCamera) el.btnStopCamera.disabled = true;
      if (el.btnStartDetection) el.btnStartDetection.disabled = true;
      if (el.btnStopDetection) el.btnStopDetection.disabled = true;
      if (el.btnCaptureFrame) el.btnCaptureFrame.disabled = true;
    }
  }

  function handleAutomationStateUpdate(autoUpdate) {
    const state = autoUpdate.state;
    const msg = autoUpdate.message;
    const steps = ['stepIdle', 'stepApproaching', 'stepVerifying', 'stepGateOpen', 'stepClearing'];

    let label = 'Waiting for vehicle';
    let headline = 'Waiting for vehicle approach';
    let activeSteps = [0];

    if (state === 'IDLE') {
      label = 'Waiting for vehicle';
      headline = 'Waiting for vehicle approach';
      if (el.statAutomation) {
        el.statAutomation.textContent = 'IDLE';
        el.statAutomation.className = 'val status-idle';
      }
      activeSteps = [0];
    } else if (state === 'VEHICLE_APPROACHING') {
      label = 'Vehicle detected';
      headline = 'Vehicle approaching — Verifying car';
      if (el.statAutomation) {
        el.statAutomation.textContent = 'APPROACHING';
        el.statAutomation.className = 'val status-loading';
      }
      activeSteps = [0, 1, 2];
    } else if (state === 'CAR_CONFIRMED') {
      label = 'Gate opening';
      headline = 'Car confirmed — Gate opening';
      if (el.statAutomation) {
        el.statAutomation.textContent = 'OPENING';
        el.statAutomation.className = 'val status-opening';
      }
      activeSteps = [0, 1, 2, 3];
    } else if (state === 'GATE_OPEN') {
      label = 'Gate open';
      headline = 'Gate open — Vehicle transit active';
      if (el.statAutomation) {
        el.statAutomation.textContent = 'GATE OPEN';
        el.statAutomation.className = 'val status-open';
      }
      activeSteps = [3];
    } else if (state === 'VEHICLE_CLEARING') {
      label = 'Vehicle clearing';
      headline = `Vehicle clearing — Closing in ${(gate.clearanceDelayMs / 1000).toFixed(1)}s`;
      if (el.statAutomation) {
        el.statAutomation.textContent = 'CLEARING';
        el.statAutomation.className = 'val status-loading';
      }
      activeSteps = [3, 4];
    } else if (state === 'GATE_CLOSING') {
      label = 'Closing gate';
      headline = 'Gate closing';
      if (el.statAutomation) {
        el.statAutomation.textContent = 'CLOSING';
        el.statAutomation.className = 'val status-opening';
      }
      activeSteps = [4];
    } else if (state === 'ERROR') {
      label = 'Camera unavailable / Error';
      headline = 'Automation Error';
      if (el.statAutomation) {
        el.statAutomation.textContent = 'ERROR';
        el.statAutomation.className = 'val status-error';
      }
      activeSteps = [];
    }

    if (el.badgeAutomationState) el.badgeAutomationState.textContent = label;
    if (el.automationHeadline) el.automationHeadline.textContent = headline;
    if (el.automationDetail) el.automationDetail.textContent = msg || '';

    steps.forEach((stepId, idx) => {
      const stepEl = el[stepId];
      if (!stepEl) return;
      if (activeSteps.includes(idx)) {
        stepEl.style.background = 'rgba(6, 182, 212, 0.25)';
        stepEl.style.borderColor = '#06b6d4';
        stepEl.style.color = '#38bdf8';
        stepEl.style.fontWeight = '700';
      } else {
        stepEl.style.background = '#0f172a';
        stepEl.style.borderColor = 'var(--border-color)';
        stepEl.style.color = 'var(--text-muted)';
        stepEl.style.fontWeight = '400';
      }
    });

    log(`Workflow -> ${state}: ${msg}`, state === 'ERROR' ? 'error' : 'info');
  }

  // --- Gate Controller Initialization ---
  gate.init(
    (stateUpdate) => {
      // Gate State changed
      el.statGate.textContent = stateUpdate.state;
      el.detailGateState.textContent = stateUpdate.state;
      updateStagePills(stateUpdate.state);

      const st = stateUpdate.state.toLowerCase();
      if (st.includes('open') || st.includes('simulated') || st.includes('confirmed')) {
        el.statGate.className = 'val status-open';
      } else if (st.includes('requested') || st.includes('transmitted')) {
        el.statGate.className = 'val status-opening';
      } else if (st.includes('disconnect')) {
        el.statGate.className = 'val status-error';
        el.statController.textContent = 'DISCONNECTED';
        el.statController.className = 'val status-error';
      } else if (st.includes('error')) {
        el.statGate.className = 'val status-error';
      } else {
        el.statGate.className = 'val status-closed';
      }

      log(`Gate -> ${stateUpdate.state}: ${stateUpdate.message}`, st.includes('error') || st.includes('disconnect') ? 'error' : 'info');
    },
    (telemetry) => {
      // Telemetry updated
      el.textAdapterName.textContent = telemetry.adapterName;
      el.detailLastCommand.textContent = telemetry.lastCommandResult || telemetry.lastAck || 'None';
      if (el.detailVehicleCount) el.detailVehicleCount.textContent = telemetry.vehicleCount || 0;

      // Event Latch status
      if (el.detailLatchStatus) {
        el.detailLatchStatus.textContent = gate.eventLatched ? 'LATCHED (Car In View)' : 'READY';
        el.detailLatchStatus.style.color = gate.eventLatched ? '#f59e0b' : '#34d399';
      }

      // IR Safety Sensor display
      if (el.statIrSensor) {
        if (telemetry.obstacleDetected) {
          el.statIrSensor.textContent = 'DETECTED';
          el.statIrSensor.className = 'val status-loading';
        } else {
          el.statIrSensor.textContent = 'CLEAR';
          el.statIrSensor.className = 'val status-ready';
        }
      }

      if (el.irSensorBadge) {
        if (telemetry.obstacleDetected) {
          el.irSensorBadge.innerHTML = '<span style="color:#ef4444;">⚠️ BLOCKED (Hazard in Gate Area)</span>';
        } else {
          el.irSensorBadge.innerHTML = '<span style="color:#10b981;">● CLEAR (Safe to close)</span>';
        }
      }

      // Controller connection state handling
      if (telemetry.isSimulated) {
        el.statController.textContent = 'MOCK (SIM)';
        el.statController.className = 'val status-idle';
        el.detailHwStatus.textContent = 'Simulated Only';
        el.detailHwStatus.style.color = '#f59e0b';
        el.controllerModeBadge.textContent = 'MOCK MODE (SIMULATED)';
        if (el.hwFeedbackNotice) {
          el.hwFeedbackNotice.textContent = '⚠️ Note: Running in simulated mode. Switch to SERIAL for Arduino UNO.';
          el.hwFeedbackNotice.style.color = '#f59e0b';
        }
      } else if (telemetry.mode === 'SERIAL') {
        const connState = telemetry.connectionState || (telemetry.isConnected ? 'CONNECTED' : 'DISCONNECTED');
        if (connState === 'CONNECTING') {
          el.statController.textContent = 'CONNECTING';
          el.statController.className = 'val status-loading';
          el.detailHwStatus.textContent = 'Connecting to Arduino...';
          el.detailHwStatus.style.color = '#fbbf24';
          el.controllerModeBadge.textContent = 'CONNECTING TO ARDUINO...';
          if (el.hwFeedbackNotice) {
            el.hwFeedbackNotice.textContent = `Establishing connection to Arduino on ${telemetry.port || 'USB'}...`;
            el.hwFeedbackNotice.style.color = '#fbbf24';
          }
        } else if (connState === 'CONNECTED' || telemetry.isConnected) {
          el.statController.textContent = 'CONNECTED (UNO)';
          el.statController.className = 'val status-ready';
          el.detailHwStatus.textContent = 'Arduino UNO Connected';
          el.detailHwStatus.style.color = '#34d399';
          el.controllerModeBadge.textContent = `ARDUINO UNO (${telemetry.port || 'USB'})`;
          if (el.hwFeedbackNotice) {
            el.hwFeedbackNotice.textContent = `Hardware Active: ${telemetry.port || 'USB'} @ ${telemetry.baudRate || 9600} baud (Open-Loop Actuator Acknowledged)`;
            el.hwFeedbackNotice.style.color = '#38bdf8';
          }
          if (el.serialStatusNote && telemetry.port) {
            el.serialStatusNote.textContent = `Connected: ${telemetry.port} @ ${telemetry.baudRate || 9600} baud`;
          }
        } else if (connState === 'ERROR' || telemetry.lastError) {
          el.statController.textContent = 'ERROR';
          el.statController.className = 'val status-error';
          el.detailHwStatus.textContent = `Serial Error: ${telemetry.lastError || 'Port error'}`;
          el.detailHwStatus.style.color = '#ef4444';
          el.controllerModeBadge.textContent = 'ARDUINO ERROR';
          if (el.hwFeedbackNotice) {
            el.hwFeedbackNotice.textContent = `⚠️ Serial Error: ${telemetry.lastError || 'Check port or cable connection'}`;
            el.hwFeedbackNotice.style.color = '#ef4444';
          }
        } else {
          el.statController.textContent = 'DISCONNECTED';
          el.statController.className = 'val status-error';
          el.detailHwStatus.textContent = 'Arduino Disconnected';
          el.detailHwStatus.style.color = '#ef4444';
          el.controllerModeBadge.textContent = 'ARDUINO DISCONNECTED';
          if (el.hwFeedbackNotice) {
            el.hwFeedbackNotice.textContent = '⚠️ Arduino UNO Disconnected. Please plug in USB and click Connect.';
            el.hwFeedbackNotice.style.color = '#ef4444';
          }
        }
      } else {
        el.statController.textContent = 'HTTP';
        el.statController.className = telemetry.isConnected ? 'val status-ready' : 'val status-idle';
        el.detailHwStatus.textContent = 'HTTP Interface';
        el.detailHwStatus.style.color = '#38bdf8';
        el.controllerModeBadge.textContent = telemetry.adapterName.toUpperCase();
      }

      // Synchronize Gate State when no operation is currently in flight
      if (!gate.isOperationInProgress) {
        if (telemetry.mode === 'SERIAL') {
          const isGateOpen = telemetry.gateState === 'OPEN' || telemetry.gateAngle >= 45;
          if (isGateOpen) {
            el.statGate.textContent = 'OPEN (90°)';
            el.statGate.className = 'val status-open';
            el.detailGateState.textContent = 'OPEN [Open-Loop Actuator Acknowledged]';
            updateStagePills('OPEN');
          } else {
            el.statGate.textContent = 'CLOSED (0°)';
            el.statGate.className = 'val status-closed';
            el.detailGateState.textContent = 'CLOSED (0°)';
            updateStagePills('CLOSED');
          }
        } else if (telemetry.isSimulated) {
          if (telemetry.gateAngle >= 45) {
            el.statGate.textContent = 'SIMULATED OPEN';
            el.statGate.className = 'val status-open';
            el.detailGateState.textContent = 'SIMULATED OPEN (90°)';
            updateStagePills('OPEN');
          } else {
            el.statGate.textContent = 'CLOSED (0°)';
            el.statGate.className = 'val status-closed';
            el.detailGateState.textContent = 'CLOSED (0°)';
            updateStagePills('CLOSED');
          }
        }
      }

      // Barrier graphic rotation
      if (telemetry.gateAngle >= 45) {
        el.barrierArm.classList.add('open');
      } else {
        el.barrierArm.classList.remove('open');
      }
      el.gateAngleText.textContent = `${telemetry.gateAngle}° (${telemetry.gateAngle >= 45 ? 'Open' : 'Closed'})`;
    },
    handleAutomationStateUpdate,
    handleCameraActionRequest
  );

  // Background telemetry poller for SERIAL mode
  // Strictly performs GET /api/serial/status via getStatus(); never calls connect() or reopens ports
  setInterval(async () => {
    if (gate.activeMode === 'SERIAL') {
      const status = await gate.adapter.getStatus();
      if (status) {
        gate.handleObstacleStateChange(!!status.obstacleDetected);
      }
      await gate._emitTelemetry();
    }
  }, CONFIG.IR_POLL_INTERVAL_MS || 300);

  // --- Canvas Bounding Box Rendering ---
  function renderBoundingBoxes(evalResult) {
    el.canvas.width = el.video.videoWidth || 640;
    el.canvas.height = el.video.videoHeight || 480;
    canvasCtx.clearRect(0, 0, el.canvas.width, el.canvas.height);

    if (!evalResult || !evalResult.allPredictions) return;

    for (const p of evalResult.allPredictions) {
      const [x, y, width, height] = p.bbox;
      const isCar = p.class.toLowerCase() === CONFIG.TARGET_CLASS;
      const isQualified = isCar && p.score >= CONFIG.CAR_CONFIDENCE_THRESHOLD;

      canvasCtx.lineWidth = 3;
      if (isQualified) {
        canvasCtx.strokeStyle = '#10b981'; // Green (qualifying car)
        canvasCtx.fillStyle = 'rgba(16, 185, 129, 0.15)';
      } else if (isCar) {
        canvasCtx.strokeStyle = '#f59e0b'; // Amber (low confidence car)
        canvasCtx.fillStyle = 'rgba(245, 158, 11, 0.1)';
      } else {
        canvasCtx.strokeStyle = '#ef4444'; // Red (non-car object rejected)
        canvasCtx.fillStyle = 'rgba(239, 68, 68, 0.1)';
      }

      canvasCtx.fillRect(x, y, width, height);
      canvasCtx.strokeRect(x, y, width, height);

      // Label banner
      const percent = Math.round(p.score * 100);
      const tag = `${p.class.toUpperCase()} ${percent}% ${isQualified ? '✓ CAR' : '✗ REJECT'}`;
      canvasCtx.font = 'bold 14px sans-serif';
      const textWidth = canvasCtx.measureText(tag).width;

      canvasCtx.fillStyle = isQualified ? '#10b981' : (isCar ? '#f59e0b' : '#ef4444');
      canvasCtx.fillRect(x, Math.max(0, y - 22), textWidth + 10, 22);

      canvasCtx.fillStyle = '#ffffff';
      canvasCtx.fillText(tag, x + 5, Math.max(16, y - 6));
    }
  }

  // --- Detection Result Handler & Latch Timing Safety ---
  let consecutiveClearFrames = 0;
  const REQUIRED_CLEAR_FRAMES_TO_UNLATCH = 8; // Sustained absence (~2s) prevents unlatch on camera flicker

  function handleDetectionResult(evalResult) {
    if (!evalResult) return;

    if (evalResult.isFrameReady === false) {
      if (el.statusText) el.statusText.textContent = 'AWAITING CAMERA FRAME';
      return;
    }

    renderBoundingBoxes(evalResult);

    const timeStr = new Date(evalResult.timestamp).toLocaleTimeString();
    if (el.detailTime) el.detailTime.textContent = timeStr;

    // Update Confirmation Bar (3 Cycles)
    const req = evalResult.requiredCount;
    const cur = evalResult.consecutiveCount;
    if (el.confirmationRatio) el.confirmationRatio.textContent = `${cur} / ${req}`;
    const fillPercent = Math.min(100, Math.round((cur / req) * 100));
    if (el.confirmationFill) el.confirmationFill.style.width = `${fillPercent}%`;

    if (evalResult.hasCar && evalResult.qualifyingCar) {
      consecutiveClearFrames = 0; // Reset clear counter while vehicle is in view

      if (el.detailClass) el.detailClass.textContent = 'CAR';
      if (el.detailScore) {
        el.detailScore.textContent = `${evalResult.qualifyingCar.percentage}%`;
        el.detailScore.style.color = '#34d399';
      }

      if (evalResult.isConfirmed) {
        if (el.hero) el.hero.className = 'detection-hero confirmed';

        const isAlreadyLatched = gate.eventLatched || (gate.automationState !== AutomationState.VEHICLE_APPROACHING && gate.automationState !== AutomationState.IDLE);

        if (isAlreadyLatched) {
          if (el.statusText) {
            el.statusText.textContent = gate.eventLatched ? 'CAR VERIFIED (LATCHED)' : 'CAR VERIFIED (GATE ACTIVE)';
            el.statusText.style.color = '#10b981';
          }
          if (el.detailPolicy) {
            el.detailPolicy.textContent = 'GATE ACTIVE';
            el.detailPolicy.style.color = '#10b981';
          }
          if (el.detailText) {
            el.detailText.textContent = 'Vehicle verified. Gate operation already active for this vehicle approach (One-shot latched).';
          }
          // Visual monitoring remains active, but do not emit duplicate logs or gate trigger commands
        } else {
          if (el.statusText) {
            el.statusText.textContent = 'CAR CONFIRMED (3/3)';
            el.statusText.style.color = '#10b981';
          }
          if (el.detailPolicy) {
            el.detailPolicy.textContent = 'OPEN REQUESTED';
            el.detailPolicy.style.color = '#10b981';
          }
          if (el.detailText) {
            el.detailText.textContent = 'Car verified in 3/3 consecutive frames. Triggering one-shot gate open request.';
          }

          // Diagnostic log: Detection event emitted only once per vehicle approach
          log(`AI Car Confirmed (${evalResult.qualifyingCar.percentage}% in 3/3 frames) -> Triggering one-shot gate open...`, 'success');
          console.log('[App] One-shot confirmed car detection emitted to gateController:', evalResult.qualifyingCar);

          // Request Gate Open via Configured Controller Adapter (latched internally)
          gate.handleCarConfirmed(evalResult);
        }
      } else {
        if (el.hero) el.hero.className = 'detection-hero';
        if (el.statusText) {
          el.statusText.textContent = `CAR DETECTING (${cur}/${req})`;
          el.statusText.style.color = '#06b6d4';
        }
        if (el.detailPolicy) {
          el.detailPolicy.textContent = 'Confirming...';
          el.detailPolicy.style.color = '#06b6d4';
        }
        if (el.detailText) el.detailText.textContent = `Verifying car persistence (${cur} of ${req} frames meeting 80% threshold)...`;
      }
    } else {
      // Vehicle not in view in current frame:
      // Note: Do NOT reset vehicle event latch here. Latch is exclusively reset
      // by the gate controller when the vehicle clearance workflow has safely completed
      // and the system returns to IDLE.
      consecutiveClearFrames++;

      // Non-car or low confidence
      if (el.hero) el.hero.className = 'detection-hero';
      if (el.detailPolicy) {
        el.detailPolicy.textContent = 'LOCKED';
        el.detailPolicy.style.color = '#ef4444';
      }

      if (evalResult.topObject) {
        if (el.detailClass) el.detailClass.textContent = evalResult.topObject.class.toUpperCase();
        if (el.detailScore) el.detailScore.textContent = `${evalResult.topObject.percentage}%`;
        
        if (evalResult.topObject.class.toLowerCase() === CONFIG.TARGET_CLASS) {
          if (el.hero) el.hero.className = 'detection-hero rejected';
          if (el.statusText) {
            el.statusText.textContent = 'CAR (LOW CONFIDENCE)';
            el.statusText.style.color = '#f59e0b';
          }
          if (el.detailScore) el.detailScore.style.color = '#f59e0b';
          if (el.detailText) el.detailText.textContent = `Confidence ${evalResult.topObject.percentage}% is below ${Math.round(CONFIG.CAR_CONFIDENCE_THRESHOLD * 100)}% threshold.`;
        } else {
          if (el.hero) el.hero.className = 'detection-hero rejected';
          if (el.statusText) {
            el.statusText.textContent = `REJECTED: ${evalResult.topObject.class.toUpperCase()}`;
            el.statusText.style.color = '#ef4444';
          }
          if (el.detailScore) el.detailScore.style.color = '#ef4444';
          if (el.detailText) el.detailText.textContent = `Object is a ${evalResult.topObject.class}. Policy rejects non-car objects.`;
        }
      } else {
        if (el.statusText) {
          el.statusText.textContent = 'NO OBJECT DETECTED';
          el.statusText.style.color = '#94a3b8';
        }
        if (el.detailClass) el.detailClass.textContent = 'None';
        if (el.detailScore) {
          el.detailScore.textContent = '0%';
          el.detailScore.style.color = '#94a3b8';
        }
        if (el.detailText) el.detailText.textContent = 'Entrance is currently clear.';
      }
    }
  }

  // --- Camera UI Controls ---
  el.btnStartCamera.addEventListener('click', async () => {
    el.btnStartCamera.disabled = true;
    try {
      await camera.start(el.video, (status) => {
        el.statCamera.textContent = status.state;
        if (status.state === 'CONNECTED') {
          el.statCamera.className = 'val status-ready';
          el.videoPlaceholder.style.display = 'none';
          el.btnStopCamera.disabled = false;
          el.btnCaptureFrame.disabled = false;
          el.btnStartDetection.disabled = false;
          log('Camera stream connected successfully.', 'success');
        } else if (status.state === 'ERROR') {
          el.statCamera.className = 'val status-error';
          el.btnStartCamera.disabled = false;
          log(`Camera error: ${status.message}`, 'error');
        } else {
          el.statCamera.className = 'val status-stopped';
        }
      });
    } catch (err) {
      el.btnStartCamera.disabled = false;
      log(`Camera initialization failed: ${err.message}`, 'error');
    }
  });

  el.btnStopCamera.addEventListener('click', () => {
    ai.stopContinuousDetection();
    camera.stop();
    canvasCtx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    el.videoPlaceholder.style.display = 'block';
    el.btnStartCamera.disabled = false;
    el.btnStopCamera.disabled = true;
    el.btnStartDetection.disabled = true;
    el.btnStopDetection.disabled = true;
    el.btnCaptureFrame.disabled = true;
    el.statCamera.textContent = 'STOPPED';
    el.statCamera.className = 'val status-stopped';
    log('Camera stopped by user.', 'info');
  });

  // --- Detection Controls ---
  el.btnStartDetection.addEventListener('click', () => {
    if (!ai.isModelReady) {
      log('Please wait for AI model to finish loading.', 'warn');
      return;
    }
    el.btnStartDetection.disabled = true;
    el.btnStopDetection.disabled = false;
    log(`Continuous vehicle detection started (${CONFIG.DETECTION_INTERVAL_MS}ms cycle, threshold ${Math.round(CONFIG.CAR_CONFIDENCE_THRESHOLD * 100)}%).`, 'info');
    
    ai.startContinuousDetection(
      el.video,
      (result) => handleDetectionResult(result),
      (err) => log(`Inference warning: ${err.message}`, 'warn')
    );
  });

  el.btnStopDetection.addEventListener('click', () => {
    ai.stopContinuousDetection();
    el.btnStartDetection.disabled = false;
    el.btnStopDetection.disabled = true;
    canvasCtx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    el.statusText.textContent = 'DETECTION PAUSED';
    el.statusText.style.color = '#94a3b8';
    log('Continuous vehicle detection paused.', 'info');
  });

  // --- Snapshot Capture Button ---
  el.btnCaptureFrame.addEventListener('click', async () => {
    try {
      log('Capturing single snapshot frame for analysis...', 'info');
      const evalResult = await ai.detectCars(el.video);
      handleDetectionResult(evalResult);
      log(`Snapshot analysis: ${evalResult.statusText}`, 'info');
    } catch (e) {
      log(`Snapshot error: ${e.message}`, 'error');
    }
  });

  // --- Manual Override Buttons ---
  el.btnManualOpen.addEventListener('click', () => {
    log('Manual Gate Open command dispatched.', 'warn');
    gate.requestOpenGate('MANUAL_USER');
  });

  el.btnManualClose.addEventListener('click', async () => {
    log('Manual Gate Close requested. Hardware IR safety checks will be evaluated...', 'info');
    try {
      if (gate.automationState === AutomationState.ERROR) {
        log('Attempting safe retry of gate closure from ERROR state...', 'warn');
        await gate.retryClearanceClosure();
      } else {
        await gate.requestCloseGate('MANUAL_USER');
      }
    } catch (err) {
      log(`Close request failed: ${err.message}`, 'error');
    }
  });

  el.btnEmergencyStop.addEventListener('click', () => {
    log('EMERGENCY STOP BUTTON ENGAGED!', 'error');
    gate.emergencyStop();
  });

  // --- Serial Port Management (For Arduino UNO) ---
  async function refreshSerialPorts(preferredPort = null) {
    try {
      el.selectSerialPort.innerHTML = '<option value="">Scanning for Arduino UNO...</option>';
      const resp = await fetch('/api/serial/ports');
      const data = await resp.json();
      el.selectSerialPort.innerHTML = '';
      if (data.ports && data.ports.length > 0) {
        data.ports.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.path;
          opt.textContent = `${p.path} (${p.manufacturer || 'Serial'})${p.isArduino ? ' [ARDUINO UNO]' : ''}`;
          if (preferredPort && p.path === preferredPort) {
            opt.selected = true;
          } else if (!preferredPort && (p.isArduino || (p.path && p.path.includes('usbmodem')))) {
            opt.selected = true;
          }
          el.selectSerialPort.appendChild(opt);
        });
        el.serialStatusNote.textContent = `Found ${data.ports.length} port(s). Select Arduino UNO and click Connect.`;
      } else {
        el.selectSerialPort.innerHTML = '<option value="">No serial ports detected</option>';
        el.serialStatusNote.textContent = 'Please plug Arduino UNO USB cable into laptop.';
      }
    } catch (e) {
      el.serialStatusNote.textContent = `Port query error: ${e.message}`;
    }
  }

  el.btnRefreshPorts.addEventListener('click', () => refreshSerialPorts());

  el.btnConnectSerial.addEventListener('click', async () => {
    const chosenPort = el.selectSerialPort.value;
    if (!chosenPort) {
      log('Please select a valid serial port from the dropdown.', 'warn');
      return;
    }

    if (el.btnConnectSerial.disabled) {
      log('A serial connection request is already in progress.', 'warn');
      return;
    }

    // Check if already connected to this exact port to prevent duplicate attempts
    if (gate.activeMode === 'SERIAL') {
      const curStatus = await gate.adapter.getStatus();
      if (curStatus.isConnected && curStatus.port === chosenPort) {
        log(`Already connected to Arduino UNO on ${chosenPort} (9600 baud).`, 'info');
        el.serialStatusNote.textContent = `Connected: ${chosenPort} (9600 baud)`;
        await gate._emitTelemetry();
        return;
      }
    }

    log(`Connecting to Arduino on serial port: ${chosenPort}...`, 'info');
    el.btnConnectSerial.disabled = true;
    el.btnConnectSerial.textContent = 'Connecting...';
    el.statController.textContent = 'CONNECTING';
    el.statController.className = 'val status-loading';

    try {
      const resp = await fetch('/api/serial/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: chosenPort, baudRate: 9600 })
      });
      const data = await resp.json();
      if (data.success) {
        log(`Successfully connected to Arduino UNO on ${chosenPort} (9600 baud)!`, 'success');
        el.serialStatusNote.textContent = `Connected: ${chosenPort} (9600 baud)`;
        gate.setMode('SERIAL');
        await gate._emitTelemetry();
      } else {
        log(`Failed to connect to ${chosenPort}. Is the port open in another program?`, 'error');
        el.serialStatusNote.textContent = `Connection failed: ${data.status?.lastError || 'Check cable/port'}`;
        await gate._emitTelemetry();
      }
    } catch (err) {
      log(`Serial connection request error: ${err.message}`, 'error');
    } finally {
      el.btnConnectSerial.disabled = false;
      el.btnConnectSerial.textContent = 'Connect';
    }
  });

  if (el.btnDisconnectSerial) {
    el.btnDisconnectSerial.addEventListener('click', async () => {
      log('Disconnecting serial bridge to release USB port for Arduino IDE / Serial Monitor...', 'info');
      try {
        const resp = await fetch('/api/serial/disconnect', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
          log('Serial port released. You may now safely open Arduino Serial Monitor.', 'success');
          el.serialStatusNote.textContent = 'Disconnected. Port released for Arduino IDE / Serial Monitor.';
          await gate._emitTelemetry();
        } else {
          log(`Disconnect failed: ${data.error || 'Unknown'}`, 'error');
        }
      } catch (err) {
        log(`Disconnect request error: ${err.message}`, 'error');
      }
    });
  }

  // --- Settings Tuning Controls ---
  el.sliderThreshold.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    CONFIG.CAR_CONFIDENCE_THRESHOLD = val / 100;
    ai.updateConfig({ CAR_CONFIDENCE_THRESHOLD: CONFIG.CAR_CONFIDENCE_THRESHOLD });
    el.valThreshold.textContent = `${val}%`;
    log(`Car confidence threshold adjusted to ${val}%.`, 'info');
  });

  el.sliderConfirmations.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    CONFIG.REQUIRED_CONSECUTIVE_DETECTIONS = val;
    ai.updateConfig({ REQUIRED_CONSECUTIVE_DETECTIONS: val });
    el.valConfirmations.textContent = `${val}`;
    log(`Required consecutive confirmations set to ${val}.`, 'info');
  });

  el.toggleAutoGate.addEventListener('change', (e) => {
    CONFIG.AUTO_GATE_ENABLED = e.target.checked;
    log(`Automatic gate opening ${CONFIG.AUTO_GATE_ENABLED ? 'ENABLED' : 'DISABLED'}.`, 'warn');
  });

  if (el.toggleIrFirst) {
    el.toggleIrFirst.addEventListener('change', (e) => {
      CONFIG.IR_FIRST_AUTOMATION = e.target.checked;
      gate.config.IR_FIRST_AUTOMATION = e.target.checked;
      log(`IR-First Automation workflow ${CONFIG.IR_FIRST_AUTOMATION ? 'ENABLED' : 'DISABLED'}.`, 'warn');
    });
  }

  if (el.sliderClearanceDelay) {
    el.sliderClearanceDelay.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      CONFIG.CLEARANCE_DELAY_MS = val;
      gate.clearanceDelayMs = val;
      el.valClearanceDelay.textContent = `${(val / 1000).toFixed(1)}s`;
      log(`Clearance delay set to ${val}ms (${(val / 1000).toFixed(1)}s).`, 'info');
    });
  }

  // --- IR Simulation Buttons (Interactive Testing) ---
  if (el.btnSimulateObstacle) {
    el.btnSimulateObstacle.addEventListener('click', async () => {
      log('Simulating vehicle approach: IR obstacle detected.', 'warn');
      if (gate.activeMode === 'SERIAL') {
        try {
          await fetch('/api/serial/mock-obstacle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ obstacle: true })
          });
        } catch (e) {
          console.warn('[SimulateObstacle] Bridge error:', e.message);
        }
      }
      gate.handleObstacleStateChange(true);
      await gate._emitTelemetry();
    });
  }

  if (el.btnSimulateClear) {
    el.btnSimulateClear.addEventListener('click', async () => {
      log('Simulating vehicle passage: IR sensor cleared.', 'info');
      if (gate.activeMode === 'SERIAL') {
        try {
          await fetch('/api/serial/mock-obstacle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ obstacle: false })
          });
        } catch (e) {
          console.warn('[SimulateClear] Bridge error:', e.message);
        }
      }
      gate.handleObstacleStateChange(false);
      await gate._emitTelemetry();
    });
  }

  // --- Controller Mode Switching ---
  el.selectHardwareMode.addEventListener('change', async (e) => {
    const mode = e.target.value;
    gate.setMode(mode);

    if (mode === 'SERIAL') {
      el.serialConfigRow.style.display = 'block';
      el.endpointConfigRow.style.display = 'none';
      const cur = await gate.adapter.getStatus();
      await refreshSerialPorts(cur.port);
      await gate._emitTelemetry();
      log('Controller mode set to SERIAL: Arduino UNO R3 over USB.', 'info');
    } else if (mode === 'EXISTING_HTTP_CONTROLLER') {
      el.serialConfigRow.style.display = 'none';
      el.endpointConfigRow.style.display = 'block';
      el.endpointLabel.textContent = 'Existing HTTP Controller URL:';
      el.inputEndpointUrl.placeholder = 'e.g. http://192.168.1.100/gate/open';
      el.inputEndpointUrl.value = CONFIG.HTTP_CONTROLLER_URL || '';
      await gate._emitTelemetry();
      log('Controller mode set to EXISTING_HTTP_CONTROLLER.', 'info');
    } else {
      el.serialConfigRow.style.display = 'none';
      el.endpointConfigRow.style.display = 'none';
      await gate._emitTelemetry();
      log('Controller mode set to MOCK SIMULATOR (Default).', 'info');
    }
  });

  el.inputEndpointUrl.addEventListener('change', (e) => {
    const url = e.target.value.trim();
    if (gate.activeMode === 'EXISTING_HTTP_CONTROLLER') {
      CONFIG.HTTP_CONTROLLER_URL = url;
      gate.adapters['EXISTING_HTTP_CONTROLLER'].setUrl(url);
      log(`Configured HTTP Controller URL: ${url}`, 'info');
    }
  });

  el.btnClearLog.addEventListener('click', () => {
    el.logBox.innerHTML = '';
  });

  // Synchronize with authoritative backend serial status on page load
  async function syncBackendStatusOnStartup() {
    try {
      const resp = await fetch('/api/serial/status');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.connected) {
        log(`Discovered active Arduino connection on ${data.port} (${data.baudRate || 9600} baud).`, 'info');
        el.selectHardwareMode.value = 'SERIAL';
        el.serialConfigRow.style.display = 'block';
        el.endpointConfigRow.style.display = 'none';
        gate.setMode('SERIAL');
        await refreshSerialPorts(data.port);
        await gate._emitTelemetry();
      } else {
        await gate._emitTelemetry();
      }
    } catch (e) {
      await gate._emitTelemetry();
    }
  }

  // Kick off initial AI model download/loading & backend sync
  initAIModel();
  syncBackendStatusOnStartup();
});
