// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Buffer } from "buffer";
import MicrophoneStream from "microphone-stream";

export function encodePCMChunk(chunk, inputSampleRate, targetSampleRate) {
  let input = MicrophoneStream.toRaw(chunk);
  if (Number.isInteger(inputSampleRate) && Number.isInteger(targetSampleRate) && targetSampleRate < inputSampleRate) {
    input = downsampleBuffer(input, inputSampleRate, targetSampleRate);
  }
  let offset = 0;
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return Buffer.from(buffer);
}

//Creates Agent Mic Stream, used as input for Amazon Transcribe when transcribing agent's voice
export async function createMicrophoneStream(microphoneConstraints, audioContext = null) {
  const micStream = audioContext ? new MicrophoneStream({ audioContext }) : new MicrophoneStream();
  micStream.setStream(await navigator.mediaDevices.getUserMedia(microphoneConstraints));
  return micStream;
}

export const getTranscribeMicStream = async function* (amazonTranscribeMicStream, inputSampleRate, targetSampleRate) {
  for await (const chunk of amazonTranscribeMicStream) {
    const maxSamples = inputSampleRate ?? targetSampleRate;
    if (!maxSamples || chunk.length <= maxSamples) {
      const encodedChunk = encodePCMChunk(chunk, inputSampleRate, targetSampleRate);
      yield {
        AudioEvent: {
          AudioChunk: encodedChunk,
        },
      };
    }
  }
};

export const getTranscribeAudioStream = async function* (amazonTranscribeAudioStream, inputSampleRate, targetSampleRate) {
  for await (const chunk of amazonTranscribeAudioStream) {
    const maxSamples = inputSampleRate ?? targetSampleRate;
    if (!maxSamples || chunk.length <= maxSamples) {
      const encodedChunk = encodePCMChunk(chunk, inputSampleRate, targetSampleRate);
      yield {
        AudioEvent: {
          AudioChunk: encodedChunk,
        },
      };
    }
  }
};

function downsampleBuffer(buffer, inputSampleRate, targetSampleRate) {
  if (targetSampleRate >= inputSampleRate) {
    return buffer;
  }
  const sampleRateRatio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}
