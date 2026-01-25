export type AudioCaptureHandle = {
  stream: MediaStream;
  stop: () => void;
};

export const startMicrophoneCapture = async (): Promise<AudioCaptureHandle> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
    video: false,
  });

  return {
    stream,
    stop: () => {
      stream.getTracks().forEach((track) => track.stop());
    },
  };
};
