export const DEPRECATED_CONNECT_DOMAIN = "awsapps.com";

export const SESSION_STORAGE_KEYS = {};

export const LOGGER_PREFIX = "CCP-V2V";

export const CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME = 0.1;
export const AGENT_TRANSLATION_TO_AGENT_VOLUME = 0.1;

export const TRANSCRIBE_PARTIAL_RESULTS_STABILITY = ["low", "medium", "high"];

export const AUDIO_FEEDBACK_FILE_PATH = "./assets/background_noise.wav";

export const TRANSCRIBE_RETRY_MAX_ATTEMPTS = 3;
export const TRANSCRIBE_RETRY_BASE_DELAY_MS = 500;
export const TRANSCRIBE_RETRY_MAX_DELAY_MS = 5000;
export const TRANSCRIBE_TARGET_SAMPLE_RATE = 16000;

export const TRANSCRIBE_AUTO_SAMPLE_RATE_PRESETS = {
  high: 16000,
  medium: 12000,
  low: 8000,
};