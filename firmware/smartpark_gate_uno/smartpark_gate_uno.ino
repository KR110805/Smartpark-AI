/**
 * SMARTPARK AI - Arduino UNO R3 Parking Gate Firmware
 * firmware/smartpark_gate_uno/smartpark_gate_uno.ino
 * 
 * Hardware Target:
 * - Microcontroller: Arduino UNO R3 (ATmega328P)
 * - Actuator: SG90 Micro Servo (PWM Control)
 * - Safety Sensor: Active IR Obstacle Avoidance Sensor (FC-51 / TCRT5000)
 * - Interface: USB Serial (Baud Rate 9600)
 * 
 * Safety & Hardware Principles:
 * 1. Physical safety is strictly governed by the Arduino and IR sensor, NOT the AI.
 * 2. If the IR sensor detects an object in the gate zone, the barrier NEVER closes.
 * 3. Commands are newline-terminated (e.g. "OPEN\n", "CLOSE\n", "STATUS\n").
 * 4. Every command returns an explicit acknowledgment.
 * 5. Servo positions:
 *    - 0°  = CLOSED (Barrier horizontal)
 *    - 90° = OPEN   (Barrier raised vertical)
 * 6. Avoids unnecessary repeated servo writes.
 * 7. Configurable IR sensor polarity (Active LOW by default for standard IR modules).
 */

#include <Servo.h>

// =================================================================
// Hardware Pin Configuration
// =================================================================
// CRITICAL HARDWARE WIRING AUDIT NOTE:
// In obstacle_detection_system_hc_sr041.ino, Digital Pin 9 was assigned to HC-SR04 'trigPin'.
// If your breadboard still has HC-SR04 wired to Pin 9, DO NOT connect SG90 to Pin 9 simultaneously!
// - Standard IR Configuration: Connect SG90 PWM to Pin 9, IR Sensor OUT to Pin 2.
// - If keeping HC-SR04: Reassign SERVO_PIN below to Pin 10.
const int SERVO_PIN = 9;        // SG90 Orange/Yellow PWM wire connected to Pin 9 (or 10 if HC-SR04 is kept)
const int IR_SENSOR_PIN = 2;    // IR Obstacle Sensor OUT connected to Digital Pin 2
const int LED_STATUS_PIN = 13;  // Onboard Arduino LED for visual status

// Optional Ultrasonic Support (from obstacle_detection_system_hc_sr041.ino)
// Set USE_ULTRASONIC to true if you are using HC-SR04 instead of an IR sensor:
const bool USE_ULTRASONIC = false;
const int TRIG_PIN = 9;                      // HC-SR04 Trig Pin from original sketch
const int ECHO_PIN = 8;                      // HC-SR04 Echo Pin from original sketch
const float ULTRASONIC_THRESHOLD_CM = 50.0;  // Distance threshold from original sketch

// =================================================================
// Configuration Parameters & Polarity
// =================================================================
// Most IR obstacle avoidance modules (e.g. FC-51) output LOW when an obstacle
// is detected (reflected light received) and HIGH when the beam is clear.
// Set to 'true' for Active-LOW sensors, or 'false' if your sensor is Active-HIGH.
const bool IR_ACTIVE_LOW = true;

// Barrier Angle Configurations
const int ANGLE_CLOSED = 0;  // Degrees for fully lowered/closed barrier
const int ANGLE_OPEN = 90;   // Degrees for raised/opened barrier

// Servo instances and tracking
Servo gateServo;
int currentAngle = ANGLE_CLOSED;
bool isGateOpen = false;

// IR sensor state tracking
bool lastObstacleState = false;
unsigned long lastSensorPollTime = 0;
const unsigned long SENSOR_POLL_INTERVAL_MS = 50;

// Serial command buffer
String inputBuffer = "";
const int MAX_BUFFER_LENGTH = 64;

// =================================================================
// Helper Functions
// =================================================================

/**
 * Read the physical obstacle sensor and determine if an obstacle is present.
 * Supports both Active IR sensors and HC-SR04 ultrasonic sensors from obstacle_detection_system_hc_sr041.ino.
 */
bool isObstacleDetected() {
  if (USE_ULTRASONIC) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);
    long duration = pulseIn(ECHO_PIN, HIGH, 30000);  // 30ms timeout prevents blocking
    if (duration == 0) return false;
    float distance = (duration * 0.0343) / 2.0;
    return (distance < ULTRASONIC_THRESHOLD_CM);
  }

  // Standard Digital IR Sensor
  int rawPinVal = digitalRead(IR_SENSOR_PIN);
  if (IR_ACTIVE_LOW) {
    return (rawPinVal == LOW);
  } else {
    return (rawPinVal == HIGH);
  }
}

/**
 * Move the servo smoothly to a target angle.
 * Prevents redundant writes if already at that position.
 */
void setGateAngle(int targetAngle) {
  if (currentAngle == targetAngle) {
    return;  // Already in position
  }

  // Smooth step progression to prevent servo gear stripping
  int step = (targetAngle > currentAngle) ? 2 : -2;
  while (abs(targetAngle - currentAngle) > 2) {
    currentAngle += step;
    gateServo.write(currentAngle);
    delay(15);
  }
  currentAngle = targetAngle;
  gateServo.write(currentAngle);
}

// =================================================================
// Arduino Setup Routine
// =================================================================
void setup() {
  // Initialize Serial interface
  Serial.begin(9600);
  inputBuffer.reserve(MAX_BUFFER_LENGTH);

  // Configure status LED
  pinMode(LED_STATUS_PIN, OUTPUT);
  digitalWrite(LED_STATUS_PIN, LOW);

  // Configure sensor pins
  if (USE_ULTRASONIC) {
    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
  } else {
    // Configure IR sensor with internal pullup for active-low open-collector outputs
    pinMode(IR_SENSOR_PIN, IR_ACTIVE_LOW ? INPUT_PULLUP : INPUT);
  }

  // Initialize SG90 Servo to closed position (0°)
  gateServo.attach(SERVO_PIN);
  setGateAngle(ANGLE_CLOSED);
  isGateOpen = false;

  delay(300);  // Allow servo to stabilize mechanically

  // Initial read of obstacle sensor
  lastObstacleState = isObstacleDetected();

  // Announce readiness to Node.js serial bridge
  Serial.println("SMARTPARK_READY");
}

// =================================================================
// Command Processing
// =================================================================
void processCommand(String command) {
  command.trim();
  command.toUpperCase();

  if (command.length() == 0) return;

  // --- COMMAND: OPEN ---
  if (command == "OPEN") {
    // Open gate regardless of IR sensor (opening is always safe from gate pinch)
    digitalWrite(LED_STATUS_PIN, HIGH);
    setGateAngle(ANGLE_OPEN);
    isGateOpen = true;
    Serial.println("GATE_OPENED");
    return;
  }

  // --- COMMAND: CLOSE ---
  if (command == "CLOSE") {
    // CRITICAL PHYSICAL SAFETY CHECK:
    // Check IR sensor. If an obstacle / vehicle is present, DO NOT close!
    if (isObstacleDetected()) {
      Serial.println("OBSTACLE_DETECTED");
      Serial.println("STATUS:OPEN");  // Confirm barrier remains OPEN for safety
      return;
    }

    // Path is clear; safe to close barrier
    digitalWrite(LED_STATUS_PIN, LOW);
    setGateAngle(ANGLE_CLOSED);
    isGateOpen = false;
    Serial.println("GATE_CLOSED");
    return;
  }

  // --- COMMAND: STATUS ---
  if (command == "STATUS") {
    if (isGateOpen) {
      Serial.println("STATUS:OPEN");
    } else {
      Serial.println("STATUS:CLOSED");
    }

    if (isObstacleDetected()) {
      Serial.println("OBSTACLE:DETECTED");
    } else {
      Serial.println("OBSTACLE:CLEAR");
    }
    return;
  }

  // --- UNKNOWN COMMAND ---
  Serial.print("ERROR:UNKNOWN_COMMAND:");
  Serial.println(command);
}

// =================================================================
// Main Execution Loop
// =================================================================
void loop() {
  unsigned long now = millis();

  // 1. Periodically check IR safety sensor and emit telemetry changes
  if (now - lastSensorPollTime >= SENSOR_POLL_INTERVAL_MS) {
    lastSensorPollTime = now;
    bool currentObstacle = isObstacleDetected();

    if (currentObstacle != lastObstacleState) {
      lastObstacleState = currentObstacle;
      if (currentObstacle) {
        Serial.println("OBSTACLE:DETECTED");
      } else {
        Serial.println("OBSTACLE:CLEAR");
      }
    }
  }

  // 2. Read incoming serial commands from Node.js
  while (Serial.available() > 0) {
    char inChar = (char)Serial.read();

    if (inChar == '\n' || inChar == '\r') {
      if (inputBuffer.length() > 0) {
        processCommand(inputBuffer);
        inputBuffer = "";
      }
    } else {
      if (inputBuffer.length() < MAX_BUFFER_LENGTH) {
        inputBuffer += inChar;
      } else {
        // Buffer overflow protection
        inputBuffer = "";
        Serial.println("ERROR:BUFFER_OVERFLOW");
      }
    }
  }
}
