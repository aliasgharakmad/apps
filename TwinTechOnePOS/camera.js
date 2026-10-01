/* Camera lifecycle and local product-photo capture. No images leave this browser. */
window.OnePOSCamera = (() => {
  let stream = null;
  let video = null;
  let generation = 0;
  function stop() {
    generation++;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    if (video) { video.srcObject = null; video.closest('.camera-panel').hidden = true; }
    video = null;
  }
  async function start(form) {
    stop();
    const request = generation;
    const status = form.querySelector('#image-status');
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'Camera access is unavailable here. Use a supported browser with camera permissions, or select a built-in image.';
      return;
    }
    status.textContent = 'Allow camera access to take a product picture.';
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
      if (request !== generation || !form.isConnected || !form.closest('dialog').open) {
        acquired.getTracks().forEach(track => track.stop());
        return;
      }
      stream = acquired;
      video = form.querySelector('video');
      video.closest('.camera-panel').hidden = false;
      video.srcObject = stream;
      await video.play();
      if (request !== generation) return;
      status.textContent = 'Frame the product, then select Capture photo.';
    } catch (error) {
      if (request !== generation) return;
      stop();
      status.textContent = error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser and try again.' : 'Could not open the camera. Check that a camera is connected and is not being used by another app.';
    }
  }
  function capture() {
    if (!video?.videoWidth || !video.videoHeight) throw new Error('Wait for the camera preview before capturing.');
    const ratio = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', .75);
    if (image.length > 300000) throw new Error('Picture is too detailed. Try a simpler background.');
    stop();
    return image;
  }
  window.addEventListener('pagehide', stop);
  return {start, stop, capture};
})();
