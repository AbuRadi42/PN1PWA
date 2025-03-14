// Register the service worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/js/service-worker.js')
      .then((registration) => {
        console.log(
          'ServiceWorker registration successful with scope:',
          registration.scope,
        );
      })
      .catch((error) => {
        console.log('ServiceWorker registration failed:', error);
      });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // DOM elements
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');
  const loader = document.getElementById('loader');
  const buttonsContainer = document.getElementById('buttons-container');
  const tapToRecordText = document.getElementById('tapToRecordText');

  // Buttons and modals
  const infoBtn = document.getElementById('infoBtn');
  const tweakBtn = document.getElementById('tweakBtn');
  const recordBeginBtn = document.getElementById('recordBeginBtn');
  const savedBtn = document.getElementById('savedBtn');
  const signinBtn = document.getElementById('signinBtn');
  const infoModal = document.getElementById('infoModal');
  const tweakModal = document.getElementById('tweakModal');
  const savedModal = document.getElementById('savedModal');
  const signinModal = document.getElementById('signinModal');
  const qrCodeImg = document.getElementById('qrCode');
  const closeModalBtn = document.getElementById('closeModal');
  const closeTweakModalBtn = document.getElementById('closeTweakModal');
  const closeSavedModalBtn = document.getElementById('closeSavedModal');
  const closeSigninModalBtn = document.getElementById('closeSigninModal');
  const savedVideosContainer = document.getElementById('savedVideosContainer');
  const dropzoneFile = document.getElementById('videoUpload');

  const modeToggle = document.getElementById('modeToggle');
  const funModeSettings = document.getElementById('funModeSettings');
  const sciModeSettings = document.getElementById('sciModeSettings');

  // Flags and globals
  let cameraInitialized = false;
  let mediaRecorder;
  let recordedChunks = [];
  let savedVideos = [];
  let isRecording = false;
  // Global smoothed bounding box state
  let smoothedBox = { x: 0, y: 0, w: 0, h: 0, valid: false };

  // Simple linear interpolation function
  function lerp(start, end, t) {
    return start + t * (end - start);
  }

  // Preload watermark images
  const dogWatermarkImg = new Image();
  const pn1WatermarkImg = new Image();
  dogWatermarkImg.src = 'icons/watermark.dog.svg';
  pn1WatermarkImg.src = 'icons/watermark.PN1.svg';

  // Start the camera as soon as possible (without waiting for watermarks)
  setupCamera();

  /**
   * Sets up the camera stream.
   */
  async function setupCamera() {
    if (cameraInitialized) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error('getUserMedia not supported on your browser!');
      return;
    }

    try {
      const constraints = {
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      handleCameraStream(stream);
    } catch (error) {
      console.error('Error accessing the camera:', error);
    }
  }

  /**
   * Handles the camera stream once access is granted.
   */
  async function handleCameraStream(stream) {
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.classList.remove('hidden');
      loader.classList.add('hidden');
      buttonsContainer.classList.remove('opacity-0', 'pointer-events-none');
      buttonsContainer.classList.add('opacity-100', 'pointer-events-auto');
      tapToRecordText.classList.remove('opacity-0');
      setTimeout(() => {
        tapToRecordText.classList.add('opacity-0');
      }, 3000);

      // Set canvas dimensions based on video
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      // Start the rendering loop immediately
      requestAnimationFrame(drawCanvasFrame);
    };
  }

  // --- Worker-based Detection Setup ---

  // Create and initialize the worker for TensorFlow detection.
  const tfjsWorker = new Worker('tfjsWorker.js');

  tfjsWorker.onmessage = (e) => {
    if (e.data.type === 'modelReady') {
      console.log('Detection model loaded in worker.');
      // The worker handles model loading, so you can now send frames for detection.
    } else if (e.data.type === 'detectionResults') {
      // Process results from the worker.
      const predictions = e.data.predictions;
      const detectionWidth = e.data.detectionWidth || 224;
      const detectionHeight = e.data.detectionHeight || 224;
      const scaleX = video.videoWidth / detectionWidth;
      const scaleY = video.videoHeight / detectionHeight;
      const dog = predictions.find((pred) => pred.class === 'dog');
      if (dog) {
        const [newX, newY, newW, newH] = dog.bbox;
        const fullNewX = newX * scaleX;
        const fullNewY = newY * scaleY;
        const fullNewW = newW * scaleX;
        const fullNewH = newH * scaleY;
        const alpha = 0.4; // Smoothing factor

        if (!smoothedBox.valid) {
          smoothedBox = {
            x: fullNewX,
            y: fullNewY,
            w: fullNewW,
            h: fullNewH,
            valid: true,
          };
        } else {
          smoothedBox.x = lerp(smoothedBox.x, fullNewX, alpha);
          smoothedBox.y = lerp(smoothedBox.y, fullNewY, alpha);
          smoothedBox.w = lerp(smoothedBox.w, fullNewW, alpha);
          smoothedBox.h = lerp(smoothedBox.h, fullNewH, alpha);
        }
      } else {
        smoothedBox.valid = false;
      }
    }
  };

  // Use a single updateDetections function that sends frames to the worker.
  async function updateDetections() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      if (canvas.transferControlToOffscreen) {
        const offscreen = canvas.transferControlToOffscreen();
        tfjsWorker.postMessage({ type: 'detect', canvas: offscreen }, [
          offscreen,
        ]);
      } else {
        const bitmap = await createImageBitmap(video);
        tfjsWorker.postMessage({
          type: 'detect',
          bitmap,
          detectionWidth: 224,
          detectionHeight: 224,
        });
      }
    }
  }

  // Throttle detection calls to run every 100ms.
  setInterval(updateDetections, 100);

  // --- Rendering Loop ---
  function drawCanvasFrame() {
    if (!video.videoWidth || !video.videoHeight) {
      requestAnimationFrame(drawCanvasFrame);
      return;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Example: draw video centered in canvas
    const margin = 1.25;
    const borderThickness = 2.5;
    const borderRadius = 5;
    const scale = Math.min(
      (canvas.width - 2 * margin) / video.videoWidth,
      (canvas.height - 2 * margin) / video.videoHeight,
    );
    const newWidth = video.videoWidth * scale;
    const newHeight = video.videoHeight * scale;
    const xOffset = (canvas.width - newWidth) / 2;
    const yOffset = (canvas.height - newHeight) / 2;

    // Draw a rounded border container
    ctx.strokeStyle = 'white';
    ctx.lineWidth = borderThickness;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.moveTo(xOffset + borderRadius, yOffset);
    ctx.arcTo(
      xOffset + newWidth,
      yOffset,
      xOffset + newWidth,
      yOffset + borderRadius,
      borderRadius,
    );
    ctx.arcTo(
      xOffset + newWidth,
      yOffset + newHeight,
      xOffset + newWidth - borderRadius,
      yOffset + newHeight,
      borderRadius,
    );
    ctx.arcTo(
      xOffset,
      yOffset + newHeight,
      xOffset,
      yOffset + newHeight - borderRadius,
      borderRadius,
    );
    ctx.arcTo(xOffset, yOffset, xOffset + borderRadius, yOffset, borderRadius);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Clip to the rounded container and draw the video inside
    ctx.save();
    ctx.clip();
    ctx.drawImage(video, xOffset, yOffset, newWidth, newHeight);
    ctx.restore();

    // Draw detection overlay if available
    if (smoothedBox.valid) {
      const cornerLength = 20;
      ctx.beginPath();
      drawCorners(
        ctx,
        smoothedBox.x,
        smoothedBox.y,
        smoothedBox.w,
        smoothedBox.h,
        cornerLength,
      );
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Draw preloaded watermarks
    ctx.globalAlpha = 0.5;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 5;
    ctx.drawImage(dogWatermarkImg, 8, 8, 64, 64);
    ctx.drawImage(pn1WatermarkImg, 80, 13, 108, 54);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;

    requestAnimationFrame(drawCanvasFrame);
  }

  function drawCorners(ctx, x, y, w, h, cornerLen) {
    // Top-left corner
    ctx.moveTo(x, y + cornerLen);
    ctx.lineTo(x, y);
    ctx.lineTo(x + cornerLen, y);
    // Top-right corner
    ctx.moveTo(x + w - cornerLen, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + cornerLen);
    // Bottom-left corner
    ctx.moveTo(x, y + h - cornerLen);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + cornerLen, y + h);
    // Bottom-right corner
    ctx.moveTo(x + w - cornerLen, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - cornerLen);
  }

  function displaySavedVideos() {
    savedVideosContainer.innerHTML = '';

    if (savedVideos.length === 0) {
      savedVideosContainer.innerHTML = `
        <br>
        <div class="flex items-center justify-center w-full">
          <label for="videoUpload" class="flex flex-col items-center justify-center w-full h-[calc(100% - 20vh)] border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100">
            <div class="flex flex-col items-center justify-center pt-5 pb-6 w-full h-full">
              <svg class="w-8 h-8 mb-4 text-gray-500" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
                <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"/>
              </svg>
              <p>Click to upload</p>
            </div>
            <input id="videoUpload" type="file" class="hidden" />
          </label>
        </div>
        <br>
        <p>No saved videos yet.</p>
      `;
      return;
    }

    savedVideos.forEach((videoObj, index) => {
      const { id, url } = videoObj;
      const listItem = document.createElement('div');
      listItem.classList.add(
        'flex',
        'items-center',
        'justify-between',
        'mb-4',
        'p-2',
        'border',
        'rounded',
      );

      const thumbnail = document.createElement('video');
      thumbnail.src = url;
      thumbnail.classList.add('w-16', 'h-16', 'object-cover', 'rounded');
      thumbnail.muted = true;

      const title = document.createElement('span');
      title.classList.add('flex-1', 'ml-4', 'text-sm');
      title.textContent = `Video ${index + 1}`;

      const playButton = document.createElement('button');
      playButton.classList.add(
        'ml-2',
        'text-green-500',
        'hover:text-green-700',
      );
      playButton.innerHTML =
        '<img src="icons/playVideoBtn.svg" alt="Play" class="w-8 h-8 mr-4">';
      playButton.addEventListener('click', () => {
        const videoPlayer = document.createElement('video');
        videoPlayer.src = url;
        videoPlayer.controls = true;
        videoPlayer.classList.add(
          'fixed',
          'top-1/2',
          'left-1/2',
          'transform',
          '-translate-x-1/2',
          '-translate-y-1/2',
          'w-full',
          'max-w-xl',
          'z-50',
        );
        document.body.appendChild(videoPlayer);
        videoPlayer.play();
        videoPlayer.addEventListener('ended', () => {
          document.body.removeChild(videoPlayer);
        });
      });

      const deleteButton = document.createElement('button');
      deleteButton.classList.add('ml-2', 'text-red-500', 'hover:text-red-700');
      deleteButton.innerHTML =
        '<img src="icons/removeItemBtn.svg" alt="Delete" class="w-8 h-8 mr-4">';
      deleteButton.addEventListener('click', () => {
        // Remove from the in-memory array and delete from IndexedDB using the id
        savedVideos.splice(index, 1);
        deleteVideoFromDB(id);
        displaySavedVideos();
      });

      listItem.appendChild(thumbnail);
      listItem.appendChild(title);
      listItem.appendChild(playButton);
      listItem.appendChild(deleteButton);

      savedVideosContainer.appendChild(listItem);
    });
  }

  // Event listeners for buttons.
  if (infoBtn) infoBtn.addEventListener('click', handleButtonClick);
  if (tweakBtn) tweakBtn.addEventListener('click', handleButtonClick);
  if (recordBeginBtn) {
    recordBeginBtn.addEventListener('click', handleButtonClick);
    recordBeginBtn.addEventListener('touchstart', handleTouchStart);
    recordBeginBtn.addEventListener('touchend', handleTouchEnd);
  }
  if (savedBtn) savedBtn.addEventListener('click', handleButtonClick);
  if (signinBtn) signinBtn.addEventListener('click', handleButtonClick);

  function handleButtonClick(event) {
    const buttonId = event.currentTarget.id;
    switch (buttonId) {
      case 'infoBtn':
        qrCodeImg.src =
          'https://api.qrserver.com/v1/create-qr-code/?size=180x180&color=93C575&data=' +
          encodeURIComponent(window.location.href);
        infoModal.classList.remove('hidden');
        break;
      case 'tweakBtn':
        tweakModal.classList.remove('hidden');
        break;
      case 'savedBtn':
        savedModal.classList.remove('hidden');
        displaySavedVideos();
        break;
      case 'signinBtn':
        signinModal.classList.remove('hidden');
        break;
    }
  }

  function handleTouchStart(event) {
    const buttonId = event.currentTarget.id;
    if (buttonId === 'recordBeginBtn' && !isRecording) {
      recordedChunks = [];
      mediaRecorder.start();
      isRecording = true;
      recordBeginBtn.innerHTML =
        '<img src="icons/recordStopBtn.svg" alt="Stop" class="w-1/2 h-1/2 relative">';
      recordBeginBtn.style.backgroundColor = '#CC5500';
      recordBeginBtn.style.animation = 'pulse 1s infinite';
    }
  }

  function handleTouchEnd(event) {
    const buttonId = event.currentTarget.id;
    if (buttonId === 'recordBeginBtn' && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
      recordBeginBtn.innerHTML =
        '<img src="icons/recordBeginBtn.svg" alt="Record" class="w-1/2 h-1/2 relative">';
      recordBeginBtn.style.backgroundColor = '#93C575';
      recordBeginBtn.style.animation = 'none';
    }
  }

  if (closeModalBtn)
    closeModalBtn.addEventListener('click', () => {
      infoModal.classList.add('hidden');
    });
  if (closeTweakModalBtn)
    closeTweakModalBtn.addEventListener('click', () => {
      tweakModal.classList.add('hidden');
    });
  if (closeSavedModalBtn)
    closeSavedModalBtn.addEventListener('click', () => {
      savedModal.classList.add('hidden');
    });
  if (closeSigninModalBtn)
    closeSigninModalBtn.addEventListener('click', () => {
      signinModal.classList.add('hidden');
    });

  // Initialize camera feed and persistent storage
  setupCamera();

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((granted) => {
      console.log('Persistent storage granted:', granted);
    });
  }

  openDatabase()
    .then(() => {
      loadVideosFromDB((records) => {
        savedVideos = records.map((record) => ({
          id: record.id,
          url: URL.createObjectURL(record.blob),
        }));
        displaySavedVideos();
      });
    })
    .catch((err) => console.error('IndexedDB error:', err));

  if (dropzoneFile) {
    dropzoneFile.addEventListener('change', handleFileUpload);
  }

  function handleFileUpload(event) {
    const file = event.target.files[0];
    if (file && file.type.match('video.*')) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const videoBlob = new Blob([e.target.result], { type: file.type });
        const videoUrl = URL.createObjectURL(videoBlob);
        savedVideos.push(videoUrl);
        saveVideoToDB(videoBlob, videoUrl);
        displaySavedVideos();
      };
      reader.readAsArrayBuffer(file);
    }
  }

  // Load the saved mode from local storage or set a default
  const savedMode = localStorage.getItem('appMode') || 'FunMode';
  if (savedMode === 'FunMode') {
    modeToggle.checked = false;
    funModeSettings.classList.remove('hidden');
    sciModeSettings.classList.add('hidden');
  } else {
    modeToggle.checked = true;
    sciModeSettings.classList.remove('hidden');
    funModeSettings.classList.add('hidden');
  }

  // Add event listener to the toggle switch
  modeToggle.addEventListener('change', () => {
    if (modeToggle.checked) {
      localStorage.setItem('appMode', 'SciMode');
      sciModeSettings.classList.remove('hidden');
      funModeSettings.classList.add('hidden');
    } else {
      localStorage.setItem('appMode', 'FunMode');
      funModeSettings.classList.remove('hidden');
      sciModeSettings.classList.add('hidden');
    }
  });

  // Android install prompt handling remains unchanged.
  let deferredPrompt;
  const installButton = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installButton) {
      installButton.style.display = 'block';
      installButton.addEventListener('click', () => {
        installButton.style.display = 'none';
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
          } else {
            console.log('User dismissed the install prompt');
          }
          deferredPrompt = null;
        });
      });
    }
  });
});
