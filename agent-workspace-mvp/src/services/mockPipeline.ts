export type TranscriptEvent = {
  text: string;
  translation: string;
  speaker: "agent" | "customer";
};

export type PipelineHandle = {
  stop: () => void;
};

const samplePhrases = {
  agent: ["Hello, how can I help you?", "Let me check that for you.", "I will connect you shortly."],
  customer: ["Hola, necesito ayuda.", "¿Puede repetir eso?", "Gracias."],
};

export const startMockPipeline = (onEvent: (event: TranscriptEvent) => void): PipelineHandle => {
  let active = true;
  const interval = window.setInterval(() => {
    if (!active) return;
    const speaker = Math.random() > 0.5 ? "agent" : "customer";
    const source = samplePhrases[speaker];
    const phrase = source[Math.floor(Math.random() * source.length)];
    const translation = speaker === "agent" ? `ES: ${phrase}` : `EN: ${phrase}`;
    onEvent({ text: phrase, translation, speaker });
  }, 2500);

  return {
    stop: () => {
      active = false;
      window.clearInterval(interval);
    },
  };
};
