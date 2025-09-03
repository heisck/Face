// face-api.js
// Local models path: scanner/models/
// Uses localStorage to persist enrolled descriptors.

const FaceDB_KEY = 'face-db:v1';

class FaceAPIRecognizer {
  constructor({
    videoEl,
    canvasEl,
    modelUrl = 'models',
    distanceThreshold = 0.5,    // lower is better; 0.5 is a common default
    secondBestMargin = 0.05,    // best must beat second-best by this margin
    minBoxWidth = 120,          // px
    minDetectionScore = 0.8,
    samplesPerPose = 3,
    poseInstructions = [
      ['Center', 'Look straight ahead'],
      ['Left', 'Turn your head slightly to the left'],
      ['Right', 'Turn your head slightly to the right'],
      ['Up', 'Tilt your head up a bit'],
      ['Down', 'Tilt your head down a bit'],
    ],
  }) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.modelUrl = modelUrl;
    this.distanceThreshold = distanceThreshold;
    this.secondBestMargin = secondBestMargin;
    this.minBoxWidth = minBoxWidth;
    this.minDetectionScore = minDetectionScore;
    this.samplesPerPose = samplesPerPose;
    this.poseInstructions = poseInstructions;

    this.running = false;
    this.db = this.loadDB();
  }

  async init() {
    await faceapi.nets.tinyFaceDetector.loadFromUri(this.modelUrl);
    await faceapi.nets.faceLandmark68Net.loadFromUri(this.modelUrl);
    await faceapi.nets.faceRecognitionNet.loadFromUri(this.modelUrl);
  }

  async startVideo() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    this.video.srcObject = stream;
    await this.video.play();
    this.resizeCanvasToVideo();
  }

  stopVideo() {
    this.running = false;
    const stream = this.video.srcObject;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      this.video.srcObject = null;
    }
    this.clearCanvas();
  }

  resizeCanvasToVideo() {
    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;
  }

  drawText(lines, x = 10, y = 24, color = '#00FF00') {
    this.ctx.font = '16px Inter, Arial';
    this.ctx.fillStyle = color;
    let yy = y;
    for (const line of lines) {
      this.ctx.fillText(line, x, yy);
      yy += 22;
    }
  }

  clearCanvas() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  loadDB() {
    try {
      const raw = localStorage.getItem(FaceDB_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      // descriptors back to Float32Array
      for (const name of Object.keys(obj)) {
        obj[name] = obj[name].map(arr => new Float32Array(arr));
      }
      return obj;
    } catch {
      return {};
    }
  }

  saveDB() {
    const serializable = {};
    for (const name of Object.keys(this.db)) {
      serializable[name] = this.db[name].map(f32 => Array.from(f32));
    }
    localStorage.setItem(FaceDB_KEY, JSON.stringify(serializable));
  }

  delete(name) {
    delete this.db[name];
    this.saveDB();
  }

  replace(name, descriptors) {
    this.db[name] = descriptors;
    this.saveDB();
  }

  setThresholds({ distanceThreshold, secondBestMargin }) {
    if (distanceThreshold != null) this.distanceThreshold = distanceThreshold;
    if (secondBestMargin != null) this.secondBestMargin = secondBestMargin;
  }

  // Detect one face and compute its 128-d descriptor. Returns {box, score, descriptor} or null.
  async detectOne() {
    const detection = await faceapi
      .detectSingleFace(this.video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: this.minDetectionScore }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) return null;

    const { detection: det, descriptor } = detection;
    const box = det.box;
    if (box.width < this.minBoxWidth) return null;
    return { box, score: det.score, descriptor: new Float32Array(descriptor) };
  }

  // Euclidean distance between descriptors
  static euclidean(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  // Match a descriptor against DB, return {bestName, bestDist, secondBest}
  matchDescriptor(desc) {
    let bestName = 'Unknown';
    let best = Number.POSITIVE_INFINITY;
    let second = Number.POSITIVE_INFINITY;

    for (const [name, list] of Object.entries(this.db)) {
      // person best
      let personBest = Number.POSITIVE_INFINITY;
      for (const stored of list) {
        const dist = FaceAPIRecognizer.euclidean(desc, stored);
        if (dist < personBest) personBest = dist;
      }
      // update global top-2
      if (personBest < best) {
        second = best;
        best = personBest;
        bestName = name;
      } else if (personBest < second) {
        second = personBest;
      }
    }
    return { bestName, bestDist: best, secondBest: second };
  }

  // Guided multi-pose enrollment
  async enroll(name, onProgress) {
    await this.startVideo();
    this.running = true;
    const collected = [];
    let poseIdx = 0;
    let poseCount = 0;

    while (this.running && poseIdx < this.poseInstructions.length) {
      this.resizeCanvasToVideo();
      this.clearCanvas();

      const [poseName, poseMsg] = this.poseInstructions[poseIdx];
      this.drawText([
        `Pose: ${poseName} (${poseCount}/${this.samplesPerPose})`,
        `${poseMsg}`,
        `Total: ${collected.length}/${this.poseInstructions.length * this.samplesPerPose}`,
      ], 10, 24);

      const result = await this.detectOne();
      if (result) {
        const { box, descriptor } = result;
        // draw box
        this.ctx.strokeStyle = '#00FF00';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(box.x, box.y, box.width, box.height);

        collected.push(descriptor);
        poseCount += 1;
        if (typeof onProgress === 'function') onProgress({ poseIdx, poseCount, total: collected.length });

        if (poseCount >= this.samplesPerPose) {
          poseIdx += 1;
          poseCount = 0;
          // small pause to let the user change pose
          await new Promise(r => setTimeout(r, 500));
        }
      }

      await new Promise(r => setTimeout(r, 60)); // ~16 FPS ceiling
    }

    this.stopVideo();

    if (collected.length === 0) {
      throw new Error('No high-quality face samples collected. Try better lighting and keep still.');
    }

    this.replace(name, collected);
    return collected.length;
  }

  // Live verification; calls onResult({ name, distance }) for each frame decision
  async verify(onResult) {
    await this.startVideo();
    this.running = true;

    while (this.running) {
      this.resizeCanvasToVideo();
      this.clearCanvas();

      const result = await this.detectOne();
      let name = 'Unknown';
      let distShown = 0;

      if (result) {
        const { box, descriptor } = result;
        // draw box
        this.ctx.strokeStyle = '#00FF00';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(box.x, box.y, box.width, box.height);

        const { bestName, bestDist, secondBest } = this.matchDescriptor(descriptor);
        const accept = (bestDist <= this.distanceThreshold) && ((secondBest - bestDist) >= this.secondBestMargin);
        name = accept ? bestName : 'Unknown';
        distShown = bestDist;

        this.drawText([`${name} (dist: ${bestDist.toFixed(3)})`], Math.max(10, box.x), Math.max(20, box.y - 8));
      } else {
        this.drawText(['No face / low score / too small'], 10, 24, '#FF4444');
      }

      if (typeof onResult === 'function') {
        onResult({ name, distance: distShown });
      }

      await new Promise(r => setTimeout(r, 60));
    }

    this.stopVideo();
  }

  stop() {
    this.running = false;
    this.stopVideo();
  }
}

// Export to window for simple usage on the page
window.FaceAPIRecognizer = FaceAPIRecognizer;