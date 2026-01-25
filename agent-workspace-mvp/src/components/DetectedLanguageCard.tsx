import React from "react";

type DetectedLanguageCardProps = {
  languageLabel: string;
  status: "waiting" | "detected" | "default";
};

const statusLabels: Record<DetectedLanguageCardProps["status"], string> = {
  waiting: "Waiting for contact",
  detected: "Auto-detected",
  default: "Defaulted",
};

const DetectedLanguageCard: React.FC<DetectedLanguageCardProps> = ({ languageLabel, status }) => {
  return (
    <section className="card">
      <header className="card-header">
        <h2>Detected Language</h2>
        <span className={`pill pill-${status}`}>{statusLabels[status]}</span>
      </header>
      <p className="card-title">{languageLabel}</p>
      <p className="card-subtitle">Language preset is applied automatically from contact attributes.</p>
    </section>
  );
};

export default DetectedLanguageCard;
