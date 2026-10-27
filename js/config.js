/**
 * SMARTPARK AI - Centralized Configuration Module
 * js/config.js
 * 
 * Provides all runtime parameters for camera, AI inference, car policy,
 * and configurable controller abstraction.
 */

const CONFIG = {
  // --- Camera Settings ---
  CAMERA_FACING_MODE: 'environment', // Prefer rear-facing camera on mobile
  CAMERA_WIDTH: { ideal: 640 },      // Optimized for mobile inference performance
  CAMERA_HEIGHT: { ideal: 480 },
  CAMERA_FRAME_RATE: { ideal: 24, max: 30 },

  // --- AI Model & Inference ---
  MODEL_NAME: 'lite_mobilenet_v2',   // Fast, lightweight mobile architecture
  LOCAL_MODEL_URL: '/assets/model/model.json', // Local offline model path
  FALLBACK_TO_REMOTE_MODEL: true,    // Fallback if local asset is unavailable

  // --- Car Detection Policy ---
  // ONLY 'car' triggers the gate. Non-car objects are rejected.
  TARGET_CLASS: 'car',
  REJECTED_CLASSES: ['person', 'bicycle', 'motorcycle', 'bus', 'truck'],
  CAR_CONFIDENCE_THRESHOLD: 0.80,    // Configurable threshold: 80% (0.80)
  
  // --- Continuous Detection & Confirmation ---
  DETECTION_INTERVAL_MS: 400,        // 400ms between inference cycles
  REQUIRED_CONSECUTIVE_DETECTIONS: 3,// Require 3 consecutive qualifying car detections
  
  // --- Configurable Controller Abstraction ---
  // Default mode: 'MOCK' (Simulator) until physical hardware is selected by user
  // Supported modes: 'MOCK' | 'SERIAL' | 'EXISTING_HTTP_CONTROLLER'
  ACTIVE_CONTROLLER_MODE: 'MOCK',
  
  // Custom Endpoint Settings
  SERIAL_BRIDGE_URL: '/api/serial',  // Local Node.js USB Serial Bridge
  HTTP_CONTROLLER_URL: '',           // Existing HTTP controller endpoint
  HTTP_CONTROLLER_METHOD: 'POST',    // User-configurable method
  
  // Gate Safety & Timing
  AUTO_GATE_ENABLED: true,           // Automatic gate trigger on confirmed car
  COMMAND_DEBOUNCE_MS: 3000,         // Minimum gap between gate open requests (anti-bounce)
  CONTROLLER_TIMEOUT_MS: 4000,       // Communication timeout in ms

  // --- IR-First Camera & Automatic Gate Automation ---
  IR_FIRST_AUTOMATION: true,         // Camera activates only after IR obstacle detection
  CLEARANCE_DELAY_MS: 2000,          // Configurable vehicle clearance delay before closing (ms)
  IR_POLL_INTERVAL_MS: 300,          // Active polling interval for hardware IR telemetry (ms)
  APPROACH_CLEAR_DELAY_MS: 1000      // Debounce delay before aborting approach on IR clear (ms)
};

// Export for ES modules and standard browser window scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
} else if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
}
