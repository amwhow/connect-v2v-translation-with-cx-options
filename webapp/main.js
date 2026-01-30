// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import "./style.css";
import "amazon-connect-streams";

import MicrophoneStream from "microphone-stream";

import { getConnectURLS, getLocalStorageValueByKey, base64ToArrayBuffer, isStringUndefinedNullEmpty } from "./utils/commonUtility";
import {
  AGENT_TRANSLATION_TO_AGENT_VOLUME,
  AUDIO_FEEDBACK_FILE_PATH,
  CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME,
  LOGGER_PREFIX,
  TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS,
  TRANSCRIBE_PARTIAL_RESULTS_STABILITY,
  TRANSCRIBE_TARGET_SAMPLE_RATE,
} from "./constants";
import { decodeToken, getLoginUrl, getValidTokens, handleRedirect, hasValidAwsCredentials, isAuthenticated, logout, setRedirectURI, startTokenRefreshTimer } from "./utils/authUtility";
import { AudioStreamManager } from "./managers/AudioStreamManager";
import { SessionTrackManager, TrackType } from "./managers/SessionTrackManager";
import { createMicrophoneStream } from "./utils/transcribeUtils";
import { listTranslateLanguages, translateText } from "./adapters/translateAdapter";
import { describeVoices, listPollyEngines, listPollyLanguages, synthesizeSpeech } from "./adapters/pollyAdapter";
import { listStreamingLanguages, startAgentStreamTranscription, startCustomerStreamTranscription } from "./adapters/transcribeAdapter";
import { CONNECT_CONFIG, TRANSCRIPT_STORAGE_CONFIG } from "./config";
import { AudioContextManager } from "./managers/AudioContextManager";
import { AudioInputTestManager } from "./managers/InputTestManager";
import { createStatusIndicator } from "./StatusIndicator";
import { createDiagnosticsPanel } from "./DiagnosticsPanel";

let connect = {};
let CurrentUser = {};
let CCP_V2V = {};

let CurrentAgentConnectionId;
let ConnectSoftPhoneManager;
let IsAgentTranscriptionMuted = false;
let IsCustomerTranscribing = false;
let IsAgentTranscribing = false;

const CONNECT_LANGUAGE_ATTRIBUTE_KEY = "language";
const DEFAULT_CUSTOMER_LANGUAGE = "en-US";
const DEFAULT_TRANSLATE_LANGUAGE = "en";
const DEFAULT_POLLY_LANGUAGE = "en-US";
const DEFAULT_POLLY_VOICE = "Joanna";
const DEFAULT_POLLY_ENGINE = "neural";
const LANGUAGE_ATTRIBUTE_CONFIG = {
  "fr-ca": {
    transcribeCustomer: "fr-CA",
    translateCustomer: "fr",
    pollyCustomer: "en-US",
    pollyCustomerVoice: "Joanna",
    translateAgentTo: "fr",
    pollyAgent: "fr-CA",
    pollyAgentVoice: "Gabrielle",
  },
  "es": {
    transcribeCustomer: "es-US",
    translateCustomer: "es",
    pollyCustomer: "en-US",
    pollyCustomerVoice: "Joanna",
    translateAgentTo: "es",
    pollyAgent: "es-US",
    pollyAgentVoice: "Lupe",
  },
  "en": {
    transcribeCustomer: "en-US",
    translateCustomer: "en",
    pollyCustomer: "en-US",
    pollyCustomerVoice: "Joanna",
    translateAgentTo: "en",
    pollyAgent: "en-US",
    pollyAgentVoice: "Joanna",
  },
};

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

let StatusIndicatorComponent;
let DiagnosticsPanel;

const DIAGNOSTIC_FACTORS = [
  {
    key: "firewall",
    label: "Enterprise Firewall",
    detail: "WebSocket blocked? Try a personal hotspot to confirm.",
  },
  {
    key: "latency",
    label: "Latency & Region Distance",
    detail: "High latency/jitter can delay WSS handshake.",
  },
  {
    key: "browserPermissions",
    label: "Browser Permissions",
    detail: "Microphone access must be allowed.",
  },
  {
    key: "audioStream",
    label: "Audio Stream",
    detail: "Check mic stream and sample rate.",
  },
  {
    key: "credentials",
    label: "Cognito Credentials",
    detail: "Expired tokens will block Transcribe.",
  },
];

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

async function initializeApp() {
  try {
    console.info(`${LOGGER_PREFIX} - initializeApp - Initializing app`);
    setRedirectURI();
    // Check if we're returning from Cognito login
    const isRedirect = await handleRedirect();
    if (isRedirect) {
      console.info(`${LOGGER_PREFIX} - initializeApp - Redirected from Cognito login`);
      startTokenRefreshTimer();
      showApp();
      return;
    }

    // Check authentication and token expiration
    if (!isAuthenticated()) {
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
    startTokenRefreshTimer();
    showApp();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeApp - Error initializing app:`, error);
    window.location.href = getLoginUrl();
  }
}

function showApp() {
  onLoad();
}

const onLoad = async () => {
  console.info(`${LOGGER_PREFIX} - index loaded`);
  bindUIElements();
  StatusIndicatorComponent = createStatusIndicator(CCP_V2V.UI.statusIndicatorContainer);
  StatusIndicatorComponent.setIdle();
  DiagnosticsPanel = createDiagnosticsPanel(CCP_V2V.UI.diagnosticsContainer, DIAGNOSTIC_FACTORS);
  DiagnosticsPanel.setAllUnknown();
  updateCredentialDiagnostics();
  initEventListeners();
  CCP_V2V.UI.logoutButton.style.display = "block";
  getDevices();
  setAudioElementsSinkIds();
  loadTranscribeLanguageCodes();
  loadTranscribePartialResultsStability();
  loadTranslateLanguageCodes();
  loadPollyEngines();
  loadPollyLanguageCodes();
  loadCustomerPollyVoiceIds().then(loadAgentPollyVoiceIds);
  initCCP(onConnectInitialized);
};

const bindUIElements = () => {
  window.connect.CCP_V2V = CCP_V2V;

  CCP_V2V.UI = {
    logoutButton: document.getElementById("logoutButton"),
    divInstanceSetup: document.getElementById("divInstanceSetup"),
    divMain: document.getElementById("divMain"),
    statusIndicatorContainer: document.getElementById("statusIndicatorContainer"),
    diagnosticsContainer: document.getElementById("diagnosticsContainer"),

    ccpContainer: document.querySelector("#ccpContainer"),

    spnCurrentConnectInstanceURL: document.getElementById("spnCurrentConnectInstanceURL"),
    tbConnectInstanceURL: document.getElementById("tbConnectInstanceURL"),
    btnSetConnectInstanceURL: document.getElementById("btnSetConnectInstanceURL"),
    btnStreamFile: document.getElementById("btnStreamFile"),
    btnStreamMic: document.getElementById("btnStreamMic"),
    btnRemoveAudioStream: document.getElementById("btnRemoveAudioStream"),

    //mic & speaker UI elements
    micSelect: document.getElementById("micSelect"),
    speakerSelect: document.getElementById("speakerSelect"),

    fromCustomerAudioElement: document.getElementById("remote-audio"),
    toCustomerAudioElement: document.getElementById("toCustomerAudioElement"),
    toAgentAudioElement: document.getElementById("toAgentAudioElement"),

    testAudioButton: document.getElementById("testAudioButton"),
    testMicButton: document.getElementById("testMicButton"),

    echoCancellationCheckbox: document.getElementById("echoCancellationCheckbox"),
    noiseSuppressionCheckbox: document.getElementById("noiseSuppressionCheckbox"),
    autoGainControlCheckbox: document.getElementById("autoGainControlCheckbox"),

    //Transcribe Customer UI Elements
    customerTranscribeLanguageSelect: document.getElementById("customerTranscribeLanguageSelect"),
    customerTranscribePartialResultsStabilitySelect: document.getElementById("customerTranscribePartialResultsStabilitySelect"),
    customerStartTranscriptionButton: document.getElementById("customerStartTranscriptionButton"),
    customerStopTranscriptionButton: document.getElementById("customerStopTranscriptionButton"),
    customerTranscriptionTextOutputDiv: document.getElementById("customerTranscriptionTextOutputDiv"),
    customerStreamMicCheckbox: document.getElementById("customerStreamMicCheckbox"),
    customerStreamTranslationCheckbox: document.getElementById("customerStreamTranslationCheckbox"),
    customerAudioFeedbackEnabledCheckbox: document.getElementById("customerAudioFeedbackEnabledCheckbox"),
    //Translate Customer UI Elements
    customerTranslateFromLanguageSelect: document.getElementById("customerTranslateFromLanguageSelect"),
    customerTranslateToLanguageSelect: document.getElementById("customerTranslateToLanguageSelect"),
    customerTranslatedTextOutputDiv: document.getElementById("customerTranslatedTextOutputDiv"),
    //Polly Customer UI Elements
    customerPollyLanguageCodeSelect: document.getElementById("customerPollyLanguageCodeSelect"),
    customerPollyEngineSelect: document.getElementById("customerPollyEngineSelect"),
    customerPollyVoiceIdSelect: document.getElementById("customerPollyVoiceIdSelect"),

    //Transcribe Agent UI Elements
    agentTranscribeLanguageSelect: document.getElementById("agentTranscribeLanguageSelect"),
    agentTranscribePartialResultsStabilitySelect: document.getElementById("agentTranscribePartialResultsStabilitySelect"),
    agentStartTranscriptionButton: document.getElementById("agentStartTranscriptionButton"),
    agentStopTranscriptionButton: document.getElementById("agentStopTranscriptionButton"),
    agentMuteTranscriptionButton: document.getElementById("agentMuteTranscriptionButton"),
    agentTranscriptionTextOutputDiv: document.getElementById("agentTranscriptionTextOutputDiv"),
    agentAudioFeedbackEnabledCheckbox: document.getElementById("agentAudioFeedbackEnabledCheckbox"),
    agentStreamMicCheckbox: document.getElementById("agentStreamMicCheckbox"),
    agentStreamMicVolume: document.getElementById("agentStreamMicVolume"),
    agentStreamTranslationCheckbox: document.getElementById("agentStreamTranslationCheckbox"),
    //Translate Agent UI Elements
    agentTranslateFromLanguageSelect: document.getElementById("agentTranslateFromLanguageSelect"),
    agentTranslateToLanguageSelect: document.getElementById("agentTranslateToLanguageSelect"),
    agentTranslateTextInput: document.getElementById("agentTranslateTextInput"),
    agentTranslateTextButton: document.getElementById("agentTranslateTextButton"),
    agentTranslatedTextOutputDiv: document.getElementById("agentTranslatedTextOutputDiv"),
    //Polly Agent UI Elements
    agentPollyLanguageCodeSelect: document.getElementById("agentPollyLanguageCodeSelect"),
    agentPollyEngineSelect: document.getElementById("agentPollyEngineSelect"),
    agentPollyVoiceIdSelect: document.getElementById("agentPollyVoiceIdSelect"),
    agentPollyTextInput: document.getElementById("agentPollyTextInput"),
    agentSynthesizeSpeechButton: document.getElementById("agentSynthesizeSpeechButton"),

    //Transcript UI Elements
    divTranscriptContainer: document.getElementById("divTranscriptContainer"),
  };
};

const initEventListeners = () => {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    console.info(`${LOGGER_PREFIX} - devicechange event fired`);
    getDevices();
  });

  CCP_V2V.UI.logoutButton.addEventListener("click", logout);

  CCP_V2V.UI.btnStreamFile.addEventListener("click", streamFile);
  CCP_V2V.UI.btnStreamMic.addEventListener("click", streamMic);
  CCP_V2V.UI.btnRemoveAudioStream.addEventListener("click", removeAudioTrack);

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

  //Transcribe Customer UI buttons
  CCP_V2V.UI.customerStartTranscriptionButton.addEventListener("click", customerStartTranscription);
  CCP_V2V.UI.customerStopTranscriptionButton.addEventListener("click", customerStopTranscription);

  CCP_V2V.UI.customerStreamMicCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      CCP_V2V.UI.fromCustomerAudioElement.muted = false;
    } else {
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }
  });

  CCP_V2V.UI.customerAudioFeedbackEnabledCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    } else {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.disableAudioFeedback();
    }
  });

  CCP_V2V.UI.customerPollyLanguageCodeSelect.addEventListener("change", loadCustomerPollyVoiceIds);
  CCP_V2V.UI.customerPollyEngineSelect.addEventListener("change", loadCustomerPollyVoiceIds);

  //Transcribe Agent UI buttons
  CCP_V2V.UI.agentStartTranscriptionButton.addEventListener("click", agentStartTranscription);

  CCP_V2V.UI.agentStopTranscriptionButton.addEventListener("click", agentStopTranscription);

  CCP_V2V.UI.agentMuteTranscriptionButton.addEventListener("click", () => {
    CCP_V2V.UI.agentMuteTranscriptionButton.textContent = IsAgentTranscriptionMuted ? "Unmute" : "Mute";
    toggleAgentTranscriptionMute();
  });

  CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      if (ToAgentAudioStreamManager != null) ToAgentAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    } else {
      if (ToAgentAudioStreamManager != null) ToAgentAudioStreamManager.disableAudioFeedback();
    }
  });

  CCP_V2V.UI.agentStreamMicCheckbox.addEventListener("change", (event) => {
    const selectedMic = CCP_V2V.UI.micSelect.value;
    const micConstraints = getMicrophoneConstraints(selectedMic);
    if (event.target.checked) {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.startMicrophone(micConstraints);
    } else {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.stopMicrophone();
    }
  });

  CCP_V2V.UI.agentStreamMicVolume.addEventListener("input", (event) => {
    const micVolume = parseFloat(event.target.value);
    if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.setMicrophoneVolume(micVolume);
  });

  CCP_V2V.UI.agentTranslateTextButton.addEventListener("click", handleAgentTranslateText);
  CCP_V2V.UI.agentTranslateTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleAgentTranslateText();
    }
  });
  CCP_V2V.UI.agentPollyLanguageCodeSelect.addEventListener("change", loadAgentPollyVoiceIds);
  CCP_V2V.UI.agentPollyEngineSelect.addEventListener("change", loadAgentPollyVoiceIds);
  CCP_V2V.UI.agentSynthesizeSpeechButton.addEventListener("click", handleAgentSynthesizeSpeech);
  CCP_V2V.UI.agentPollyTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleAgentSynthesizeSpeech();
    }
  });
};

const initCCP = async (onConnectInitialized) => {
  const { connectCCPURL } = getConnectURLS();
  if (!window.connect.core.initialized) {
    console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization started`);
    window.connect.core.initCCP(CCP_V2V.UI.ccpContainer, {
      ccpUrl: connectCCPURL,
      loginPopup: true,
      loginPopupAutoClose: true,
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
        allowFramedSoftphone: false, //we don't want the default softphone
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

function getContactAttributeValue(contact, attributeKey) {
  const attributes = contact?.getAttributes?.();
  if (isStringUndefinedNullEmpty(attributeKey) || attributes == null) {
    return undefined;
  }

  const attributeKeyLower = attributeKey.toLowerCase();
  const attributeEntry = Object.entries(attributes).find(([key]) => key.toLowerCase() === attributeKeyLower);
  if (!attributeEntry) {
    return undefined;
  }

  const [, attributeValue] = attributeEntry;
  if (typeof attributeValue === "string") {
    return attributeValue;
  }

  if (attributeValue?.value != null) {
    return attributeValue.value;
  }

  if (attributeValue?.Value != null) {
    return attributeValue.Value;
  }

  return undefined;
}

function resolveLanguageAttributeValue(rawValue) {
  if (isStringUndefinedNullEmpty(rawValue)) {
    return "en";
  }

  const normalizedValue = rawValue.toString().trim().toLowerCase();
  if (normalizedValue.includes("french")) {
    return "fr-ca";
  }

  if (normalizedValue.includes("spanish") || normalizedValue.startsWith("es")) {
    return "es";
  }

  if (normalizedValue.startsWith("fr")) {
    return "fr-ca";
  }

  return "en";
}

function getLanguageDisplayLabel(languageKey) {
  switch (languageKey) {
    case "fr-ca":
      return "French (Canada)";
    case "es":
      return "Spanish";
    default:
      return "English";
  }
}

function setSelectValueIfAvailable(selectElement, value) {
  if (!selectElement || isStringUndefinedNullEmpty(value)) return false;
  const matchingOption = Array.from(selectElement.options).find((option) => option.value === value);
  if (matchingOption) {
    selectElement.value = value;
    return true;
  }
  if (selectElement.options.length > 0) {
    selectElement.selectedIndex = 0;
  }
  return false;
}

function selectPreferredPollyEngine(selectElement) {
  if (!selectElement) return;
  const preferredEngines = [DEFAULT_POLLY_ENGINE, "standard"];
  const selected = preferredEngines.find((engine) => setSelectValueIfAvailable(selectElement, engine));
  if (!selected && selectElement.options.length > 0) {
    selectElement.selectedIndex = 0;
  }
}

function selectPreferredVoice(selectElement, preferredVoiceIds = []) {
  if (!selectElement) return;
  const availableVoiceIds = Array.from(selectElement.options).map((option) => option.value);
  const preferredVoiceId = preferredVoiceIds.find((voiceId) => availableVoiceIds.includes(voiceId));
  if (preferredVoiceId) {
    selectElement.value = preferredVoiceId;
    return;
  }
  if (!availableVoiceIds.includes(selectElement.value) && selectElement.options.length > 0) {
    selectElement.selectedIndex = 0;
  }
}

async function waitForSelectOptions(selectElement, timeoutMs = 4000) {
  const start = Date.now();
  while (selectElement && selectElement.options.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function applyLanguageSelectionForContact(contact) {
  const rawLanguageValue = getContactAttributeValue(contact, CONNECT_LANGUAGE_ATTRIBUTE_KEY);
  const resolvedLanguageKey = resolveLanguageAttributeValue(rawLanguageValue);
  const languageConfig = LANGUAGE_ATTRIBUTE_CONFIG[resolvedLanguageKey] ?? LANGUAGE_ATTRIBUTE_CONFIG.en;
  const languageLabel = getLanguageDisplayLabel(resolvedLanguageKey);

  await Promise.all([
    waitForSelectOptions(CCP_V2V.UI.customerTranscribeLanguageSelect),
    waitForSelectOptions(CCP_V2V.UI.agentTranscribeLanguageSelect),
    waitForSelectOptions(CCP_V2V.UI.customerTranslateFromLanguageSelect),
    waitForSelectOptions(CCP_V2V.UI.customerTranslateToLanguageSelect),
    waitForSelectOptions(CCP_V2V.UI.agentTranslateFromLanguageSelect),
    waitForSelectOptions(CCP_V2V.UI.agentTranslateToLanguageSelect),
    waitForSelectOptions(CCP_V2V.UI.customerPollyLanguageCodeSelect),
    waitForSelectOptions(CCP_V2V.UI.agentPollyLanguageCodeSelect),
    waitForSelectOptions(CCP_V2V.UI.customerPollyEngineSelect),
    waitForSelectOptions(CCP_V2V.UI.agentPollyEngineSelect),
  ]);

  setSelectValueIfAvailable(CCP_V2V.UI.customerTranscribeLanguageSelect, languageConfig.transcribeCustomer ?? DEFAULT_CUSTOMER_LANGUAGE);
  setSelectValueIfAvailable(CCP_V2V.UI.agentTranscribeLanguageSelect, DEFAULT_CUSTOMER_LANGUAGE);

  setSelectValueIfAvailable(CCP_V2V.UI.customerTranslateFromLanguageSelect, languageConfig.translateCustomer ?? DEFAULT_TRANSLATE_LANGUAGE);
  setSelectValueIfAvailable(CCP_V2V.UI.customerTranslateToLanguageSelect, DEFAULT_TRANSLATE_LANGUAGE);

  setSelectValueIfAvailable(CCP_V2V.UI.agentTranslateFromLanguageSelect, DEFAULT_TRANSLATE_LANGUAGE);
  setSelectValueIfAvailable(CCP_V2V.UI.agentTranslateToLanguageSelect, languageConfig.translateAgentTo ?? DEFAULT_TRANSLATE_LANGUAGE);

  setSelectValueIfAvailable(CCP_V2V.UI.customerPollyLanguageCodeSelect, languageConfig.pollyCustomer ?? DEFAULT_POLLY_LANGUAGE);
  setSelectValueIfAvailable(CCP_V2V.UI.agentPollyLanguageCodeSelect, languageConfig.pollyAgent ?? DEFAULT_POLLY_LANGUAGE);

  selectPreferredPollyEngine(CCP_V2V.UI.customerPollyEngineSelect);
  selectPreferredPollyEngine(CCP_V2V.UI.agentPollyEngineSelect);

  await loadCustomerPollyVoiceIds();
  await loadAgentPollyVoiceIds();

  selectPreferredVoice(CCP_V2V.UI.customerPollyVoiceIdSelect, [languageConfig.pollyCustomerVoice, DEFAULT_POLLY_VOICE].filter(Boolean));
  selectPreferredVoice(CCP_V2V.UI.agentPollyVoiceIdSelect, [languageConfig.pollyAgentVoice, DEFAULT_POLLY_VOICE].filter(Boolean));

  StatusIndicatorComponent?.setActiveLanguage(languageLabel);

  console.info(
    `${LOGGER_PREFIX} - applyLanguageSelectionForContact - Applied language ${resolvedLanguageKey} (raw: ${rawLanguageValue ?? "undefined"})`
  );
}

function onContactConnecting(contact) {
  console.info(`${LOGGER_PREFIX} - contact is connecting`, contact);
  StatusIndicatorComponent?.setDetecting();
}

function onContactConnected(contact) {
  console.info(`${LOGGER_PREFIX} - contact connected`, contact);

  applyLanguageSelectionForContact(contact).catch((error) => {
    console.error(`${LOGGER_PREFIX} - onContactConnected - Failed to apply language selection`, error);
  });
  updateLatencyDiagnostics();
  ActiveContactMetadata = {
    contactId: contact?.getContactId?.(),
    initialContactId: contact?.getInitialContactId?.(),
    channel: contact?.getChannel?.(),
    customerEndpoint: contact?.getActiveInitialConnection?.()?.getEndpoint?.()?.phoneNumber,
    connectedAt: new Date().toISOString(),
  };

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;
}

function onContactEnded(contact) {
  console.info(`${LOGGER_PREFIX} - contact has ended`, contact);
  flushTranscriptBuffer(contact).catch((error) => {
    console.error(`${LOGGER_PREFIX} - onContactEnded - Failed to store transcripts`, error);
  });
  CurrentAgentConnectionId = null;
  StatusIndicatorComponent?.setIdle();
  DiagnosticsPanel?.setAllUnknown();
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
  TranscriptBuffer = [];
  ActiveContactMetadata = {};
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
      setDiagnosticStatus("browserPermissions", "error", "Microphone permission denied.");
      return;
    }
    setDiagnosticStatus("browserPermissions", "ok", "Microphone permission granted.");

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
    updateAudioDiagnostics({ error: err });
  }
}

async function loadTranscribeLanguageCodes() {
  const transcribeStreamingLanguages = listStreamingLanguages();
  transcribeStreamingLanguages.forEach((language) => {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = language;
    CCP_V2V.UI.customerTranscribeLanguageSelect.appendChild(option);
    CCP_V2V.UI.agentTranscribeLanguageSelect.appendChild(option.cloneNode(true));
  });
  //set en-US as default
  CCP_V2V.UI.customerTranscribeLanguageSelect.value = "en-US";
  CCP_V2V.UI.agentTranscribeLanguageSelect.value = "en-US";

  //pre-select saved transcribeLanguage
  const savedCustomerTranscribeLanguage = getLocalStorageValueByKey("customerTranscribeLanguage");
  if (savedCustomerTranscribeLanguage) {
    CCP_V2V.UI.customerTranscribeLanguageSelect.value = savedCustomerTranscribeLanguage;
  }

  const savedAgentTranscribeLanguage = getLocalStorageValueByKey("agentTranscribeLanguage");
  if (savedAgentTranscribeLanguage) {
    CCP_V2V.UI.agentTranscribeLanguageSelect.value = savedAgentTranscribeLanguage;
  }
}

function loadTranscribePartialResultsStability() {
  TRANSCRIBE_PARTIAL_RESULTS_STABILITY.forEach((stability) => {
    const option = document.createElement("option");
    option.value = stability;
    option.textContent = stability;
    CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.appendChild(option);
    CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.appendChild(option.cloneNode(true));
  });
  //set none as default
  CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value = "none";
  CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value = "none";

  //pre-select saved transcribePartialResultStability
  const savedCustomerTranscribePartialResultsStability = getLocalStorageValueByKey("customerTranscribePartialResultsStability");
  if (savedCustomerTranscribePartialResultsStability) {
    CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value = savedCustomerTranscribePartialResultsStability;
  }

  const savedAgentTranscribePartialResultsStability = getLocalStorageValueByKey("agentTranscribePartialResultsStability");
  if (savedAgentTranscribePartialResultsStability) {
    CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value = savedAgentTranscribePartialResultsStability;
  }
}

//Creates Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
async function captureFromCustomerAudioStream() {
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const audioStream = session?._remoteAudioStream;
  if (audioStream == null) {
    console.error(`${LOGGER_PREFIX} - captureFromCustomerAudioStream - No audio stream found from customer`);
    setDiagnosticStatus("audioStream", "error", "Customer audio stream unavailable from Connect.");
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
    updateLatencyDiagnostics();
    if (CCP_V2V.UI.customerStreamMicCheckbox.checked === true) {
      //we want agent to hear the customer's original voice, so we reduce the fromCustomerAudioElement volume
      CCP_V2V.UI.fromCustomerAudioElement.volume = 0.3;
    } else {
      //we don't want agent to hear the customer's original voice, so we mute the fromCustomerAudioElement
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }

    //Play the audio feedback to customer
    if (CCP_V2V.UI.customerAudioFeedbackEnabledCheckbox.checked === true) {
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
    updateAudioDiagnostics({
      streamType: "customer",
      sampleRate: customerStreamSampleRate,
      targetSampleRate: customerTargetSampleRate,
    });

    startCustomerStreamTranscription(
      AmazonTranscribeFromCustomerAudioStream,
      customerStreamSampleRate,
      CCP_V2V.UI.customerTranscribeLanguageSelect.value,
      CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.value,
      handleCustomerTranscript,
      handleCustomerPartialTranscript,
      {
        shouldStop: () => !IsCustomerTranscribing,
        onRetry: (details) => handleTranscribeRetry("customer", details),
        targetSampleRate: customerTargetSampleRate,
        ...getTranscribeRetryOptions(),
      }
    );

    CCP_V2V.UI.customerTranscribeLanguageSelect.disabled = true;
    CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.disabled = true;
    CCP_V2V.UI.customerStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.customerStopTranscriptionButton.disabled = false;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - customerStartTranscription - Error starting customer transcription:`, error);
    raiseError(`Error starting customer transcription: ${error}`);
    analyzeTranscribeError(error);
    updateAudioDiagnostics({ streamType: "customer", error });
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

  CCP_V2V.UI.customerTranscribeLanguageSelect.disabled = false;
  CCP_V2V.UI.customerTranscribePartialResultsStabilitySelect.disabled = false;
  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.customerStopTranscriptionButton.disabled = true;
}

async function agentStartTranscription() {
  try {
    IsAgentTranscribing = true;
    updateLatencyDiagnostics();
    const selectedMic = CCP_V2V.UI.micSelect.value;
    const micConstraints = getMicrophoneConstraints(selectedMic);

    if (CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.checked === true) {
      ToAgentAudioStreamManager.enableAudioFeedback(AUDIO_FEEDBACK_FILE_PATH);
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    if (CCP_V2V.UI.agentStreamMicCheckbox.checked === true) {
      await ToCustomerAudioStreamManager.startMicrophone(micConstraints);
      const micVolume = parseFloat(CCP_V2V.UI.agentStreamMicVolume.value);
      ToCustomerAudioStreamManager.setMicrophoneVolume(micVolume);
    }

    //getting the local Mic stream into AmazonTranscribeMicStream variable
    const audioContext = await getAudioContext();
    AmazonTranscribeToCustomerAudioStream = await createMicrophoneStream(micConstraints, audioContext);
    const agentStreamSampleRate = audioContext.sampleRate;
    const agentTargetSampleRate = getAutoSelectedSampleRate(agentStreamSampleRate);
    console.info(
      `${LOGGER_PREFIX} - agentStartTranscription - AmazonTranscribeToCustomerAudioStream Sample Rate: ${agentStreamSampleRate}, target: ${agentTargetSampleRate}`
    );
    updateAudioDiagnostics({
      streamType: "agent",
      sampleRate: agentStreamSampleRate,
      targetSampleRate: agentTargetSampleRate,
    });

    startAgentStreamTranscription(
      AmazonTranscribeToCustomerAudioStream,
      agentStreamSampleRate,
      CCP_V2V.UI.agentTranscribeLanguageSelect.value,
      CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.value,
      handleAgentTranscript,
      handleAgentPartialTranscript,
      {
        shouldStop: () => !IsAgentTranscribing,
        onRetry: (details) => handleTranscribeRetry("agent", details),
        targetSampleRate: agentTargetSampleRate,
        ...getTranscribeRetryOptions(),
      }
    );

    CCP_V2V.UI.agentTranscribeLanguageSelect.disabled = true;
    CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.disabled = true;
    CCP_V2V.UI.agentStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.agentStopTranscriptionButton.disabled = false;

    disableMicrophoneAndSpeakerSelection();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - agentStartTranscription - Error starting agent transcription:`, error);
    raiseError(`Error starting agent transcription: ${error}`);
    analyzeTranscribeError(error);
    updateAudioDiagnostics({ streamType: "agent", error });
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

  CCP_V2V.UI.agentTranscribeLanguageSelect.disabled = false;
  CCP_V2V.UI.agentTranscribePartialResultsStabilitySelect.disabled = false;
  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStopTranscriptionButton.disabled = true;

  enableMicrophoneAndSpeakerSelection();
}

function toggleAgentTranscriptionMute() {
  if (AmazonTranscribeToCustomerAudioStream) {
    const audioTrack = AmazonTranscribeToCustomerAudioStream.stream.getAudioTracks()[0];
    if (audioTrack) {
      //Disable the track in AmazonTranscribeToCustomerAudioStream
      audioTrack.enabled = !audioTrack.enabled;
      IsAgentTranscriptionMuted = !audioTrack.enabled;
      //Mute the Mic so it is not streamed to Customer
      const selectedMic = CCP_V2V.UI.micSelect.value;
      const micConstraints = getMicrophoneConstraints(selectedMic);
      IsAgentTranscriptionMuted ? ToCustomerAudioStreamManager.stopMicrophone() : ToCustomerAudioStreamManager.startMicrophone(micConstraints);
      CCP_V2V.UI.agentMuteTranscriptionButton.textContent = IsAgentTranscriptionMuted ? "Unmute" : "Mute";
    }
  }
}

async function loadTranslateLanguageCodes() {
  const translateLanguages = await listTranslateLanguages().catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadTranslateLanguageCodes - Error listing languages:`, error);
    raiseError(`Error listing languages: ${error}`);
    return [];
  });

  translateLanguages.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.LanguageCode;
    option.textContent = language.LanguageName;

    CCP_V2V.UI.customerTranslateFromLanguageSelect.appendChild(option);
    CCP_V2V.UI.customerTranslateToLanguageSelect.appendChild(option.cloneNode(true));

    CCP_V2V.UI.agentTranslateFromLanguageSelect.appendChild(option.cloneNode(true));
    CCP_V2V.UI.agentTranslateToLanguageSelect.appendChild(option.cloneNode(true));
  });
  //set en as default
  CCP_V2V.UI.customerTranslateFromLanguageSelect.value = "en";
  CCP_V2V.UI.customerTranslateToLanguageSelect.value = "es";

  CCP_V2V.UI.agentTranslateFromLanguageSelect.value = "en";
  CCP_V2V.UI.agentTranslateToLanguageSelect.value = "es";

  //pre-select saved translateFromLanguage
  const savedCustomerTranslateFromLanguage = getLocalStorageValueByKey("customerTranslateFromLanguage");
  if (savedCustomerTranslateFromLanguage) {
    CCP_V2V.UI.customerTranslateFromLanguageSelect.value = savedCustomerTranslateFromLanguage;
  }

  const savedAgentTranslateFromLanguage = getLocalStorageValueByKey("agentTranslateFromLanguage");
  if (savedAgentTranslateFromLanguage) {
    CCP_V2V.UI.agentTranslateFromLanguageSelect.value = savedAgentTranslateFromLanguage;
  }

  //pre-select saved translateToLanguage
  const savedCustomerTranslateToLanguage = getLocalStorageValueByKey("customerTranslateToLanguage");
  if (savedCustomerTranslateToLanguage) {
    CCP_V2V.UI.customerTranslateToLanguageSelect.value = savedCustomerTranslateToLanguage;
  }

  const savedAgentTranslateToLanguage = getLocalStorageValueByKey("agentTranslateToLanguage");
  if (savedAgentTranslateToLanguage) {
    CCP_V2V.UI.agentTranslateToLanguageSelect.value = savedAgentTranslateToLanguage;
  }
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

  const fromLanguage = CCP_V2V.UI.customerTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.customerTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - handleCustomerTranscript - Error translating text:`, error);
    raiseError(`Error translating text: ${error}`);
    return null;
  });

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeCustomerVoice(translatedText);
    addTranscriptToBuffer({
      speaker: "customer",
      originalText: inputText,
      translatedText,
      direction: "toAgent",
    });
    //update CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent = translatedText;
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

async function handleAgentTranslateText() {
  const inputText = CCP_V2V.UI.agentTranslateTextInput.value;
  if (isStringUndefinedNullEmpty(inputText)) return;

  const fromLanguage = CCP_V2V.UI.agentTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.agentTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    addTranscriptToBuffer({
      speaker: "agent",
      originalText: inputText,
      translatedText,
      direction: "fromAgent",
      source: "textInput",
    });
    //update CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = translatedText;
      addTranscriptCard(inputText, translatedText, "fromAgent");
    }, 100);
  }
  CCP_V2V.UI.agentTranslateTextInput.value = "";
  CCP_V2V.UI.agentTranslateTextInput.focus();
}

async function handleAgentTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  //update CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent after 100ms
  setTimeout(() => {
    setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv, "bg-pale-green");
    CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = inputText;
  }, 100);

  const fromLanguage = CCP_V2V.UI.agentTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.agentTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    addTranscriptToBuffer({
      speaker: "agent",
      originalText: inputText,
      translatedText,
      direction: "fromAgent",
    });
    //update CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = translatedText;
      addTranscriptCard(inputText, translatedText, "fromAgent");
    }, 100);
  }
}

function loadPollyLanguageCodes() {
  const pollyLanguageCodes = listPollyLanguages();
  pollyLanguageCodes.forEach((languageCode) => {
    const option = document.createElement("option");
    option.value = languageCode;
    option.textContent = languageCode;
    CCP_V2V.UI.customerPollyLanguageCodeSelect.appendChild(option);
    CCP_V2V.UI.agentPollyLanguageCodeSelect.appendChild(option.cloneNode(true));
  });
  //set un - US as default
  CCP_V2V.UI.customerPollyLanguageCodeSelect.value = "en-US";
  CCP_V2V.UI.agentPollyLanguageCodeSelect.value = "en-US";

  //pre-select saved pollyLanguageCode
  const savedCUstomerPollyLanguageCode = getLocalStorageValueByKey("customerPollyLanguageCode");
  if (savedCUstomerPollyLanguageCode) {
    CCP_V2V.UI.customerPollyLanguageCodeSelect.value = savedCUstomerPollyLanguageCode;
  }

  const savedAgentPollyLanguageCode = getLocalStorageValueByKey("agentPollyLanguageCode");
  if (savedAgentPollyLanguageCode) {
    CCP_V2V.UI.agentPollyLanguageCodeSelect.value = savedAgentPollyLanguageCode;
  }
}

function loadPollyEngines() {
  const pollyEngines = listPollyEngines();
  pollyEngines.forEach((engine) => {
    const option = document.createElement("option");
    option.value = engine;
    option.textContent = engine;
    CCP_V2V.UI.customerPollyEngineSelect.appendChild(option);
    CCP_V2V.UI.agentPollyEngineSelect.appendChild(option.cloneNode(true));
  });

  //pre-select saved pollyEngine
  const savedCustomerPollyEngine = getLocalStorageValueByKey("customerPollyEngine");
  if (savedCustomerPollyEngine) {
    CCP_V2V.UI.customerPollyEngineSelect.value = savedCustomerPollyEngine;
  }

  const savedAgentPollyEngine = getLocalStorageValueByKey("agentPollyEngine");
  if (savedAgentPollyEngine) {
    CCP_V2V.UI.agentPollyEngineSelect.value = savedAgentPollyEngine;
  }
}

async function loadCustomerPollyVoiceIds() {
  const customerSelectedLanguageCode = CCP_V2V.UI.customerPollyLanguageCodeSelect.value;
  const customerSelectedPollyEngine = CCP_V2V.UI.customerPollyEngineSelect.value;

  const pollyVoices = await describeVoices(customerSelectedLanguageCode, customerSelectedPollyEngine).catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadCustomerPollyVoiceIds - Error describing voices:`, error);
    raiseError(`Error describing voices: ${error}`);
    return [];
  });

  //clear pollyVoiceIdSelect
  CCP_V2V.UI.customerPollyVoiceIdSelect.innerHTML = "";

  pollyVoices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.Id;
    option.textContent = voice.Name;
    CCP_V2V.UI.customerPollyVoiceIdSelect.appendChild(option);
  });
  //pre-select saved pollyVoiceId
  const savedCustomerPollyVoiceId = getLocalStorageValueByKey("customerPollyVoiceId");
  if (savedCustomerPollyVoiceId) {
    CCP_V2V.UI.customerPollyVoiceIdSelect.value = savedCustomerPollyVoiceId;
  }
}

async function loadAgentPollyVoiceIds() {
  const agentSelectedLanguageCode = CCP_V2V.UI.agentPollyLanguageCodeSelect.value;
  const agentSelectedPollyEngine = CCP_V2V.UI.agentPollyEngineSelect.value;

  const pollyVoices = await describeVoices(agentSelectedLanguageCode, agentSelectedPollyEngine).catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadAgentPollyVoiceIds - Error describing voices:`, error);
    raiseError(`Error describing voices: ${error}`);
    return [];
  });

  //clear pollyVoiceIdSelect
  CCP_V2V.UI.agentPollyVoiceIdSelect.innerHTML = "";

  pollyVoices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.Id;
    option.textContent = voice.Name;
    CCP_V2V.UI.agentPollyVoiceIdSelect.appendChild(option);
  });
  //pre-select saved pollyVoiceId
  const savedAgentPollyVoiceId = getLocalStorageValueByKey("agentPollyVoiceId");
  if (savedAgentPollyVoiceId) {
    CCP_V2V.UI.agentPollyVoiceIdSelect.value = savedAgentPollyVoiceId;
  }
}

async function synthesizeCustomerVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const selectedLanguageCode = CCP_V2V.UI.customerPollyLanguageCodeSelect.value;
  const selectedPollyEngine = CCP_V2V.UI.customerPollyEngineSelect.value;
  const selectedVoiceId = CCP_V2V.UI.customerPollyVoiceIdSelect.value;

  const synthetizedSpeech = await synthesizeSpeech(selectedLanguageCode, selectedPollyEngine, selectedVoiceId, inputText).catch((error) => {
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
  if (CCP_V2V.UI.customerStreamTranslationCheckbox.checked === true) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    if (ToCustomerAudioStreamManager != null) {
      ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME);
    }
  }
}

async function synthesizeAgentVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const selectedLanguageCode = CCP_V2V.UI.agentPollyLanguageCodeSelect.value;
  const selectedPollyEngine = CCP_V2V.UI.agentPollyEngineSelect.value;
  const selectedVoiceId = CCP_V2V.UI.agentPollyVoiceIdSelect.value;

  const synthetizedSpeech = await synthesizeSpeech(selectedLanguageCode, selectedPollyEngine, selectedVoiceId, inputText).catch((error) => {
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
  if (CCP_V2V.UI.agentStreamTranslationCheckbox.checked === true) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    if (ToAgentAudioStreamManager != null) {
      ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, AGENT_TRANSLATION_TO_AGENT_VOLUME);
    }
  }
}

async function handleAgentSynthesizeSpeech() {
  const inputText = CCP_V2V.UI.agentPollyTextInput.value;
  if (isStringUndefinedNullEmpty(inputText)) return;

  synthesizeAgentVoice(inputText);
  CCP_V2V.UI.agentPollyTextInput.value = "";
  CCP_V2V.UI.agentPollyTextInput.focus();
  addTranscriptCard(inputText, inputText, "fromAgent");
}

function cleanUpUI() {
  CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = "";
  setBackgroundColour(CCP_V2V.UI.customerTranscriptionTextOutputDiv);
  CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent = "";

  CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = "";
  setBackgroundColour(CCP_V2V.UI.agentTranscriptionTextOutputDiv);
  CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = "";

  CCP_V2V.UI.agentTranslateTextInput.value = "";
  CCP_V2V.UI.agentPollyTextInput.value = "";

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

function setDiagnosticStatus(key, status, detail) {
  DiagnosticsPanel?.setStatus(key, status, detail);
}

function updateCredentialDiagnostics() {
  try {
    if (hasValidAwsCredentials()) {
      setDiagnosticStatus("credentials", "ok", "AWS credentials valid.");
      return;
    }

    const idToken = window.localStorage.getItem("idToken");
    if (idToken) {
      const payload = decodeToken(idToken);
      if (payload?.exp) {
        const expiryMs = payload.exp * 1000;
        const remainingMs = expiryMs - Date.now();
        if (remainingMs <= 0) {
          setDiagnosticStatus("credentials", "error", "Cognito token expired. Re-login required.");
        } else {
          const minutes = Math.max(1, Math.floor(remainingMs / 60000));
          setDiagnosticStatus("credentials", "warning", `Token valid for ~${minutes} min. Refreshing soon.`);
        }
        return;
      }
    }

    setDiagnosticStatus("credentials", "unknown", "Credential state not yet determined.");
  } catch (error) {
    console.warn(`${LOGGER_PREFIX} - updateCredentialDiagnostics - Unable to read credentials`, error);
    setDiagnosticStatus("credentials", "unknown", "Unable to read credential state.");
  }
}

function updateLatencyDiagnostics() {
  try {
    const navigatorRef = typeof navigator !== "undefined" ? navigator : null;
    const connection = navigatorRef?.connection || navigatorRef?.mozConnection || navigatorRef?.webkitConnection;
    if (!connection) {
      setDiagnosticStatus("latency", "unknown", "Network info unavailable.");
      return;
    }

    const { effectiveType, downlink, rtt, saveData } = connection;
    const detailParts = [];
    if (effectiveType) detailParts.push(`Type: ${effectiveType}`);
    if (typeof downlink === "number") detailParts.push(`Downlink: ${downlink} Mbps`);
    if (typeof rtt === "number") detailParts.push(`RTT: ${rtt} ms`);
    if (saveData === true) detailParts.push("Save-Data enabled");

    const detail = detailParts.join(" · ");
    if (saveData === true || effectiveType === "2g" || effectiveType === "slow-2g" || (typeof rtt === "number" && rtt > 250)) {
      setDiagnosticStatus("latency", "warning", detail || "High latency or data saver enabled.");
      return;
    }

    setDiagnosticStatus("latency", "ok", detail || "Network conditions look healthy.");
  } catch (error) {
    console.warn(`${LOGGER_PREFIX} - updateLatencyDiagnostics - Unable to read network info`, error);
    setDiagnosticStatus("latency", "unknown", "Unable to read network metrics.");
  }
}

function normalizeErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error.message) return error.message.toString();
  return JSON.stringify(error);
}

function analyzeTranscribeError(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  const errorName = error?.name?.toLowerCase?.() ?? "";
  const errorCode = error?.code?.toLowerCase?.() ?? "";

  if (message.includes("expired") || message.includes("security token") || errorCode.includes("expired") || errorName.includes("expiredtoken")) {
    setDiagnosticStatus("credentials", "error", "AWS credentials expired. Re-login to refresh.");
  } else {
    updateCredentialDiagnostics();
  }

  if (
    message.includes("requesttimetooskewed") ||
    message.includes("signature") ||
    message.includes("invalidsignature") ||
    message.includes("clock") ||
    errorName.includes("signature") ||
    errorCode.includes("signature")
  ) {
    setDiagnosticStatus("credentials", "error", "Signature rejected. Check system clock sync.");
  }

  if (
    message.includes("networkerror") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econn") ||
    message.includes("enetunreach") ||
    message.includes("websocket") ||
    message.includes("failed to fetch")
  ) {
    setDiagnosticStatus("firewall", "warning", "Network blocked or websocket denied. Try a hotspot.");
  }

  if (message.includes("forbidden") || message.includes("403")) {
    setDiagnosticStatus("credentials", "error", "Forbidden by AWS. Check IAM/region permissions.");
  }
}

function updateAudioDiagnostics({ streamType, sampleRate, targetSampleRate, error } = {}) {
  if (error) {
    const message = normalizeErrorMessage(error);
    if (message.toLowerCase().includes("notallowed") || message.toLowerCase().includes("permission")) {
      setDiagnosticStatus("browserPermissions", "error", "Microphone permission denied.");
      setDiagnosticStatus("audioStream", "error", "Audio stream blocked by permissions.");
      return;
    }
    setDiagnosticStatus("audioStream", "error", message);
    return;
  }

  if (streamType === "customer" && sampleRate == null) {
    setDiagnosticStatus("audioStream", "error", "Customer audio stream unavailable.");
    return;
  }

  const detailParts = [];
  if (streamType) detailParts.push(`Stream: ${streamType}`);
  if (sampleRate) detailParts.push(`Sample rate: ${sampleRate} Hz`);
  if (targetSampleRate) detailParts.push(`Target: ${targetSampleRate} Hz`);

  setDiagnosticStatus("audioStream", "ok", detailParts.join(" · ") || "Audio stream healthy.");
}

function getTranscribeRetryOptions() {
  const navigatorRef = typeof navigator !== "undefined" ? navigator : null;
  const connection = navigatorRef?.connection || navigatorRef?.mozConnection || navigatorRef?.webkitConnection;
  if (!connection) {
    return {};
  }

  const { effectiveType, rtt } = connection;
  if (effectiveType === "3g" || effectiveType === "2g" || effectiveType === "slow-2g" || (typeof rtt === "number" && rtt > 250)) {
    return {
      maxAttempts: 6,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
    };
  }

  return {};
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

function addTranscriptToBuffer({ speaker, originalText, translatedText, direction, source } = {}) {
  if (isStringUndefinedNullEmpty(originalText) || isStringUndefinedNullEmpty(translatedText)) return;
  TranscriptBuffer.push({
    speaker,
    direction,
    source: source ?? "speech",
    originalText,
    translatedText,
    capturedAt: new Date().toISOString(),
    language: speaker === "customer" ? CCP_V2V.UI.customerTranscribeLanguageSelect.value : CCP_V2V.UI.agentTranscribeLanguageSelect.value,
    translateFrom: speaker === "customer" ? CCP_V2V.UI.customerTranslateFromLanguageSelect.value : CCP_V2V.UI.agentTranslateFromLanguageSelect.value,
    translateTo: speaker === "customer" ? CCP_V2V.UI.customerTranslateToLanguageSelect.value : CCP_V2V.UI.agentTranslateToLanguageSelect.value,
  });
}

async function flushTranscriptBuffer(contact) {
  const apiUrl = TRANSCRIPT_STORAGE_CONFIG.transcriptApiUrl;
  if (isStringUndefinedNullEmpty(apiUrl)) {
    console.warn(`${LOGGER_PREFIX} - flushTranscriptBuffer - transcriptApiUrl is not configured`);
    return;
  }

  if (!TranscriptBuffer.length) {
    console.info(`${LOGGER_PREFIX} - flushTranscriptBuffer - No transcript entries to store`);
    return;
  }

  const payload = {
    contactId: contact?.getContactId?.(),
    initialContactId: contact?.getInitialContactId?.(),
    channel: contact?.getChannel?.(),
    connectedAt: ActiveContactMetadata.connectedAt,
    endedAt: new Date().toISOString(),
    customerEndpoint: ActiveContactMetadata.customerEndpoint,
    agentUsername: CurrentUser.currentUser_ConnectUsername,
    transcripts: TranscriptBuffer,
  };

  console.info(`${LOGGER_PREFIX} - flushTranscriptBuffer - Sending transcript payload`, {
    transcriptCount: TranscriptBuffer.length,
    contactId: payload.contactId,
    apiUrl,
  });

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(`Transcript upload failed (${response.status}): ${responseText}`);
  }
}

function addTranscriptToBuffer({ speaker, originalText, translatedText, direction, source } = {}) {
  if (isStringUndefinedNullEmpty(originalText) || isStringUndefinedNullEmpty(translatedText)) return;
  TranscriptBuffer.push({
    speaker,
    direction,
    source: source ?? "speech",
    originalText,
    translatedText,
    capturedAt: new Date().toISOString(),
    language: speaker === "customer" ? CCP_V2V.UI.customerTranscribeLanguageSelect.value : CCP_V2V.UI.agentTranscribeLanguageSelect.value,
    translateFrom: speaker === "customer" ? CCP_V2V.UI.customerTranslateFromLanguageSelect.value : CCP_V2V.UI.agentTranslateFromLanguageSelect.value,
    translateTo: speaker === "customer" ? CCP_V2V.UI.customerTranslateToLanguageSelect.value : CCP_V2V.UI.agentTranslateToLanguageSelect.value,
  });
}

async function flushTranscriptBuffer(contact) {
  const apiUrl = TRANSCRIPT_STORAGE_CONFIG.transcriptApiUrl;
  if (isStringUndefinedNullEmpty(apiUrl)) {
    console.warn(`${LOGGER_PREFIX} - flushTranscriptBuffer - transcriptApiUrl is not configured`);
    return;
  }

  if (!TranscriptBuffer.length) {
    console.info(`${LOGGER_PREFIX} - flushTranscriptBuffer - No transcript entries to store`);
    return;
  }

  const payload = {
    contactId: contact?.getContactId?.(),
    initialContactId: contact?.getInitialContactId?.(),
    channel: contact?.getChannel?.(),
    connectedAt: ActiveContactMetadata.connectedAt,
    endedAt: new Date().toISOString(),
    customerEndpoint: ActiveContactMetadata.customerEndpoint,
    agentUsername: CurrentUser.currentUser_ConnectUsername,
    transcripts: TranscriptBuffer,
  };

  console.info(`${LOGGER_PREFIX} - flushTranscriptBuffer - Sending transcript payload`, {
    transcriptCount: TranscriptBuffer.length,
    contactId: payload.contactId,
    apiUrl,
  });

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(`Transcript upload failed (${response.status}): ${responseText}`);
  }
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
      return Math.min(inputSampleRate, TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS.low);
    }

    return Math.min(inputSampleRate, TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS.high);
  } catch (error) {
    console.warn(`${LOGGER_PREFIX} - getAutoSelectedSampleRate - Falling back to default sample rate`, error);
    return Math.min(inputSampleRate, TRANSCRIBE_TARGET_SAMPLE_RATE);
  }
}

function handleTranscribeRetry(target, details) {
  const message = `Reconnecting transcription (attempt ${details.attempt})...`;
  if (details?.error) {
    analyzeTranscribeError(details.error);
    setDiagnosticStatus("firewall", "warning", "Retrying Transcribe connection; potential firewall or network block.");
  }
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
      echoCancellation: CCP_V2V.UI.echoCancellationCheckbox.checked === true,
      noiseSuppression: CCP_V2V.UI.noiseSuppressionCheckbox.checked === true,
      autoGainControl: CCP_V2V.UI.autoGainControlCheckbox.checked === true,
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

  CCP_V2V.UI.echoCancellationCheckbox.disabled = false;
  CCP_V2V.UI.noiseSuppressionCheckbox.disabled = false;
  CCP_V2V.UI.autoGainControlCheckbox.disabled = false;
}

function disableMicrophoneAndSpeakerSelection() {
  CCP_V2V.UI.micSelect.disabled = true;
  CCP_V2V.UI.speakerSelect.disabled = true;

  CCP_V2V.UI.testAudioButton.disabled = true;

  CCP_V2V.UI.testMicButton.disabled = true;

  CCP_V2V.UI.echoCancellationCheckbox.disabled = true;
  CCP_V2V.UI.noiseSuppressionCheckbox.disabled = true;
  CCP_V2V.UI.autoGainControlCheckbox.disabled = true;
}