export function createStatusIndicator(container) {
  if (!container) {
    return {
      setIdle: () => {},
      setDetecting: () => {},
      setActiveLanguage: () => {},
    };
  }

  const indicator = document.createElement("div");
  indicator.className = "status-indicator status-indicator--idle";

  const label = document.createElement("span");
  label.className = "status-indicator__label";
  indicator.appendChild(label);
  container.appendChild(indicator);

  const setStatus = (statusClass, text) => {
    indicator.className = `status-indicator ${statusClass}`;
    label.textContent = text;
  };

  return {
    setIdle: () => setStatus("status-indicator--idle", "⚪ Idle: Waiting for contact"),
    setDetecting: () => setStatus("status-indicator--detecting", "🟡 Detecting language..."),
    setActiveLanguage: (languageLabel) => setStatus("status-indicator--active", `🟢 Active: ${languageLabel}`),
  };
}
