// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { StartStreamTranscriptionCommand, TranscribeStreamingClient, LanguageCode } from "@aws-sdk/client-transcribe-streaming";
import { TRANSCRIBE_CONFIG } from "../config";
import { LOGGER_PREFIX, TRANSCRIBE_PARTIAL_RESULTS_STABILITY } from "../constants";
import { getValidAwsCredentials, hasValidAwsCredentials } from "../utils/authUtility";
import { isFunction, isObjectUndefinedNullEmpty, isStringUndefinedNullEmpty } from "../utils/commonUtility";
import { getTranscribeAudioStream, getTranscribeMicStream } from "../utils/transcribeUtils";

let _amazonTranscribeClientAgent;
let _amazonTranscribeClientCustomer;

export async function getAmazonTranscribeClientAgent() {
  try {
    if (_amazonTranscribeClientAgent != null && hasValidAwsCredentials()) {
      return _amazonTranscribeClientAgent;
    }

    // Initialize AWS services with credentials
    const credentials = await getValidAwsCredentials();
    _amazonTranscribeClientAgent = new TranscribeStreamingClient({
      region: TRANSCRIBE_CONFIG.transcribeRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    return _amazonTranscribeClientAgent;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeAwsServices - Error initializing AWS services:`, error);
    throw error;
  }
}

export async function getAmazonTranscribeClientCustomer() {
  try {
    if (_amazonTranscribeClientCustomer != null && hasValidAwsCredentials()) {
      return _amazonTranscribeClientCustomer;
    }

    // Initialize AWS services with credentials
    const credentials = await getValidAwsCredentials();
    _amazonTranscribeClientCustomer = new TranscribeStreamingClient({
      region: TRANSCRIBE_CONFIG.transcribeRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    return _amazonTranscribeClientCustomer;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeAwsServices - Error initializing AWS services:`, error);
    throw error;
  }
}

// ✅ NEW: Retry wrapper for WebSocket connections
async function startTranscriptionWithRetry(
  transcribeClientGetter,
  audioStream,
  sampleRate,
  languageCode,
  partialResultStability,
  onFinalTranscribeEvent,
  onPartialTranscribeEvent,
  streamType // 'customer' or 'agent' for logging
) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`${LOGGER_PREFIX} - 🔄 Retrying ${streamType} transcription (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      }
      
      const enablePartialResultsStabilization = TRANSCRIBE_PARTIAL_RESULTS_STABILITY.includes(partialResultStability);

      const startStreamTranscriptionCommand = new StartStreamTranscriptionCommand({
        LanguageCode: languageCode,
        MediaEncoding: "pcm",
        MediaSampleRateHertz: sampleRate,
        AudioStream: streamType === 'customer' 
          ? getTranscribeAudioStream(audioStream, sampleRate)
          : getTranscribeMicStream(audioStream, sampleRate),
        EnablePartialResultsStabilization: enablePartialResultsStabilization,
        PartialResultsStability: enablePartialResultsStabilization ? partialResultStability : undefined,
        VocabularyName: 'myvocab_01'
      });

      const transcribeClient = await transcribeClientGetter();
      console.info(`${LOGGER_PREFIX} - 🔌 Opening ${streamType} WebSocket connection...`);
      
      const startStreamTranscriptionResponse = await transcribeClient.send(startStreamTranscriptionCommand);
      
      console.info(`${LOGGER_PREFIX} - ✓ ${streamType} WebSocket connected successfully`);
      
      let lastProcessedIndex = 0;

      for await (const event of startStreamTranscriptionResponse.TranscriptResultStream) {
        const transcriptResults = event.TranscriptEvent.Transcript.Results;

        const getPartialTranscriptResult = getPartialTranscript(transcriptResults, lastProcessedIndex);
        if (getPartialTranscriptResult != null) onPartialTranscribeEvent(getPartialTranscriptResult.partialTranscript);

        const getFinalTranscriptResult = getFinalTranscript(transcriptResults, lastProcessedIndex, enablePartialResultsStabilization);
        if (getFinalTranscriptResult != null) {
          lastProcessedIndex = getFinalTranscriptResult.lastProcessedIndex;
          onFinalTranscribeEvent(getFinalTranscriptResult.finalTranscript);
        }
      }
      
      // ✅ If we reach here, stream completed successfully
      return;
      
    } catch (error) {
      const isRetryable = isRetryableError(error);
      const isLastAttempt = attempt === MAX_RETRIES - 1;
      
      if (isRetryable && !isLastAttempt) {
        const delayMs = RETRY_DELAYS[attempt];
        console.warn(`${LOGGER_PREFIX} - ⚠️ ${streamType} transcription failed: ${error.message}. Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      } else {
        // ✅ Either not retryable or max retries exhausted
        console.error(`${LOGGER_PREFIX} - ❌ ${streamType} transcription failed after ${attempt + 1} attempts:`, error);
        throw new Error(getUserFriendlyErrorMessage(error));
      }
    }
  }
}

// ✅ NEW: Determine if error is retryable
function isRetryableError(error) {
  const errorMessage = error.message?.toLowerCase() || '';
  const errorName = error.name?.toLowerCase() || '';
  
  const retryablePatterns = [
    'socket',
    'timeout',
    'network',
    'econnreset',
    'etimedout',
    'enotfound',
    'connection',
    'websocket'
  ];
  
  return retryablePatterns.some(pattern => 
    errorMessage.includes(pattern) || errorName.includes(pattern)
  );
}

// ✅ NEW: Convert technical errors to user-friendly messages
function getUserFriendlyErrorMessage(error) {
  const msg = error.message?.toLowerCase() || '';
  
  if (msg.includes('credentials') || msg.includes('forbidden') || msg.includes('unauthorized')) {
    return 'Authentication failed. Please log out and log back in.';
  }
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('socket')) {
    return 'Network connection issue. Please check your internet connection and try again.';
  }
  if (msg.includes('websocket')) {
    return 'Unable to establish transcription connection. Please refresh the page and try again.';
  }
  
  return `Transcription error: ${error.message}`;
}

export async function startCustomerStreamTranscription(
  audioStream,
  sampleRate,
  languageCode,
  partialResultStability,
  onFinalTranscribeEvent,
  onPartialTranscribeEvent
) {
  // ✅ Validation remains the same
  if (isObjectUndefinedNullEmpty(audioStream)) throw new Error("audioStream is required");
  if (!Number.isInteger(sampleRate)) throw new Error("sampleRate is required as integer");
  if (isStringUndefinedNullEmpty(languageCode)) throw new Error("languageCode is required");
  if (isStringUndefinedNullEmpty(partialResultStability)) throw new Error("partialResultStability is required");
  if (isFunction(onFinalTranscribeEvent)) throw new Error("onFinalTranscribeEvent is required");
  if (isFunction(onPartialTranscribeEvent)) throw new Error("onPartialTranscribeEvent is required");

  // ✅ NEW: Use retry wrapper
  return await startTranscriptionWithRetry(
    getAmazonTranscribeClientCustomer,
    audioStream,
    sampleRate,
    languageCode,
    partialResultStability,
    onFinalTranscribeEvent,
    onPartialTranscribeEvent,
    'customer'
  );
}

export async function startAgentStreamTranscription(
  audioStream,
  sampleRate,
  languageCode,
  partialResultStability,
  onFinalTranscribeEvent,
  onPartialTranscribeEvent
) {
  // ✅ Validation remains the same
  if (isObjectUndefinedNullEmpty(audioStream)) throw new Error("audioStream is required");
  if (!Number.isInteger(sampleRate)) throw new Error("sampleRate is required as integer");
  if (isStringUndefinedNullEmpty(languageCode)) throw new Error("languageCode is required");
  if (isStringUndefinedNullEmpty(partialResultStability)) throw new Error("partialResultStability is required");
  if (isFunction(onFinalTranscribeEvent)) throw new Error("onFinalTranscribeEvent is required");
  if (isFunction(onPartialTranscribeEvent)) throw new Error("onPartialTranscribeEvent is required");

  // ✅ NEW: Use retry wrapper
  return await startTranscriptionWithRetry(
    getAmazonTranscribeClientAgent,
    audioStream,
    sampleRate,
    languageCode,
    partialResultStability,
    onFinalTranscribeEvent,
    onPartialTranscribeEvent,
    'agent'
  );
}

function getPartialTranscript(transcriptResults = [], lastProcessedIndex = 0) {
  if (transcriptResults.length === 0) return null;
  if (transcriptResults[0].IsPartial !== true) return null;

  // Handle regular partial transcript - to update the UI as quickly as possible
  const partialTranscriptItems = transcriptResults[0].Alternatives[0].Items;
  if (partialTranscriptItems?.length > 0) {
    // Get only the items after lastProcessedIndex
    const partialTranscript = joinTranscriptItems(partialTranscriptItems, lastProcessedIndex);
    return { partialTranscript };
  }
}

function getFinalTranscript(transcriptResults = [], lastProcessedIndex = 0, enablePartialResultsStabilization = false) {
  if (transcriptResults.length === 0) return null;
  if (transcriptResults[0].IsPartial === true && enablePartialResultsStabilization === false) return null;

  //Handle regular final transcript
  if (transcriptResults[0].IsPartial === false) {
    const finalTranscriptItems = transcriptResults[0].Alternatives[0].Items;
    if (finalTranscriptItems?.length > 0) {
      const finalTranscript = joinTranscriptItems(finalTranscriptItems, lastProcessedIndex);
      return { finalTranscript, lastProcessedIndex: 0 };
    }
  }

  // If transcript is partial, check if we have a stable transcript
  // Stable transcript is a transcript where all items are stable and the last item is a punctuation

  // Find the index of the first punctuation after the lastProcessedIndex
  const firstSegmentEndIndex = transcriptResults[0].Alternatives[0].Items.findIndex(
    (item, index) => index >= lastProcessedIndex && item.Type === "punctuation" && [",", ".", "!", "?"].includes(item.Content)
  );
  if (firstSegmentEndIndex === -1) return null; // We were not able to find a punctuation

  // Get all items up to and including the punctuation
  const segmentItems = transcriptResults[0].Alternatives[0].Items.slice(lastProcessedIndex, firstSegmentEndIndex + 1);

  // Check if ALL items in this segment are stable
  const allItemsAreStable = segmentItems.every((item) => item.Stable === true);
  if (allItemsAreStable === false) return null; // We were not able to find a punctuation

  const stableTranscript = joinTranscriptItems(segmentItems);
  return { finalTranscript: stableTranscript, lastProcessedIndex: firstSegmentEndIndex + 1 };
}

function joinTranscriptItems(transcriptItems = [], lastProcessedIndex = 0) {
  const resultTranscriptString = transcriptItems
    .slice(lastProcessedIndex)
    .map((item) => item.Content)
    .join(" ")
    .trim()
    .replace(/\s+([.,!?])/g, "$1"); // Clean up spaces before punctuation
  return resultTranscriptString;
}

export function listStreamingLanguages() {
  //returns an array of streaming language codes
  return Object.values(LanguageCode);
}
