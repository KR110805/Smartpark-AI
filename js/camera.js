/**
 * SMARTPARK AI - Mobile Camera Interface
 * js/camera.js
 * 
 * Manages mobile and desktop camera streams via navigator.mediaDevices.getUserMedia().
 * - Prefers rear-facing camera ("environment").
 * - Graceful fallback to default/front camera if rear is unavailable.
 * - Handles permissions, device availability, stream interruption, and stop.
 * - Provides frame capture utility for manual snapshots.
 */

class CameraManager {
  constructor(config = null) {
    this.config = config || (typeof CONFIG !== 'undefined' ? CONFIG : {
      CAMERA_FACING_MODE: 'environment',
      CAMERA_WIDTH: { ideal: 640 },
      CAMERA_HEIGHT: { ideal: 480 }
    });

    this.stream = null;
    this.videoElement = null;
    this.isActive = false;
    this.facingMode = this.config.CAMERA_FACING_MODE;
    this.onStatusChange = null;
  }

  /**
   * Check if getUserMedia is supported in the current environment.
   */
  isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Request camera permission and start streaming into the designated video element.
   * Explicitly triggered by user action (Start Camera button).
   */
  async start(videoElement, onStatus = null) {
    this.onStatusChange = onStatus;
    this.videoElement = videoElement;

    if (!this.isSupported()) {
      const err = new Error(
        'Camera API (getUserMedia) is not supported in this browser or context. ' +
        'Note: Camera requires HTTPS or localhost.'
      );
      this._updateStatus('ERROR', err.message);
      throw err;
    }

    this._updateStatus('CONNECTING', 'Requesting camera access...');

    // Preferred constraint: environment (rear camera on mobile)
    const primaryConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: this.config.CAMERA_FACING_MODE },
        width: this.config.CAMERA_WIDTH,
        height: this.config.CAMERA_HEIGHT,
        frameRate: this.config.CAMERA_FRAME_RATE
      }
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(primaryConstraints);
      return this._attachStream(videoElement);
    } catch (primaryErr) {
      console.warn('[CameraManager] Primary constraints failed, attempting relaxed fallback:', primaryErr.name);

      // Fallback: relax facingMode constraint (e.g. desktop webcam without environment mode)
      try {
        const fallbackConstraints = {
          audio: false,
          video: {
            width: this.config.CAMERA_WIDTH,
            height: this.config.CAMERA_HEIGHT
          }
        };
        this.stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        return this._attachStream(videoElement);
      } catch (fallbackErr) {
        const readableError = this._translateError(fallbackErr);
        this._updateStatus('ERROR', readableError);
        throw new Error(readableError);
      }
    }
  }

  /**
   * Attaches active media stream to the video element.
   */
  _attachStream(videoElement) {
    videoElement.setAttribute('playsinline', 'true'); // Required for iOS Safari inline playback
    videoElement.muted = true;

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const onVideoReady = () => {
        if (isResolved) return;
        isResolved = true;

        videoElement.play()
          .then(() => {
            this.isActive = true;
            this._setupTrackListeners();
            console.log(`[CameraManager] Camera ready. Dimensions: ${videoElement.videoWidth}x${videoElement.videoHeight}, readyState: ${videoElement.readyState}`);
            this._updateStatus('CONNECTED', 'Live camera stream active');
            resolve(this.stream);
          })
          .catch(err => {
            this._updateStatus('ERROR', 'Failed to play video stream: ' + err.message);
            reject(err);
          });
      };

      videoElement.onloadedmetadata = onVideoReady;
      videoElement.onerror = (err) => {
        this._updateStatus('ERROR', 'Video element error');
        reject(err);
      };

      videoElement.srcObject = this.stream;

      // In case metadata is already populated
      if (videoElement.readyState >= 1 && videoElement.videoWidth > 0) {
        onVideoReady();
      }
    });
  }

  /**
   * Monitors active video track for sudden disconnects (e.g. device unplugged, phone OS backgrounding).
   */
  _setupTrackListeners() {
    if (!this.stream) return;
    const videoTracks = this.stream.getVideoTracks();
    if (videoTracks.length > 0) {
      videoTracks[0].onended = () => {
        console.warn('[CameraManager] Video track ended / stream interrupted.');
        this.isActive = false;
        this._updateStatus('STOPPED', 'Camera stream was stopped or interrupted.');
      };
    }
  }

  /**
   * Stops the camera stream cleanly and releases device hardware.
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop();
        console.log(`[CameraManager] Track ${track.kind} (${track.label}) stopped.`);
      });
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.isActive = false;
    this._updateStatus('STOPPED', 'Camera stopped by user.');
  }

  /**
   * Captures a single still image from the current video frame into a canvas.
   * Useful for manual testing or snapshots.
   */
  captureFrame() {
    if (!this.videoElement || !this.isActive) {
      throw new Error('Camera is not active.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = this.videoElement.videoWidth || 640;
    canvas.height = this.videoElement.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Translates common DOMExceptions into user-friendly error messages.
   */
  _translateError(err) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Camera permission was denied. Please allow camera access in browser permissions.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera device found on this system.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Camera is already in use by another application or tab.';
      case 'OverconstrainedError':
        return 'Requested camera settings are not supported by this device.';
      case 'SecurityError':
        return 'Camera access is blocked due to security restrictions (HTTPS or localhost is required).';
      default:
        return `Camera error: ${err.message || err.name}`;
    }
  }

  _updateStatus(state, message) {
    if (this.onStatusChange) {
      this.onStatusChange({ state, message });
    }
  }
}

// Export for ES modules and standard browser window scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CameraManager;
} else if (typeof window !== 'undefined') {
  window.CameraManager = CameraManager;
}
