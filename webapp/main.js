// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import "./style.css";
import "amazon-connect-streams";

import MicrophoneStream from "microphone-stream";

import { getConnectURLS, addUpdateLocalStorageKey, getLocalStorageValueByKey, base64ToArrayBuffer, isStringUndefinedNullEmpty } from "./utils/commonUtility";
import {
  AGENT_TRANSLATION_TO_AGENT_VOLUME,
  AUDIO_FEEDBACK_FILE_PATH,
  CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME,
  LOGGER_PREFIX,
  TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS,
  TRANSCRIBE_PARTIAL_RESULTS_STABILITY,
  TRANSCRIBE_TARGET_SAMPLE_RATE,
} from "./constants";
import { getLoginUrl, getValidTokens, handleRedirect, isAuthenticated, logout, setRedirectURI, startTokenRefreshTimer } from "./utils/authUtility";
import { AudioStreamManager } from "./managers/AudioStreamManager";
import { SessionTrackManager, TrackType } from "./managers/SessionTrackManager";
import { createMicrophoneStream } from "./utils/transcribeUtils";
import { translateText } from "./adapters/translateAdapter";
import { synthesizeSpeech } from "./adapters/pollyAdapter";
import { startAgentStreamTranscription, startCustomerStreamTranscription } from "./adapters/transcribeAdapter";
import { CONNECT_CONFIG } from "./config";
import { AudioContextManager } from "./managers/AudioContextManager";
import { AudioInputTestManager } from "./managers/InputTestManager";

let connect = {};
let CurrentUser = {};
let CCP_V2V = {};

let CurrentAgentConnectionId;
let ConnectSoftPhoneManager;
let IsCustomerTranscribing = false;
let IsAgentTranscribing = false;
let CurrentContactId;
let CurrentLanguageConfig;
let CustomerPartialResultsStability;
let AgentPartialResultsStability;

const LANGUAGE_ATTRIBUTE_KEYS = ["language", "Language", "preferredLanguage", "preferred_language"];
const LANGUAGE_VALUE_MAP = {
  spanish: "spanish",
  es: "spanish",
  "es-es": "spanish",
  "es-us": "spanish",
  french: "french",
  fr: "french",
  "fr-fr": "french",
  "fr-ca": "french",
};

const LANGUAGE_PRESETS = {
  spanish: {
    label: "Spanish",
    customer: {
      transcribeLanguage: "es-US",
      translateLanguage: "es",
      polly: { languageCode: "es-US", engine: "standard", voiceId: "Lupe" },
    },
    agent: {
      transcribeLanguage: "en-US",
      translateLanguage: "en",
      polly: { languageCode: "en-US", engine: "standard", voiceId: "Joanna" },
    },
  },
  french: {
    label: "French",
    customer: {
      transcribeLanguage: "fr-FR",
      translateLanguage: "fr",
      polly: { languageCode: "fr-FR", engine: "standard", voiceId: "Lea" },
    },
    agent: {
      transcribeLanguage: "en-US",
      translateLanguage: "en",
      polly: { languageCode: "en-US", engine: "standard", voiceId: "Joanna" },
    },
  },
};

const DEFAULT_LANGUAGE_KEY = "spanish";
const DEFAULT_PARTIAL_RESULT_STABILITY = "medium";
const ENABLE_CUSTOMER_AUDIO_FEEDBACK = true;
const ENABLE_AGENT_AUDIO_FEEDBACK = true;
const STREAM_CUSTOMER_MIC_TO_AGENT = true;
const STREAM_AGENT_MIC_TO_CUSTOMER = true;
const STREAM_CUSTOMER_TRANSLATION_TO_CUSTOMER = true;
const STREAM_AGENT_TRANSLATION_TO_AGENT = false;
const DEFAULT_MIC_VOLUME = 0.1;
const DEFAULT_ECHO_CANCELLATION = true;
const DEFAULT_NOISE_SUPPRESSION = true;
const DEFAULT_AUTO_GAIN_CONTROL = false;

// AudioContextManager to manage the AudioContext
let AudioContextMgr = new AudioContextManager();

// AgentMicTestManager to test agent's mic
let AgentMicTestManager;

//Agent Mic Stream used as input for Amazon Transcribe when transcribing agent's voice
let AmazonTranscribeToCustomerAudioStream;
//Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
let AmazonTranscribeFromCustomerAudioStream;

// SessionTrackManager to manage the current track streaming to the customer
let RTCSessionTrackManager;

// AudioStreamManager to manage the stream that goes to Customer
let ToCustomerAudioStreamManager;

// AudioStreamManager to manage the stream that goes to Agent
let ToAgentAudioStreamManager;

async function getAudioContext() {
  if (AudioContextMgr == null) {
    AudioContextMgr = new AudioContextManager();
  }
  const audioContext = await AudioContextMgr.getAudioContext();
  return audioContext;
}

async function getAgentMicTestManager() {
  if (AgentMicTestManager == null) {
    AgentMicTestManager = new AudioInputTestManager(await getAudioContext());
  }
  return AgentMicTestManager;
}

async function replaceRTCSessionTrackManager(peerConnection) {
  if (RTCSessionTrackManager != null) {
    await RTCSessionTrackManager.dispose();
  }
  RTCSessionTrackManager = new SessionTrackManager(peerConnection, await getAudioContext());
}

async function replaceToCustomerAudioStreamManager() {
  if (ToCustomerAudioStreamManager != null) {
    await ToCustomerAudioStreamManager.dispose();
  }
  ToCustomerAudioStreamManager = new AudioStreamManager(CCP_V2V.UI.toCustomerAudioElement, await getAudioContext());
}

async function replaceToAgentAudioStreamManager() {
  if (ToAgentAudioStreamManager != null) {
    await ToAgentAudioStreamManager.dispose();
  }
  ToAgentAudioStreamManager = new AudioStreamManager(CCP_V2V.UI.toAgentAudioElement, await getAudioContext());
}

window.addEventListener("load", () => {
  initializeApp();
});

function isEmbeddedConnectApp() {
  if (window.self !== window.top) {
    return true;
  }
  if (document.referrer) {
    return document.referrer.includes(".my.connect.aws") || document.referrer.includes("awsapps.com");
  }
  return false;
}

async function initializeApp() {
  try {
    console.info(`${LOGGER_PREFIX} - initializeApp - Initializing app`);
    setRedirectURI();
    const embeddedConnectApp = isEmbeddedConnectApp();
    // Check if we're returning from Cognito login
    const isRedirect = await handleRedirect();
    if (isRedirect) {
      console.info(`${LOGGER_PREFIX} - initializeApp - Redirected from Cognito login`);
      startTokenRefreshTimer();
      showApp();
      return;
    }

    // Check authentication and token expiration
    if (!isAuthenticated() && !embeddedConnectApp) {
      const tokens = await getValidTokens();
      if (tokens?.accessToken == null || tokens?.idToken == null || tokens?.refreshToken == null) {
        // No valid token available, redirect to login
        console.info(`${LOGGER_PREFIX} - initializeApp - No valid token available, redirecting to login`);
        window.location.href = getLoginUrl();
        return;
      }
    }

    // Show app with valid token
    console.info(`${LOGGER_PREFIX} - initializeApp - Valid token available, showing app`);
    if (!embeddedConnectApp) {
      startTokenRefreshTimer();
    } else if (isAuthenticated()) {
      startTokenRefreshTimer();
    }
    showApp();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeApp - Error initializing app:`, error);
    if (!isEmbeddedConnectApp()) {
      window.location.href = getLoginUrl();
    } else {
      raiseError("Unable to initialize app. Please refresh the page.");
    }
  }
}

function showApp() {
  onLoad();
}

const onLoad = async () => {
  console.info(`${LOGGER_PREFIX} - index loaded`);
  bindUIElements();
  initEventListeners();
  if (!isEmbeddedConnectApp()) {
    CCP_V2V.UI.logoutButton.style.display = "block";
  }
  getDevices();
  setAudioElementsSinkIds();
  loadTranscribePartialResultsStability();
  setDetectedLanguageStatus("Waiting for contact...");
  CurrentLanguageConfig = LANGUAGE_PRESETS[DEFAULT_LANGUAGE_KEY];
  initCCP(onConnectInitialized);
};

const bindUIElements = () => {
  window.connect.CCP_V2V = CCP_V2V;

  CCP_V2V.UI = {
    logoutButton: document.getElementById("logoutButton"),
    ccpContainer: document.querySelector("#ccpContainer"),
    detectedLanguageStatus: document.getElementById("detectedLanguageStatus"),

    //mic & speaker UI elements
    micSelect: document.getElementById("micSelect"),
    speakerSelect: document.getElementById("speakerSelect"),

    fromCustomerAudioElement: document.getElementById("remote-audio"),
    toCustomerAudioElement: document.getElementById("toCustomerAudioElement"),
    toAgentAudioElement: document.getElementById("toAgentAudioElement"),

    testAudioButton: document.getElementById("testAudioButton"),
    testMicButton: document.getElementById("testMicButton"),

    //Transcribe Customer UI Elements
    customerStartTranscriptionButton: document.getElementById("customerStartTranscriptionButton"),
    customerStopTranscriptionButton: document.getElementById("customerStopTranscriptionButton"),
    customerTranscriptionTextOutputDiv: document.getElementById("customerTranscriptionTextOutputDiv"),

    //Transcribe Agent UI Elements
    agentStartTranscriptionButton: document.getElementById("agentStartTranscriptionButton"),
    agentStopTranscriptionButton: document.getElementById("agentStopTranscriptionButton"),
    agentTranscriptionTextOutputDiv: document.getElementById("agentTranscriptionTextOutputDiv"),

    //Transcript UI Elements
    divTranscriptContainer: document.getElementById("divTranscriptContainer"),
  };
};

const initEventListeners = () => {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    console.info(`${LOGGER_PREFIX} - devicechange event fired`);
    getDevices();
  });

  if (!isEmbeddedConnectApp()) {
    CCP_V2V.UI.logoutButton.addEventListener("click", logout);
  }

  //mic & speaker ui buttons
  CCP_V2V.UI.testAudioButton.addEventListener("click", testAudioOutput);
  CCP_V2V.UI.testMicButton.addEventListener("click", () => {
    if (CCP_V2V.UI.testMicButton.innerText === "Test") {
      testMicrophone();
      CCP_V2V.UI.testMicButton.innerText = "Stop";
    } else if (CCP_V2V.UI.testMicButton.innerText === "Stop") {
      stopTestMicrophone();
      CCP_V2V.UI.testMicButton.innerText = "Test";
    }
  });
  CCP_V2V.UI.speakerSelect.addEventListener("change", () => addUpdateLocalStorageKey("selectedSpeakerId", CCP_V2V.UI.speakerSelect.value));
  CCP_V2V.UI.micSelect.addEventListener("change", () => addUpdateLocalStorageKey("selectedMicId", CCP_V2V.UI.micSelect.value));
  CCP_V2V.UI.speakerSelect.addEventListener("change", setAudioElementsSinkIds);

  CCP_V2V.UI.customerStartTranscriptionButton.addEventListener("click", customerStartTranscription);
  CCP_V2V.UI.customerStopTranscriptionButton.addEventListener("click", customerStopTranscription);

  CCP_V2V.UI.agentStartTranscriptionButton.addEventListener("click", agentStartTranscription);

  CCP_V2V.UI.agentStopTranscriptionButton.addEventListener("click", agentStopTranscription);
};

const initCCP = async (onConnectInitialized) => {
  const { connectCCPURL } = getConnectURLS();
  if (!window.connect.core.initialized) {
    console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization started`);
    const embeddedConnectApp = isEmbeddedConnectApp();
    window.connect.core.initCCP(CCP_V2V.UI.ccpContainer, {
      ccpUrl: connectCCPURL,
      loginPopup: !embeddedConnectApp,
      loginPopupAutoClose: !embeddedConnectApp,
      loginOptions: {
        // optional, if provided opens login in new window
        autoClose: true, // optional, defaults to `false`
        height: 600, // optional, defaults to 578
        width: 400, // optional, defaults to 433
        top: 0, // optional, defaults to 0
        left: 0, // optional, defaults to 0
      },
      region: CONNECT_CONFIG.connectInstanceRegion,
      softphone: {
        allowFramedSoftphone: true, //use framed softphone when embedded
        allowFramedVideoCall: true, //allow the agent to add video to the call
        disableRingtone: false,
      },
      pageOptions: {
        enableAudioDeviceSettings: true,
        enableVideoDeviceSettings: true,
        enablePhoneTypeSettings: true,
      },
      shouldAddNamespaceToLogs: true,
    });

    window.connect.agent((agent) => {
      console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization completed`);
      if (onConnectInitialized) onConnectInitialized(agent);
    });
  } else {
    console.info(`${LOGGER_PREFIX} - Amazon Connect CCP Already Initialized`);
  }
};

const onConnectInitialized = (connectAgent) => {
  connect = window.connect;
  connect.core.initSoftphoneManager({ allowFramedSoftphone: true });

  const connectAgentConfiguration = connectAgent.getConfiguration();
  CurrentUser["currentUser_ConnectUsername"] = connectAgentConfiguration.username;

  subscribeToAgentEvents();
  subscribeToContactEvents();

  connect.core.onSoftphoneSessionInit(function ({ connectionId }) {
    ConnectSoftPhoneManager = connect.core.getSoftphoneManager();
    //console.info(`${LOGGER_PREFIX} - softphoneManager`, softphoneManager);
  });
};

function subscribeToAgentEvents() {
  // Subscribe to Agent Events from Streams API, and handle Agent events with functions defined above
  console.info(`${LOGGER_PREFIX} - subscribing to events for agent`);

  connect.agent((agent) => {
    agent.onLocalMediaStreamCreated(onAgentLocalMediaStreamCreated);
    // agent.onStateChange(agentStateChange);
    // agent.onRefresh(agentRefresh);
    // agent.onOffline(agentOffline);
  });
}

function subscribeToContactEvents() {
  // Subscribe to Contact Events from Streams API, and handle Contact events
  console.info(`${LOGGER_PREFIX} - subscribing to events for contact`);
  connect.contact((contact) => {
    console.info(`${LOGGER_PREFIX} - new contact`, contact);
    if (contact.getActiveInitialConnection() && contact.getActiveInitialConnection().getEndpoint()) {
      console.info(`${LOGGER_PREFIX} - new contact is from ${contact.getActiveInitialConnection().getEndpoint().phoneNumber}`);
    } else {
      console.info(`${LOGGER_PREFIX} - this is an existing contact for this agent`);
    }

    contact.onConnecting(onContactConnecting);
    contact.onConnected(onContactConnected);
    contact.onEnded(onContactEnded);
    contact.onDestroy(onContactDestroyed);
    // contact.onRefresh(contactRefreshed);
  });
}

function onContactConnecting(contact) {
  console.info(`${LOGGER_PREFIX} - contact is connecting`, contact);
}

function onContactConnected(contact) {
  console.info(`${LOGGER_PREFIX} - contact connected`, contact);

  CurrentContactId = contact.getContactId();
  applyLanguageConfigFromContact(contact);

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;
}

function onContactEnded(contact) {
  console.info(`${LOGGER_PREFIX} - contact has ended`, contact);
  CurrentAgentConnectionId = null;
  CurrentContactId = null;
  setDetectedLanguageStatus("Waiting for contact...");
  if (ToCustomerAudioStreamManager != null) {
    ToCustomerAudioStreamManager.dispose();
    ToCustomerAudioStreamManager = null;
  }
  if (ToAgentAudioStreamManager != null) {
    ToAgentAudioStreamManager.dispose();
    ToAgentAudioStreamManager = null;
  }
  if (RTCSessionTrackManager != null) {
    RTCSessionTrackManager.dispose();
    RTCSessionTrackManager = null;
  }
  customerStopTranscription();
  agentStopTranscription();
  cleanUpUI();
}

function onContactDestroyed(contact) {
  console.info(`${LOGGER_PREFIX} - contact has been destroyed`, contact);

  clearTranscriptCards();
}

function onAgentLocalMediaStreamCreated(data) {
  //console.info(`${LOGGER_PREFIX} - onAgentLocalMediaStreamCreated`, data);
  CurrentAgentConnectionId = data.connectionId;
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const peerConnection = session?._pc;
  replaceToCustomerAudioStreamManager();
  replaceToAgentAudioStreamManager();
  replaceRTCSessionTrackManager(peerConnection);
}

function setAudioElementsSinkIds() {
  CCP_V2V.UI.fromCustomerAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
  CCP_V2V.UI.toCustomerAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
  CCP_V2V.UI.toAgentAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
}

//Instead of streaming Microphone, stream an Audio File
function streamFile() {
  try {
    const fileStreamAudioTrack = RTCSessionTrackManager.createFileTrack("./assets/speech_20241113001759828.mp3");
    //console.info(`${LOGGER_PREFIX} - streamFile`, fileStreamAudioTrack);
    RTCSessionTrackManager.replaceTrack(fileStreamAudioTrack, TrackType.FILE);
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - streamFile`, error);
    raiseError(`Error steaming file: ${error}`);
  }
}

//Instead of streaming File, stream Mic
async function streamMic() {
  const selectedMic = CCP_V2V.UI.micSelect.value;
  if (!selectedMic) {
    raiseError("Please select a microphone!");
    return;
  }

  const micConstraints = getMicrophoneConstraints(selectedMic);
  const micStreamAudioTrack = await RTCSessionTrackManager.createMicTrack(micConstraints);
  //console.info(`${LOGGER_PREFIX} - streamMic`, micStreamAudioTrack);
  RTCSessionTrackManager.replaceTrack(micStreamAudioTrack, TrackType.MIC);
}

//Instead of removing AudioTrack, stream a silent AudioTrack
async function removeAudioTrack() {
  const silentTrack = RTCSessionTrackManager.createSilentTrack();
  // console.info(
  //   `${LOGGER_PREFIX} - removeAudioTrack - replacing with a silent track`
  // );
  RTCSessionTrackManager.replaceTrack(silentTrack, TrackType.SILENT);
}

async function testMicrophone() {
  const selectedMic = CCP_V2V.UI.micSelect.value;

  if (!selectedMic) {
    raiseError("Please select a microphone!");
    return;
  }

  try {
    // Request access to the selected microphone
    const micConstraints = getMicrophoneConstraints(selectedMic);
    const micStream = await navigator.mediaDevices.getUserMedia(micConstraints);

    const volumeBar = document.getElementById("volumeBar");
    const agentMicTestManager = await getAgentMicTestManager();
    agentMicTestManager.startAudioTest(micStream, volumeBar);
  } catch (err) {
    console.error(`${LOGGER_PREFIX} - testMicrophone - Error accessing microphone`, err);
    raiseError("Failed to access microphone.");
  }
}

async function stopTestMicrophone() {
  const agentMicTestManager = await getAgentMicTestManager();
  agentMicTestManager.stopAudioTest();
}

// Function to test the selected audio output device
function testAudioOutput() {
  const selectedSpeaker = CCP_V2V.UI.speakerSelect.value;
  if (!selectedSpeaker) {
    raiseError("Please select a speaker!");
    return;
  }

  // Create an audio context and set the output device using setSinkId()
  const audio = new Audio("/assets/chime-sound-7143.mp3");
  audio
    .setSinkId(selectedSpeaker)
    .then(() => {
      console.info(`${LOGGER_PREFIX} - testAudioOutput - Audio output device set successfully`);
      audio
        .play()
        .then(() => {
          console.info(`${LOGGER_PREFIX} - testAudioOutput - Audio played successfully`);
        })
        .catch((err) => {
          console.error(`${LOGGER_PREFIX} - testAudioOutput - Error playing audio:`, err);
          raiseError("Failed to play audio.");
        });
    })
    .catch((err) => {
      console.error(`${LOGGER_PREFIX} - testAudioOutput - Error setting output device:`, err);
      raiseError("Failed to set audio output device.");
    });
}

async function getDevices() {
  try {
    //check Microphone permission
    const micPermission = await navigator.permissions.query({ name: "microphone" });
    if (micPermission.state === "prompt") {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (micPermission.state === "denied") {
      raiseError("Microphone permission is denied. Please allow microphone access in your browser settings.");
      return;
    }

    // Get all media devices (input and output)
    const devices = await navigator.mediaDevices.enumerateDevices();

    // Arrays to store cam, mic and speaker devices
    const micDevices = [];
    const speakerDevices = [];

    // Loop through devices and filter by kind
    devices.forEach((device) => {
      if (device.kind === "audioinput") {
        micDevices.push(device);
      } else if (device.kind === "audiooutput") {
        speakerDevices.push(device);
      }
    });

    //raise an error if we only found devices without deviceId
    if (micDevices.every((device) => !device.deviceId)) {
      raiseError("No Microphone found. Please check your microphone and reload the page.");
      return;
    }

    if (speakerDevices.every((device) => !device.deviceId)) {
      raiseError("No Speaker found. Please check your speaker and reload the page.");
      return;
    }

    // Populate the microphone dropdown
    CCP_V2V.UI.micSelect.innerHTML = "";
    micDevices.forEach((mic) => {
      const option = document.createElement("option");
      option.value = mic.deviceId;
      option.textContent = mic.label || `Microphone ${mic.deviceId}`;
      CCP_V2V.UI.micSelect.appendChild(option);
    });

    //pre-select the Default mic
    const defaultMic = micDevices.find((mic) => mic.deviceId.startsWith("default"));
    if (defaultMic) {
      CCP_V2V.UI.micSelect.value = defaultMic.deviceId;
    }
    //pre-select the saved mic
    const savedMicId = getLocalStorageValueByKey("selectedMicId");
    if (savedMicId) {
      CCP_V2V.UI.micSelect.value = savedMicId;
    }

    // Populate the speaker dropdown
    CCP_V2V.UI.speakerSelect.innerHTML = "";
    speakerDevices.forEach((speaker) => {
      const option = document.createElement("option");
      option.value = speaker.deviceId;
      option.textContent = speaker.label || `Speaker ${speaker.deviceId}`;
      CCP_V2V.UI.speakerSelect.appendChild(option);
    });

    //pre-select the Default speaker
    const defaultSpeaker = speakerDevices.find((speaker) => speaker.deviceId.startsWith("default"));
    if (defaultSpeaker) {
      CCP_V2V.UI.speakerSelect.value = defaultSpeaker.deviceId;
    }
    //pre-select the saved speaker
    const savedSpeakerId = getLocalStorageValueByKey("selectedSpeakerId");
    if (savedSpeakerId) {
      CCP_V2V.UI.speakerSelect.value = savedSpeakerId;
    }
  } catch (err) {
    console.error(`${LOGGER_PREFIX} - getDevices - Error accessing devices:`, err);
  }
}

 

function loadTranscribePartialResultsStability() {
  const defaultStability = TRANSCRIBE_PARTIAL_RESULTS_STABILITY.includes(DEFAULT_PARTIAL_RESULT_STABILITY)
    ? DEFAULT_PARTIAL_RESULT_STABILITY
    : TRANSCRIBE_PARTIAL_RESULTS_STABILITY[0] ?? "none";
  CustomerPartialResultsStability = defaultStability;
  AgentPartialResultsStability = defaultStability;
}

function setDetectedLanguageStatus(text) {
  if (CCP_V2V.UI.detectedLanguageStatus) {
    CCP_V2V.UI.detectedLanguageStatus.textContent = text;
  }
}

function applyLanguageConfigFromContact(contact) {
  const languageKey = resolveLanguageKeyFromContact(contact);
  const resolvedKey = LANGUAGE_PRESETS[languageKey] ? languageKey : DEFAULT_LANGUAGE_KEY;
  CurrentLanguageConfig = LANGUAGE_PRESETS[resolvedKey];
  if (resolvedKey !== languageKey) {
    setDetectedLanguageStatus(`${CurrentLanguageConfig.label} (defaulted)`);
  } else {
    setDetectedLanguageStatus(`${CurrentLanguageConfig.label} (auto-detected)`);
  }
}

function resolveLanguageKeyFromContact(contact) {
  if (!contact?.getAttributes) {
    return DEFAULT_LANGUAGE_KEY;
  }
  const attributes = contact.getAttributes() ?? {};
  for (const key of LANGUAGE_ATTRIBUTE_KEYS) {
    const attribute = attributes[key];
    const value = attribute?.value ?? attribute?.Value ?? attribute?.valueString ?? attribute?.ValueString;
    if (value) {
      const normalizedValue = String(value).trim().toLowerCase();
      return LANGUAGE_VALUE_MAP[normalizedValue] ?? normalizedValue;
    }
  }
  return DEFAULT_LANGUAGE_KEY;
}

//Creates Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
async function captureFromCustomerAudioStream() {
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const audioStream = session?._remoteAudioStream;
  if (audioStream == null) {
    console.error(`${LOGGER_PREFIX} - captureFromCustomerAudioStream - No audio stream found from customer`);
    throw new Error("No audio stream found from customer, please check you browser sound settings");
  }

  const audioContext = await getAudioContext();
  const amazonTranscribeFromCustomerAudioStream = new MicrophoneStream({ audioContext });
  amazonTranscribeFromCustomerAudioStream.setStream(audioStream);
  return amazonTranscribeFromCustomerAudioStream;
}

async function customerStartTranscription() {
  try {
    IsCustomerTranscribing = true;
    if (!CurrentLanguageConfig) {
      CurrentLanguageConfig = LANGUAGE_PRESETS[DEFAULT_LANGUAGE_KEY];
      setDetectedLanguageStatus(`${CurrentLanguageConfig.label} (default)`);
    }
    if (STREAM_CUSTOMER_MIC_TO_AGENT) {
      CCP_V2V.UI.fromCustomerAudioElement.volume = 0.3;
      CCP_V2V.UI.fromCustomerAudioElement.muted = false;
    } else {
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }

    //Play the audio feedback to customer
    if (ENABLE_CUSTOMER_AUDIO_FEEDBACK) {
      ToCustomerAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    //getting the remote audio stream from the current RTC session into AmazonTranscribeFromCustomerAudioStream variable
    AmazonTranscribeFromCustomerAudioStream = await captureFromCustomerAudioStream();
    const customerStreamSampleRate = (await getAudioContext()).sampleRate;
    const customerTargetSampleRate = getAutoSelectedSampleRate(customerStreamSampleRate);
    console.info(
      `${LOGGER_PREFIX} - customerStartTranscription - AmazonTranscribeFromCustomerAudioStream Sample Rate: ${customerStreamSampleRate}, target: ${customerTargetSampleRate}`
    );

    startCustomerStreamTranscription(
      AmazonTranscribeFromCustomerAudioStream,
      customerStreamSampleRate,
      CurrentLanguageConfig.customer.transcribeLanguage,
      CustomerPartialResultsStability,
      handleCustomerTranscript,
      handleCustomerPartialTranscript,
      {
        shouldStop: () => !IsCustomerTranscribing,
        onRetry: (details) => handleTranscribeRetry("customer", details),
        targetSampleRate: customerTargetSampleRate,
      }
    );

    CCP_V2V.UI.customerStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.customerStopTranscriptionButton.disabled = false;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - customerStartTranscription - Error starting customer transcription:`, error);
    raiseError(`Error starting customer transcription: ${error}`);
    IsCustomerTranscribing = false;
  }
}

async function customerStopTranscription() {
  IsCustomerTranscribing = false;
  if (AmazonTranscribeFromCustomerAudioStream) {
    //replace the stream with a silent stream
    const audioContext = await getAudioContext();
    const silentStream = audioContext.createMediaStreamDestination().stream;
    AmazonTranscribeFromCustomerAudioStream.setStream(silentStream);
    AmazonTranscribeFromCustomerAudioStream.stop();
    AmazonTranscribeFromCustomerAudioStream.destroy();
    AmazonTranscribeFromCustomerAudioStream = undefined;
  }

  //un-mute the audio element
  CCP_V2V.UI.fromCustomerAudioElement.muted = false;

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.customerStopTranscriptionButton.disabled = true;
}

async function agentStartTranscription() {
  try {
    IsAgentTranscribing = true;
    if (!CurrentLanguageConfig) {
      CurrentLanguageConfig = LANGUAGE_PRESETS[DEFAULT_LANGUAGE_KEY];
      setDetectedLanguageStatus(`${CurrentLanguageConfig.label} (default)`);
    }
    const selectedMic = CCP_V2V.UI.micSelect.value;
    const micConstraints = getMicrophoneConstraints(selectedMic);

    if (ENABLE_AGENT_AUDIO_FEEDBACK) {
      ToAgentAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    if (STREAM_AGENT_MIC_TO_CUSTOMER) {
      await ToCustomerAudioStreamManager.startMicrophone(micConstraints);
      ToCustomerAudioStreamManager.setMicrophoneVolume(DEFAULT_MIC_VOLUME);
    }

    //getting the local Mic stream into AmazonTranscribeMicStream variable
    const audioContext = await getAudioContext();
    AmazonTranscribeToCustomerAudioStream = await createMicrophoneStream(micConstraints, audioContext);
    const agentStreamSampleRate = audioContext.sampleRate;
    const agentTargetSampleRate = getAutoSelectedSampleRate(agentStreamSampleRate);
    console.info(
      `${LOGGER_PREFIX} - agentStartTranscription - AmazonTranscribeToCustomerAudioStream Sample Rate: ${agentStreamSampleRate}, target: ${agentTargetSampleRate}`
    );

    startAgentStreamTranscription(
      AmazonTranscribeToCustomerAudioStream,
      agentStreamSampleRate,
      CurrentLanguageConfig.agent.transcribeLanguage,
      AgentPartialResultsStability,
      handleAgentTranscript,
      handleAgentPartialTranscript,
      {
        shouldStop: () => !IsAgentTranscribing,
        onRetry: (details) => handleTranscribeRetry("agent", details),
        targetSampleRate: agentTargetSampleRate,
      }
    );

    CCP_V2V.UI.agentStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.agentStopTranscriptionButton.disabled = false;

    disableMicrophoneAndSpeakerSelection();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - agentStartTranscription - Error starting agent transcription:`, error);
    raiseError(`Error starting agent transcription: ${error}`);
    IsAgentTranscribing = false;
  }
}

async function agentStopTranscription() {
  IsAgentTranscribing = false;
  if (AmazonTranscribeToCustomerAudioStream) {
    //replace the stream with a silent stream
    const audioContext = await getAudioContext();
    const silentStream = audioContext.createMediaStreamDestination().stream;
    AmazonTranscribeToCustomerAudioStream.setStream(silentStream);
    AmazonTranscribeToCustomerAudioStream.stop();
    AmazonTranscribeToCustomerAudioStream.destroy();
    AmazonTranscribeToCustomerAudioStream = undefined;
  }

  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStopTranscriptionButton.disabled = true;

  enableMicrophoneAndSpeakerSelection();
}

 

async function handleCustomerPartialTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;
  //update CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv, "bg-pale-yellow");
    CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);
}

async function handleCustomerTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  //update CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv, "bg-pale-green");
    CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);

  const fromLanguage = CurrentLanguageConfig.customer.translateLanguage;
  const toLanguage = CurrentLanguageConfig.agent.translateLanguage;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - handleCustomerTranscript - Error translating text:`, error);
    raiseError(`Error translating text: ${error}`);
    return null;
  });

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeCustomerVoice(translatedText);
    setTimeout(() => {
      addTranscriptCard(inputText, translatedText, "toAgent");
    }, 100);

  }
}

async function handleAgentPartialTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;
  //update CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv, "bg-pale-yellow");
    CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);
}

async function handleAgentTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  //update CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv, "bg-pale-green");
    CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);

  const fromLanguage = CurrentLanguageConfig.agent.translateLanguage;
  const toLanguage = CurrentLanguageConfig.customer.translateLanguage;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    setTimeout(() => {
      addTranscriptCard(inputText, translatedText, "fromAgent");
    }, 100);

  }
}


async function synthesizeCustomerVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const { languageCode, engine, voiceId } = CurrentLanguageConfig.agent.polly;

  const synthetizedSpeech = await synthesizeSpeech(languageCode, engine, voiceId, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - synthesizeCustomerVoice - Error synthesizing speech:`, error);
    raiseError(`Error synthesizing speech: ${error}`);
    return null;
  });
  if (!synthetizedSpeech) return;

  //Play Customer Speech to Agent
  const audioContentArrayBufferPrimary = base64ToArrayBuffer(synthetizedSpeech);
  if (ToAgentAudioStreamManager != null) {
    ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferPrimary);
  }

  //Play Customer Speech to Customer
  if (STREAM_CUSTOMER_TRANSLATION_TO_CUSTOMER) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    if (ToCustomerAudioStreamManager != null) {
      ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME);
    }
  }
}

async function synthesizeAgentVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const { languageCode, engine, voiceId } = CurrentLanguageConfig.customer.polly;

  const synthetizedSpeech = await synthesizeSpeech(languageCode, engine, voiceId, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - synthesizeAgentVoice - Error synthesizing speech:`, error);
    raiseError(`Error synthesizing speech: ${error}`);
    return null;
  });
  if (!synthetizedSpeech) return;

  //Play Agent Speech to Customer
  const audioContentArrayBufferPrimary = base64ToArrayBuffer(synthetizedSpeech);
  if (ToCustomerAudioStreamManager != null) {
    ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferPrimary);
  }

  //Play Agent Speech to Agent
  if (STREAM_AGENT_TRANSLATION_TO_AGENT) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    if (ToAgentAudioStreamManager != null) {
      ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, AGENT_TRANSLATION_TO_AGENT_VOLUME);
    }
  }
}

function cleanUpUI() {
  CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = "";
  setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv);

  CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = "";
  setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv);

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = true;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = true;

  enableMicrophoneAndSpeakerSelection();
}

function raiseError(errorMessage) {
  alert(`${errorMessage}`);
}

function setBackgroundColour(element, cssClass) {
  // Remove all background classes first
  element.classList.remove("bg-pale-green", "bg-pale-yellow", "bg-none");

  // Add the requested background if specified
  if (cssClass) {
    element.classList.add(cssClass);
  }
}

function addTranscriptCard(originalTranscript, translatedTranscript, type) {
  const card = document.createElement("div");
  card.className = `transcript-card ${type}`; // type is either 'fromAgent' or 'toAgent'

  // Create original text element
  const originalText = document.createElement("div");
  originalText.className = "transcript-original";
  originalText.textContent = originalTranscript;

  // Create separator
  const separator = document.createElement("div");
  separator.className = "transcript-separator";

  // Create translated text element
  const translatedText = document.createElement("div");
  translatedText.className = "transcript-translated";
  translatedText.textContent = translatedTranscript;

  // Append all elements to the card
  card.appendChild(originalText);
  card.appendChild(separator);
  card.appendChild(translatedText);

  CCP_V2V.UI.divTranscriptContainer.insertBefore(card, CCP_V2V.UI.divTranscriptContainer.lastChild);

  // Auto scroll to the bottom
  CCP_V2V.UI.divTranscriptContainer.scrollTop = CCP_V2V.UI.divTranscriptContainer.scrollHeight;
}

function getAutoSelectedSampleRate(inputSampleRate) {
  try {
    const navigatorRef = typeof navigator !== "undefined" ? navigator : null;
    const connection = navigatorRef?.connection || navigatorRef?.mozConnection || navigatorRef?.webkitConnection;
    if (!connection) {
      return Math.min(inputSampleRate, TRANSCRIBE_TARGET_SAMPLE_RATE);
    }

    const { effectiveType, downlink, rtt, saveData } = connection;
    if (saveData === true) {
      return Math.min(inputSampleRate, TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS.low);
    }

    if (effectiveType === "slow-2g" || effectiveType === "2g") {
      return Math.min(inputSampleRate, TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS.low);
    }

    if (effectiveType === "3g" || (typeof downlink === "number" && downlink < 1.5) || (typeof rtt === "number" && rtt > 300)) {
      return Math.min(inputSampleRate, TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS.medium);
    }

    return Math.min(inputSampleRate, TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS.high);
  } catch (error) {
    console.warn(`${LOGGER_PREFIX} - getAutoSelectedSampleRate - Falling back to default sample rate`, error);
    return Math.min(inputSampleRate, TRANSCRIBE_TARGET_SAMPLE_RATE);
  }
}

function handleTranscribeRetry(target, details) {
  const message = `Reconnecting transcription (attempt ${details.attempt})...`;
  if (target === "customer") {
    setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv, "bg-pale-yellow");
    CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = message;
    return;
  }

  if (target === "agent") {
    setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv, "bg-pale-yellow");
    CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = message;
  }
}

function clearTranscriptCards() {
  const container = CCP_V2V.UI.divTranscriptContainer;

  // Remove all children except the last one (spacer)
  document.querySelectorAll(".transcript-container .transcript-card").forEach((card) => card.remove());
}

function getMicrophoneConstraints(deviceId) {
  let microphoneConstraints = {
    audio: {
      deviceId: deviceId,
      echoCancellation: DEFAULT_ECHO_CANCELLATION,
      noiseSuppression: DEFAULT_NOISE_SUPPRESSION,
      autoGainControl: DEFAULT_AUTO_GAIN_CONTROL,
    },
  };

  console.info(`${LOGGER_PREFIX} - getMicrophoneConstraints: ${JSON.stringify(microphoneConstraints)}`);
  return microphoneConstraints;
}

function enableMicrophoneAndSpeakerSelection() {
  CCP_V2V.UI.micSelect.disabled = false;
  CCP_V2V.UI.speakerSelect.disabled = false;

  CCP_V2V.UI.testAudioButton.disabled = false;

  CCP_V2V.UI.testMicButton.disabled = false;
}

function disableMicrophoneAndSpeakerSelection() {
  CCP_V2V.UI.micSelect.disabled = true;
  CCP_V2V.UI.speakerSelect.disabled = true;

  CCP_V2V.UI.testAudioButton.disabled = true;

  CCP_V2V.UI.testMicButton.disabled = true;
}
