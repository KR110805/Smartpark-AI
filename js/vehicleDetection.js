/**
 * SMARTPARK AI - Vehicle Detection Module
 * js/vehicleDetection.js
 * 
 * Implements browser-based AI object detection using TensorFlow.js and COCO-SSD.
 * Enforces strict car detection policy:
 * - ONLY 'car' triggers the gate.
 * - Non-car objects ('person', 'bicycle', 'motorcycle', 'bus', 'truck') are rejected.
 * - Configurable confidence threshold (default 80%).
 * - Configurable consecutive detection confirmation (default 3 cycles).
 * - Guard flag preventing overlapping inference cycles.
 */

class VehicleDetection {
  constructor(config = null) {
    this.config = config || (typeof CONFIG !== 'undefined' ? CONFIG : {
      CAR_CONFIDENCE_THRESHOLD: 0.80,
      REQUIRED_CONSECUTIVE_DETECTIONS: 3,
      DETECTION_INTERVAL_MS: 400,
      TARGET_CLASS: 'car',
      REJECTED_CLASSES: ['person', 'bicycle', 'motorcycle', 'bus', 'truck'],
      MODEL_NAME: 'lite_mobilenet_v2',
      LOCAL_MODEL_URL: '/assets/model/model.json'
    });

    this.model = null;
    this.isModelLoading = false;
    this.isModelReady = false;
    this.modelLoadError = null;

    // Inference scheduling state
    this.isContinuousDetecting = false;
    this.detectionTimer = null;
    this.isInferencing = false; // Guard flag against overlapping predictions

    // Confirmation tracking
    this.consecutiveCarDetections = 0;
    this.lastDetectionTimestamp = null;
    this.lastEvaluation = null;
  }

  /**
   * Load the COCO-SSD model once. Reuses model if already loaded.
   * Tries local offline assets first, then falls back to remote CDN if needed.
   */
  /**
   * Load the COCO-SSD model once. Reuses model if already loaded.
   * Tries local offline assets first, then falls back to remote CDN if needed.
   */
  async loadModel(onProgress = null) {
    if (this.model) {
      if (onProgress) onProgress({ status: 'ready', progress: 100 });
      return this.model;
    }

    if (this.modelLoadingPromise) {
      return this.modelLoadingPromise;
    }

    this.isModelLoading = true;
    this.modelLoadError = null;

    if (typeof cocoSsd === 'undefined') {
      const err = new Error('COCO-SSD library is not loaded in browser context.');
      this.modelLoadError = err;
      this.isModelLoading = false;
      throw err;
    }

    this.modelLoadingPromise = (async () => {
      try {
        console.log('[VehicleDetection] Model loading started...');
        if (onProgress) onProgress({ status: 'loading', message: 'Loading model weights...', progress: 30 });

        // Attempt 1: Try local offline model assets
        try {
          if (this.config.LOCAL_MODEL_URL) {
            this.model = await cocoSsd.load({
              base: this.config.MODEL_NAME,
              modelUrl: this.config.LOCAL_MODEL_URL
            });
            console.log('[VehicleDetection] Model loading completed successfully from local assets:', this.config.LOCAL_MODEL_URL);
          }
        } catch (localErr) {
          console.warn('[VehicleDetection] Failed to load local model, falling back to remote CDN:', localErr.message);
          if (this.config.FALLBACK_TO_REMOTE_MODEL) {
            if (onProgress) onProgress({ status: 'loading', message: 'Fetching fallback model...', progress: 60 });
            this.model = await cocoSsd.load({ base: this.config.MODEL_NAME });
            console.log('[VehicleDetection] Model loading completed successfully from remote fallback.');
          } else {
            throw localErr;
          }
        }

        if (!this.model) {
          // Fallback default
          this.model = await cocoSsd.load({ base: this.config.MODEL_NAME });
          console.log('[VehicleDetection] Model loading completed with default base:', this.config.MODEL_NAME);
        }

        this.isModelReady = true;
        this.isModelLoading = false;
        if (onProgress) onProgress({ status: 'ready', message: 'AI Model ready for inference', progress: 100 });
        return this.model;
      } catch (error) {
        this.isModelReady = false;
        this.isModelLoading = false;
        this.modelLoadError = error;
        console.error('[VehicleDetection] Model loading failed:', error);
        if (onProgress) onProgress({ status: 'error', error: error.message, progress: 0 });
        throw error;
      } finally {
        this.modelLoadingPromise = null;
      }
    })();

    return this.modelLoadingPromise;
  }

  /**
   * Raw detection on a video or image element.
   * Returns raw COCO-SSD prediction list, or null if frame is not ready.
   */
  async detectObjects(videoElement) {
    if (!this.isModelReady || !this.model) {
      throw new Error('Model is not loaded. Call loadModel() first.');
    }
    // Verify video stream readiness and non-zero dimensions
    if (
      !videoElement ||
      videoElement.readyState < 2 ||
      !videoElement.videoWidth ||
      !videoElement.videoHeight ||
      videoElement.paused ||
      videoElement.ended
    ) {
      return null; // Video frame not yet ready for inference
    }

    return await this.model.detect(videoElement);
  }

  /**
   * Evaluates detection results according to the Car Detection Policy.
   * Returns a structured decision object.
   */
  evaluateDetection(predictions) {
    const timestamp = Date.now();
    this.lastDetectionTimestamp = timestamp;

    if (!predictions || predictions.length === 0) {
      if (this.consecutiveCarDetections > 0) {
        console.log(`[VehicleDetection] No detections in frame. Consecutive count reset (was ${this.consecutiveCarDetections}).`);
      }
      this.consecutiveCarDetections = 0;
      const result = {
        isFrameReady: true,
        hasCar: false,
        qualifyingCar: null,
        topObject: null,
        consecutiveCount: 0,
        requiredCount: this.config.REQUIRED_CONSECUTIVE_DETECTIONS,
        isConfirmed: false,
        statusText: 'NO OBJECT DETECTED',
        allPredictions: [],
        timestamp
      };
      this.lastEvaluation = result;
      return result;
    }

    // Sort predictions by confidence descending
    const sorted = [...predictions].sort((a, b) => b.score - a.score);
    const topObject = sorted[0];

    // Diagnostic logging of raw predictions
    const summaryStr = sorted.map(p => `${p.class}(${Math.round(p.score * 100)}%)`).join(', ');
    console.log(`[VehicleDetection] Raw predictions (${sorted.length}): [${summaryStr}]`);

    // Find any qualifying car detection meeting threshold
    const qualifyingCars = sorted.filter(p => 
      p.class.toLowerCase() === this.config.TARGET_CLASS && 
      p.score >= this.config.CAR_CONFIDENCE_THRESHOLD
    );

    const qualifyingCar = qualifyingCars.length > 0 ? qualifyingCars[0] : null;

    if (qualifyingCar) {
      this.consecutiveCarDetections++;
      const isConfirmed = this.consecutiveCarDetections >= this.config.REQUIRED_CONSECUTIVE_DETECTIONS;
      const carScorePct = Math.round(qualifyingCar.score * 100);

      console.log(`[VehicleDetection] Car ACCEPTED: ${carScorePct}% >= ${Math.round(this.config.CAR_CONFIDENCE_THRESHOLD * 100)}% | Consecutive: ${this.consecutiveCarDetections}/${this.config.REQUIRED_CONSECUTIVE_DETECTIONS} | Confirmed: ${isConfirmed}`);

      const result = {
        isFrameReady: true,
        hasCar: true,
        qualifyingCar: {
          class: qualifyingCar.class,
          score: qualifyingCar.score,
          bbox: qualifyingCar.bbox,
          percentage: carScorePct
        },
        topObject: {
          class: topObject.class,
          score: topObject.score,
          percentage: Math.round(topObject.score * 100)
        },
        consecutiveCount: Math.min(this.consecutiveCarDetections, this.config.REQUIRED_CONSECUTIVE_DETECTIONS),
        requiredCount: this.config.REQUIRED_CONSECUTIVE_DETECTIONS,
        isConfirmed,
        statusText: isConfirmed ? 'CAR CONFIRMED' : `CAR DETECTING (${this.consecutiveCarDetections}/${this.config.REQUIRED_CONSECUTIVE_DETECTIONS})`,
        allPredictions: sorted,
        timestamp
      };
      this.lastEvaluation = result;
      return result;
    } else {
      // Car was not detected or confidence was below threshold
      if (this.consecutiveCarDetections > 0) {
        console.log(`[VehicleDetection] Non-car or low confidence. Consecutive count reset (was ${this.consecutiveCarDetections}).`);
      }
      this.consecutiveCarDetections = 0;

      let statusText = 'NO CAR DETECTED';
      let rejectReason = 'No car detected in frame';
      if (topObject) {
        const topPercent = Math.round(topObject.score * 100);
        if (topObject.class.toLowerCase() === this.config.TARGET_CLASS) {
          statusText = `CAR LOW CONFIDENCE (${topPercent}% < ${Math.round(this.config.CAR_CONFIDENCE_THRESHOLD * 100)}%)`;
          rejectReason = `Car confidence ${topPercent}% is below ${Math.round(this.config.CAR_CONFIDENCE_THRESHOLD * 100)}% threshold`;
        } else {
          statusText = `REJECTED: ${topObject.class.toUpperCase()} (${topPercent}%)`;
          rejectReason = `Object class "${topObject.class}" is rejected by vehicle policy (CAR ONLY)`;
        }
      }
      console.log(`[VehicleDetection] Detection REJECTED: ${rejectReason}`);

      const result = {
        isFrameReady: true,
        hasCar: false,
        qualifyingCar: null,
        topObject: {
          class: topObject.class,
          score: topObject.score,
          percentage: Math.round(topObject.score * 100)
        },
        consecutiveCount: 0,
        requiredCount: this.config.REQUIRED_CONSECUTIVE_DETECTIONS,
        isConfirmed: false,
        statusText,
        allPredictions: sorted,
        timestamp
      };
      this.lastEvaluation = result;
      return result;
    }
  }

  /**
   * Convenience function: detect cars and return evaluation.
   */
  async detectCars(videoElement) {
    const rawPredictions = await this.detectObjects(videoElement);
    if (rawPredictions === null) {
      return {
        isFrameReady: false,
        hasCar: false,
        qualifyingCar: null,
        topObject: null,
        consecutiveCount: this.consecutiveCarDetections,
        requiredCount: this.config.REQUIRED_CONSECUTIVE_DETECTIONS,
        isConfirmed: false,
        statusText: 'AWAITING CAMERA FRAME',
        allPredictions: [],
        timestamp: Date.now()
      };
    }
    return this.evaluateDetection(rawPredictions);
  }

  /**
   * Convenience boolean helper.
   */
  isCarDetected(predictions) {
    if (!predictions) return false;
    return predictions.some(p => 
      p.class.toLowerCase() === this.config.TARGET_CLASS && 
      p.score >= this.config.CAR_CONFIDENCE_THRESHOLD
    );
  }

  /**
   * Starts non-overlapping continuous detection loop.
   */
  startContinuousDetection(videoElement, onResult, onError = null) {
    if (this.isContinuousDetecting) return;
    this.isContinuousDetecting = true;
    this.consecutiveCarDetections = 0;
    console.log('[VehicleDetection] Inference loop started.');

    const cycle = async () => {
      if (!this.isContinuousDetecting) return;

      // Prevent overlapping predictions
      if (!this.isInferencing) {
        this.isInferencing = true;
        try {
          const evalResult = await this.detectCars(videoElement);
          if (onResult && this.isContinuousDetecting) {
            onResult(evalResult);
          }
        } catch (err) {
          console.error('[VehicleDetection] Inference error:', err);
          if (onError && this.isContinuousDetecting) {
            onError(err);
          }
        } finally {
          this.isInferencing = false;
        }
      }

      // Schedule next inference interval if still active
      if (this.isContinuousDetecting) {
        this.detectionTimer = setTimeout(cycle, this.config.DETECTION_INTERVAL_MS);
      }
    };

    cycle();
  }

  /**
   * Stops continuous detection loop.
   */
  stopContinuousDetection() {
    this.isContinuousDetecting = false;
    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer);
      this.detectionTimer = null;
    }
    this.isInferencing = false;
  }

  /**
   * Reset confirmation counter.
   */
  resetConfirmation() {
    this.consecutiveCarDetections = 0;
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
  }
}

// Export for ES modules and standard browser window scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VehicleDetection;
} else if (typeof window !== 'undefined') {
  window.VehicleDetection = VehicleDetection;
}
