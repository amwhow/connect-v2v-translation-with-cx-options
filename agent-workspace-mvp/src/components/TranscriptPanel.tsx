import React from "react";

export type TranscriptLine = {
  id: string;
  text: string;
  translation: string;
  speaker: "agent" | "customer";
  timestamp: string;
};

type TranscriptPanelProps = {
  lines: TranscriptLine[];
};

const TranscriptPanel: React.FC<TranscriptPanelProps> = ({ lines }) => {
  return (
    <section className="card">
      <header className="card-header">
        <h2>Live Transcript</h2>
      </header>
      <div className="transcript-list">
        {lines.length === 0 && <p className="muted">Waiting for speech events…</p>}
        {lines.map((line) => (
          <div key={line.id} className={`transcript-line ${line.speaker}`}>
            <div className="transcript-meta">
              <span className="speaker">{line.speaker === "agent" ? "Agent" : "Customer"}</span>
              <span className="timestamp">{line.timestamp}</span>
            </div>
            <div className="transcript-text">{line.text}</div>
            <div className="transcript-translation">{line.translation}</div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default TranscriptPanel;
