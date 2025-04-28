Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIyYzY3NTUzMi0wZTI4LTRlYTktYmVlNS0zYzZhYTgxODRkOTciLCJpZCI6Mjk3MDIyLCJpYXQiOjE3NDU1Mjc5NzJ9.VtQJi-MNieaMa7c_UOnrR51nBJOA1k8EZJr0EEol8qA';

let cesiumViewer = null;

const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const trackingStatus = document.getElementById('tracking-status');
const gestureDisplay = document.getElementById('gesture-display');
const gestureIndicators = document.querySelectorAll('.gesture-indicator');
const cesiumContainer = document.getElementById('cesiumContainer');
const resetGlobeBtn = document.getElementById('reset-globe-btn');

let isTracking = false;
let hands = null;
let camera = null;
let lastFrameTime = 0;

let activeGestures = {};
let prevHand1PosNorm = null;
let prevHand1Timestamp = null;
let wasFist1ClosedPrev = false;
let prevTwoHandDistance = null;
let lastTwoHandTime = null;
const ZOOM_THRESHOLD_INCREASE = 1.05;
let flickDetectedThisFrame = false;
let flickVelocity = null;
let rotatingHandPositionNorm = null;
let handCount = 0;

let isActivelyRotating = false;
let previousRotatePos = null;
let globeSpinVelocity = { x: 0, y: 0 };
const rotationSensitivity = 1;
const flickSensitivity = 10.0;
const spinDamping = 0.965;
const zoomSpeed = 0.15;
const minCameraHeight = 150000.0;
const maxCameraHeight = 50000000.0;

function isFingerExtended(tip, base, wrist, thresholdMult = 1.1) {
     if (!tip || !base || !wrist) return false;
     const distTipWristPx = Math.hypot(tip.px - wrist.px, tip.py - wrist.py);
     const distBaseWristPx = Math.hypot(base.px - wrist.px, base.py - wrist.py);
     return distBaseWristPx > 1e-6 && (distTipWristPx > distBaseWristPx * thresholdMult);
}

function processHandResults(results) {
    activeGestures = { "click": false, "rotate": false, "zoom_in": false };
    rotatingHandPositionNorm = null;
    flickDetectedThisFrame = false;
    flickVelocity = null;
    handCount = 0;
    let allHandsData = [];
    const currentTime = performance.now();
    const frameWidth = canvasElement.width;
    const frameHeight = canvasElement.height;

     if (!frameWidth || !frameHeight || frameWidth === 0 || frameHeight === 0) {
         console.warn("Canvas dimensions invalid in processHandResults");
         updateGestureIndicators({}, false);
         return;
     }

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        handCount = results.multiHandLandmarks.length;

        for (let handIndex = 0; handIndex < handCount; handIndex++) {
            const handLandmarks = results.multiHandLandmarks[handIndex];
            if (!handLandmarks || handLandmarks.length < 21) continue;

            const landmarks = handLandmarks.map(lm => ({
                x: lm.x, y: lm.y, z: lm.z,
                px: lm.x * frameWidth, py: lm.y * frameHeight
            }));

            try {
                const thumbTip = landmarks[4]; const indexTip = landmarks[8]; const middleTip = landmarks[12];
                const ringTip = landmarks[16]; const pinkyTip = landmarks[20];
                const thumbBase = landmarks[1]; const indexBase = landmarks[5]; const middleBase = landmarks[9];
                const ringBase = landmarks[13]; const pinkyBase = landmarks[17]; const wrist = landmarks[0];

                if (!thumbTip || !indexTip || !middleTip || !ringTip || !pinkyTip ||
                    !thumbBase || !indexBase || !middleBase || !ringBase || !pinkyBase || !wrist) {
                        console.warn(`Missing critical landmarks for hand ${handIndex}`);
                        continue;
                }

                const thumbExtended = isFingerExtended(thumbTip, thumbBase, wrist);
                const indexExtended = isFingerExtended(indexTip, indexBase, wrist);
                const middleExtended = isFingerExtended(middleTip, middleBase, wrist);
                const ringExtended = isFingerExtended(ringTip, ringBase, wrist);
                const pinkyExtended = isFingerExtended(pinkyTip, pinkyBase, wrist);

                const isSplayed = indexExtended && middleExtended && ringExtended && pinkyExtended && thumbExtended;
                const isFistClosedNow = !indexExtended && !middleExtended && !ringExtended && !pinkyExtended;

                const thumbTipPx = { x: thumbTip.px, y: thumbTip.py };
                const indexTipPx = { x: indexTip.px, y: indexTip.py };
                const thumbIndexDistPx = Math.hypot(thumbTipPx.x - indexTipPx.x, thumbTipPx.y - indexTipPx.y);

                const wristPx = { x: wrist.px, y: wrist.py };
                const middleBasePx = { x: middleBase.px, y: middleBase.py };
                const handSizeMetricPx = Math.hypot(wristPx.x - middleBasePx.x, wristPx.y - middleBasePx.y);
                const pinchThresholdPx = (handSizeMetricPx * 0.35);

                const isPinch = thumbExtended && indexExtended && thumbIndexDistPx < pinchThresholdPx;
                if (isPinch) {
                     activeGestures["click"] = true;
                }

                const currentHandPosNorm = { x: wrist.x, y: wrist.y };
                const handData = { wrist: wrist, is_splayed: isSplayed, is_fist: isFistClosedNow, is_pinch: isPinch };
                allHandsData.push(handData);

                if (isPinch || isFistClosedNow) {
                    activeGestures["rotate"] = true;
                    if (!rotatingHandPositionNorm) {
                        rotatingHandPositionNorm = currentHandPosNorm;
                    }
                }

                if (handIndex === 0) {
                    if (wasFist1ClosedPrev && !isFistClosedNow) {
                        flickDetectedThisFrame = true;
                        if (prevHand1PosNorm && prevHand1Timestamp) {
                            const deltaTime = (currentTime - prevHand1Timestamp) / 1000.0;
                            if (deltaTime > 0.01) {
                                const deltaX = currentHandPosNorm.x - prevHand1PosNorm.x;
                                const deltaY = currentHandPosNorm.y - prevHand1PosNorm.y;
                                flickVelocity = { x: deltaX / deltaTime, y: deltaY / deltaTime };
                            } else { flickVelocity = { x: 0, y: 0 }; }
                        } else { flickVelocity = { x: 0, y: 0 }; }
                     }
                     wasFist1ClosedPrev = isFistClosedNow;
                     prevHand1PosNorm = currentHandPosNorm;
                     prevHand1Timestamp = currentTime;
                }

            } catch (e) {
                console.warn(`Error processing landmarks hand ${handIndex}:`, e);
            }
        }

         if (handCount === 2 && allHandsData.length === 2) {
            try {
                const hand1 = allHandsData[0];
                const hand2 = allHandsData[1];
                if (hand1.is_splayed && hand2.is_splayed && hand1.wrist && hand2.wrist) {
                    const wrist1Norm = { x: hand1.wrist.x, y: hand1.wrist.y };
                    const wrist2Norm = { x: hand2.wrist.x, y: hand2.wrist.y };
                    const currentDistanceNorm = Math.hypot(wrist1Norm.x - wrist2Norm.x, wrist1Norm.y - wrist2Norm.y);

                    if (prevTwoHandDistance !== null && lastTwoHandTime !== null) {
                        const timeDiff = (currentTime - lastTwoHandTime) / 1000.0;
                        if (timeDiff > 0.02 && timeDiff < 0.5 && currentDistanceNorm > prevTwoHandDistance * ZOOM_THRESHOLD_INCREASE) {
                            activeGestures["zoom_in"] = true;
                        }
                    }
                    prevTwoHandDistance = currentDistanceNorm;
                    lastTwoHandTime = currentTime;
                } else {
                    prevTwoHandDistance = null;
                    lastTwoHandTime = null;
                }
            } catch (e) {
                console.warn("Error in 2-hand logic:", e);
                prevTwoHandDistance = null;
                lastTwoHandTime = null;
            }
        } else {
             prevTwoHandDistance = null;
             lastTwoHandTime = null;
        }

    } else {
        wasFist1ClosedPrev = false;
        prevHand1PosNorm = null;
        prevHand1Timestamp = null;
        prevTwoHandDistance = null;
        lastTwoHandTime = null;
    }

    updateGestureIndicators(activeGestures, flickDetectedThisFrame);
    if (cesiumViewer) {
        handleCesiumInteraction(activeGestures, rotatingHandPositionNorm, flickDetectedThisFrame, flickVelocity);
    }
}

function onResults(results) {
    if (!canvasCtx || !canvasElement) {
        console.error("Canvas context or element not found in onResults");
        return;
    }

    const now = performance.now();
    const fps = 1000 / (now - lastFrameTime);
    lastFrameTime = now;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.image) {
        canvasCtx.drawImage(
            results.image,
            0, 0,
            canvasElement.width, canvasElement.height
        );
    } else {
        canvasCtx.fillStyle = 'rgba(10, 10, 30, 1)';
        canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);
        console.warn("results.image not found in onResults.");
    }

     if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        let handIndex = 0;
        for (const landmarks of results.multiHandLandmarks) {
            if (landmarks && landmarks.length >= 21) {
                try {
                     drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#FFFFFF', lineWidth: 3 });
                     drawLandmarks(canvasCtx, landmarks, { color: '#FF5733', lineWidth: 1, radius: 4 });
                 } catch (drawError) {
                     console.error(`Error drawing landmarks for hand ${handIndex}:`, drawError);
                 }
            } else {
                console.warn(`Hand ${handIndex} detected, but landmarks array is invalid or too short.`);
            }
            handIndex++;
        }
    }
    canvasCtx.restore();

    processHandResults(results);
}

function initializeMediaPipeHands() {
     console.log("Initializing MediaPipe Hands...");
     try {
        hands = new Hands({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});

        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.6
        });

        hands.onResults(onResults);
         console.log("MediaPipe Hands options set and onResults assigned.");

    } catch (error) {
        console.error("Error initializing MediaPipe Hands:", error);
         alert("Failed to initialize hand tracking. Check console for details.");
         startBtn.disabled = true;
         startBtn.textContent = "Init Failed";
     }
}

function startTracking() {
    if (isTracking) return;
    console.log("Attempting to start tracking...");

    if (!hands) {
         console.error("MediaPipe Hands not initialized before startTracking!");
         alert("Tracking system not ready. Please refresh.");
         return;
    }
     if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("getUserMedia is not supported by your browser!");
        console.error("getUserMedia not supported.");
        return;
    }

    console.log("Creating MediaPipe Camera instance...");
    camera = new Camera(videoElement, {
        onFrame: async () => {
             if (!videoElement || videoElement.readyState < videoElement.HAVE_METADATA || videoElement.videoWidth === 0) {
                 return;
             }

            if (canvasElement.width !== videoElement.videoWidth || canvasElement.height !== videoElement.videoHeight) {
                 canvasElement.width = videoElement.videoWidth;
                 canvasElement.height = videoElement.videoHeight;
                 console.log(`Canvas resized to: ${canvasElement.width}x${canvasElement.height}`);
            }

            if (hands && isTracking) {
                try {
                    await hands.send({ image: videoElement });
                } catch (sendError) {
                     console.error("Error sending frame to MediaPipe Hands:", sendError);
                }
            }
        },
         width: 640,
         height: 480
    });

     console.log("Starting MediaPipe Camera...");
    camera.start()
        .then(() => {
            console.log("Camera started successfully via Camera Util.");
            isTracking = true;
            trackingStatus.textContent = 'Tracking On';
            trackingStatus.className = 'badge bg-success';
            startBtn.disabled = true;
            stopBtn.disabled = false;
            gestureDisplay.innerHTML = `<p class="text-center text-muted small mb-0">Detecting hands...</p>`;
            lastFrameTime = performance.now();
        })
        .catch(error => {
             console.error("Failed to start camera via Camera Util:", error);
             alert(`Failed to start camera: ${error.message}. Check permissions and console.`);
             if (camera) {
                 camera.stop();
                 camera = null;
             }
             stopBtn.disabled = true;
             startBtn.disabled = false;
             trackingStatus.textContent = 'Camera Error';
             trackingStatus.className = 'badge bg-danger';
        });
}


function stopTracking() {
    if (!isTracking) return;
    console.log("Stopping tracking...");

    isTracking = false;

    if (camera) {
         console.log("Stopping MediaPipe Camera instance...");
        camera.stop();
        camera = null;
         console.log("Camera instance stopped.");
    }

     if (canvasCtx && canvasElement) {
        console.log("Clearing canvas.");
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
     } else {
         console.warn("Canvas context/element not available for clearing.");
     }

    trackingStatus.textContent = 'Tracking Off';
    trackingStatus.className = 'badge bg-secondary';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateGestureIndicators({}, false);
    gestureDisplay.innerHTML = `<p class="text-center text-muted small mb-0">Tracking stopped</p>`;

    resetHandState();
    if (cesiumViewer && cesiumViewer.scene) {
        cesiumViewer.scene.screenSpaceCameraController.enableInputs = true;
    }
    console.log("Tracking fully stopped.");
}

 function resetHandState() {
     activeGestures = {};
     prevHand1PosNorm = null;
     prevHand1Timestamp = null;
     wasFist1ClosedPrev = false;
     prevTwoHandDistance = null;
     lastTwoHandTime = null;
     flickDetectedThisFrame = false;
     flickVelocity = null;
     rotatingHandPositionNorm = null;
     handCount = 0;
     console.log("Hand state reset.");
 }

function updateGestureIndicators(gestures, flickDetected) {
    if (!gestureDisplay || !gestureIndicators) return;

    gestureIndicators.forEach(indicator => {
        const name = indicator.getAttribute('data-gesture');
        if (name === 'flick') {
            if (flickDetected) {
                indicator.style.opacity = '1.0';
                indicator.style.boxShadow = '0 0 8px 2px magenta';
                setTimeout(() => {
                    indicator.style.opacity = '0.5';
                     indicator.style.boxShadow = 'none';
                }, 300);
            }
        } else if (name && gestures.hasOwnProperty(name)) {
            if (gestures[name]) {
                indicator.classList.remove('inactive');
                indicator.classList.add('active');
            } else {
                indicator.classList.remove('active');
                indicator.classList.add('inactive');
            }
        } else if (name) {
            indicator.classList.remove('active');
            indicator.classList.add('inactive');
        }
    });

    const activeNames = Object.entries(gestures)
                            .filter(([_, v]) => v)
                            .map(([k, _]) => k.replace(/_/g, ' '));

    if (flickDetected) activeNames.push('flick');

    if (activeNames.length > 0) {
        gestureDisplay.innerHTML = `<div class="alert alert-info py-1 px-2 small mb-0 text-capitalize">Active: ${activeNames.join(', ')}</div>`;
    } else if (isTracking) {
         gestureDisplay.innerHTML = `<p class="text-center text-muted small mb-0">Detecting hands...</p>`;
    } else {
         gestureDisplay.innerHTML = `<p class="text-center text-muted small mb-0">Tracking stopped</p>`;
    }
}

async function initializeCesiumGlobe() {
    console.log("Attempting Cesium Viewer initialization...");
    if (!cesiumContainer) {
        console.error("Cesium container element not found!");
        alert("Error: Could not find Cesium container.");
        return;
    }

    if (!Cesium.Ion.defaultAccessToken) {
         console.error("Cesium Ion access token is not set!");
         alert("Cesium Ion access token is missing.");
         return;
    }
    console.log("[INIT_GLOBE] Access token check passed. Value length:", Cesium.Ion.defaultAccessToken.length);

    try {
        console.log("[INIT_GLOBE] Entering TRY block.");
        console.log("Creating Cesium Viewer (initial)...");
        cesiumViewer = new Cesium.Viewer('cesiumContainer', {
            animation: false, baseLayerPicker: false, fullscreenButton: false, vrButton: false,
            geocoder: true, homeButton: false, infoBox: false, sceneModePicker: false,
            selectionIndicator: false, timeline: false, navigationHelpButton: false,
            navigationInstructionsInitiallyVisible: false, scene3DOnly: true
        });
        console.log("Cesium Viewer object created.");

        if (!cesiumViewer.scene) {
             throw new Error("Cesium scene object not available after initial viewer creation.");
        }

        console.log("Configuring scene basics...");
        cesiumViewer.scene.globe.enableLighting = true;
        cesiumViewer.scene.postProcessStages.fxaa.enabled = true;
        cesiumViewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        cesiumViewer.scene.screenSpaceCameraController.enableInputs = true;

        console.log("Attempting to create async imagery provider...");
         try {
            if (typeof Cesium.createWorldImageryAsync !== 'function') {
                throw new Error('Cesium.createWorldImageryAsync function not found. Check CesiumJS version or loading.');
            }
            const imageryProvider = await Cesium.createWorldImageryAsync({});
            console.log("Async imagery provider created. Adding to viewer...");
            cesiumViewer.imageryLayers.addImageryProvider(imageryProvider);
            console.log("Imagery provider added.");

         } catch (imageryError) {
            console.error(`Error creating or adding async world imagery: ${imageryError}`);
         }

         console.log("Attempting to create terrain provider...");
         try {
            if (typeof Cesium.createWorldTerrainAsync !== 'function') {
                 if (typeof Cesium.createWorldTerrain === 'function') {
                     console.log("createWorldTerrainAsync not found, trying synchronous createWorldTerrain...");
                     cesiumViewer.terrainProvider = Cesium.createWorldTerrain();
                     console.log("Synchronous terrain provider set.");
                 } else {
                    throw new Error('Neither Cesium.createWorldTerrainAsync nor Cesium.createWorldTerrain found.');
                 }
            } else {
                 const terrainProvider = await Cesium.createWorldTerrainAsync();
                 console.log("Async terrain provider created. Setting on viewer...");
                 cesiumViewer.terrainProvider = terrainProvider;
                 console.log("Terrain provider set.");
             }

         } catch (terrainError) {
              console.error(`Error creating or setting terrain provider: ${terrainError}`);
         }

        console.log("Camera flyHome called.");
        cesiumViewer.camera.flyHome(0);

        startCesiumRenderLoop();
        console.log("CesiumJS Viewer fully initialized and configured.");

    } catch (error) {
        console.error("FATAL: CesiumJS initialization failed:", error);
        cesiumContainer.innerHTML = `<div class='alert alert-danger m-3'>Failed to initialize 3D Globe. Check console for details. Error: ${error.message}</div>`;
    }
    console.log("[INIT_GLOBE] Function execution finished.");
}

function handleCesiumInteraction(gestures, rotatingHandPos, flickDetected, flickVelocity) {
    if (!cesiumViewer || !cesiumViewer.scene || !cesiumViewer.camera) {
         return;
     }

    const rotateActive = gestures?.rotate === true && rotatingHandPos;
    const zoomActive = gestures?.zoom_in === true;
    const scene = cesiumViewer.scene;
    const camera = cesiumViewer.camera;

    const isHandInteracting = rotateActive || zoomActive;
    scene.screenSpaceCameraController.enableInputs = !isHandInteracting;

    if (rotateActive) {
        if (!isActivelyRotating) {
            isActivelyRotating = true;
            previousRotatePos = rotatingHandPos;
            globeSpinVelocity = { x: 0, y: 0 };
        } else if (previousRotatePos) {
            const rotatescale = camera.positionCartographic.height / 10000000.0;
            const deltaX = rotatingHandPos.x - previousRotatePos.x;
            const deltaY = rotatingHandPos.y - previousRotatePos.y;

            camera.rotateRight(deltaX * rotatescale * -1);
            camera.rotateUp(deltaY * rotatescale * -1);

            previousRotatePos = rotatingHandPos;
        }
    } else {
        if (isActivelyRotating) {
            isActivelyRotating = false;
            previousRotatePos = null;

            if (flickDetected && flickVelocity) {

                const flickScale = (camera.positionCartographic.height / 10000000.0) * 6.0;

                globeSpinVelocity.y = flickVelocity.x * flickScale;
                globeSpinVelocity.x = -flickVelocity.y * flickScale;
            }
        }
    }

    if (zoomActive) {
        const currentHeight = camera.positionCartographic.height;
        if (currentHeight > minCameraHeight) {
            const moveAmount = currentHeight * zoomSpeed;
            camera.moveForward(Math.min(moveAmount, currentHeight - minCameraHeight));
        }
    }
}

 function startCesiumRenderLoop() {
     if (!cesiumViewer || !cesiumViewer.clock) {
         console.error("Cannot start Cesium render loop - viewer or clock not ready.");
         return;
     }
     cesiumViewer.clock.onTick.addEventListener(applySpinAndDamping);
     console.log("CesiumJS render loop integrated for spin/damping.");
 }

function applySpinAndDamping() {
     if (!cesiumViewer || !cesiumViewer.camera) {
         return;
     }
     const camera = cesiumViewer.camera;

     if (!isActivelyRotating && (Math.abs(globeSpinVelocity.x) > 1e-5 || Math.abs(globeSpinVelocity.y) > 1e-5)) {

         const deltaTime = cesiumViewer.clock.deltaTime || (1.0 / 60.0);

         try {
             camera.rotateUp(globeSpinVelocity.x * deltaTime * -1);
             camera.rotateRight(globeSpinVelocity.y * deltaTime * -1);
         } catch (rotateError) {
              console.error("Error during camera.rotateUp/Right:", rotateError);
              globeSpinVelocity = { x: 0, y: 0 };
         }

         globeSpinVelocity.x *= spinDamping;
         globeSpinVelocity.y *= spinDamping;

         if (Math.abs(globeSpinVelocity.x) < 1e-5) globeSpinVelocity.x = 0;
         if (Math.abs(globeSpinVelocity.y) < 1e-5) globeSpinVelocity.y = 0;
     }
 }

 function resetGlobeView() {
    if (cesiumViewer && cesiumViewer.camera) {
        cesiumViewer.camera.flyHome(1.0);
        isActivelyRotating = false;
        previousRotatePos = null;
        globeSpinVelocity = { x: 0, y: 0 };
        if (cesiumViewer.scene) {
            cesiumViewer.scene.screenSpaceCameraController.enableInputs = true;
        }
         console.log("Globe view reset.");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Loaded. Initializing application...");
    if (!canvasCtx) {
        console.error("Failed to get 2D context from canvas!");
        alert("Error initializing canvas. Cannot proceed.");
        return;
    }

    stopBtn.disabled = true;

    startBtn.addEventListener('click', startTracking);
    stopBtn.addEventListener('click', stopTracking);
    resetGlobeBtn.addEventListener('click', resetGlobeView);

    document.querySelectorAll('.demo-btn').forEach(btn => {
         btn.addEventListener('click', () => btn.classList.toggle('active'));
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js')
            .then(registration => {
                console.log('Service Worker registered successfully with scope:', registration.scope);
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
            });
    } else {
        console.warn('Service Worker is not supported by this browser.');
    }

    initializeCesiumGlobe().catch(err => {
        console.error("Error during async globe initialization:", err);
        if (cesiumContainer) {
             cesiumContainer.innerHTML = `<div class='alert alert-danger m-3'>Unhandled error during globe setup. Check console.</div>`;
        }
    });

     initializeMediaPipeHands();

     console.log("Initialization complete. Ready for user to start tracking.");
});