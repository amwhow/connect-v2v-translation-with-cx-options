import React, { useEffect, useMemo, useState } from "react";
import DetectedLanguageCard from "./components/DetectedLanguageCard";
import TranscriptPanel, { TranscriptLine } from "./components/TranscriptPanel";
import { createAgentWorkspaceBridge } from "./services/agentWorkspace";
import { startMicrophoneCapture } from "./services/audioCapture";
import { startMockPipeline } from "./services/mockPipeline";

const LANGUAGE_PRESETS: Record<string, string> = {
  spanish: "Spanish",
  french: "French",
  english: "English",
};

const LANGUAGE_ATTRIBUTE_KEYS = ["language", "Language", "preferredLanguage", "preferred_language"];

const resolveLanguageLabel = (attributes: Record<string, string>): { label: string; status: "detected" | "default" } => {
  for (const key of LANGUAGE_ATTRIBUTE_KEYS) {
    const value = attributes[key];
    if (value) {
      const normalized = value.trim().toLowerCase();
      return {
        label: LANGUAGE_PRESETS[normalized] ?? value,
        status: LANGUAGE_PRESETS[normalized] ? "detected" : "default",
      };
    }
  }
  return { label: LANGUAGE_PRESETS.english, status: "default" };
};

const App: React.FC = () => {
  const bridge = useMemo(() => createAgentWorkspaceBridge(), []);
  const [contactId, setContactId] = useState<string | null>(null);
  const [languageLabel, setLanguageLabel] = useState("Waiting for contact…");
  const [languageStatus, setLanguageStatus] = useState<"waiting" | "detected" | "default">("waiting");
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [hasAudioAccess, setHasAudioAccess] = useState(false);

  useEffect(() => {
    const unsubscribe = bridge.onActiveContact((contact) => {
      if (!contact) {
        setContactId(null);
        setLanguageLabel("Waiting for contact…");
        setLanguageStatus("waiting");
        return;
      }
      setContactId(contact.contactId);
      const resolved = resolveLanguageLabel(contact.attributes ?? {});
      setLanguageLabel(resolved.label);
      setLanguageStatus(resolved.status);
    });

    bridge
      .getActiveContact()
      .then((contact) => {
        if (contact) {
          setContactId(contact.contactId);
          const resolved = resolveLanguageLabel(contact.attributes ?? {});
          setLanguageLabel(resolved.label);
          setLanguageStatus(resolved.status);
        }
      })
      .catch(() => undefined);

    return () => unsubscribe();
  }, [bridge]);

  useEffect(() => {
    let micHandle: Awaited<ReturnType<typeof startMicrophoneCapture>> | null = null;
    let pipelineHandle: ReturnType<typeof startMockPipeline> | null = null;

    if (isRunning) {
      startMicrophoneCapture()
        .then((handle) => {
          micHandle = handle;
          setHasAudioAccess(true);
          pipelineHandle = startMockPipeline((event) => {
            setLines((prev) => [
              {
                id: crypto.randomUUID(),
                text: event.text,
                translation: event.translation,
                speaker: event.speaker,
                timestamp: new Date().toLocaleTimeString(),
              },
              ...prev,
            ]);
          });
        })
        .catch(() => {
          setHasAudioAccess(false);
          setIsRunning(false);
        });
    }

    return () => {
      micHandle?.stop();
      pipelineHandle?.stop();
    };
  }, [isRunning]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Agent Workspace MVP</p>
          <h1>Live Translation Console</h1>
        </div>
        <div className="status">
          <span className={`dot ${bridge.isEmbedded() ? "online" : "offline"}`} />
          <span>{bridge.isEmbedded() ? "Embedded" : "Standalone"}</span>
        </div>
      </header>

      <section className="summary">
        <div className="summary-card">
          <p className="summary-label">Active Contact</p>
          <p className="summary-value">{contactId ?? "No active contact"}</p>
        </div>
        <div className="summary-card">
          <p className="summary-label">Audio Capture</p>
          <p className="summary-value">{hasAudioAccess ? "Microphone connected" : "Awaiting permission"}</p>
        </div>
      </section>

      <div className="content">
        <div className="left">
          <DetectedLanguageCard languageLabel={languageLabel} status={languageStatus} />
          <section className="card">
            <header className="card-header">
              <h2>Controls</h2>
            </header>
            <div className="controls">
              <button className="primary" onClick={() => setIsRunning(true)} disabled={isRunning}>
                Start Live Translation
              </button>
              <button className="secondary" onClick={() => setIsRunning(false)} disabled={!isRunning}>
                Stop
              </button>
              <p className="helper">
                This MVP uses the microphone for agent audio and emits mock transcript events until Agent Workspace audio APIs
                are wired. Replace the mock pipeline with Transcribe/Translate/Polly services once audio streams are available.
              </p>
            </div>
          </section>
        </div>

        <div className="right">
          <TranscriptPanel lines={lines} />
        </div>
      </div>
    </div>
  );
};

export default App;
