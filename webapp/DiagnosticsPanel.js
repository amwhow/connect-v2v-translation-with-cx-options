const STATUS_CONFIG = {
  unknown: { label: "⚪ Unknown", className: "diagnostic-status--unknown" },
  ok: { label: "🟢 OK", className: "diagnostic-status--ok" },
  warning: { label: "🟡 Check", className: "diagnostic-status--warning" },
  error: { label: "🔴 Issue", className: "diagnostic-status--error" },
};

export function createDiagnosticsPanel(container, factors = []) {
  if (!container) {
    return {
      setStatus: () => {},
      setAllUnknown: () => {},
    };
  }

  const list = document.createElement("div");
  list.className = "diagnostic-panel";
  container.appendChild(list);

  const rows = new Map();
  factors.forEach((factor) => {
    const row = document.createElement("div");
    row.className = "diagnostic-row";

    const title = document.createElement("div");
    title.className = "diagnostic-title";
    title.textContent = factor.label;

    const status = document.createElement("div");
    status.className = "diagnostic-status diagnostic-status--unknown";
    status.textContent = STATUS_CONFIG.unknown.label;

    const detail = document.createElement("div");
    detail.className = "diagnostic-detail";
    detail.textContent = factor.detail ?? "";

    row.appendChild(title);
    row.appendChild(status);
    row.appendChild(detail);
    list.appendChild(row);

    rows.set(factor.key, { status, detail });
  });

  const setStatus = (key, statusKey, detailText) => {
    const row = rows.get(key);
    if (!row) return;
    const config = STATUS_CONFIG[statusKey] ?? STATUS_CONFIG.unknown;
    row.status.className = `diagnostic-status ${config.className}`;
    row.status.textContent = config.label;
    if (detailText != null) {
      row.detail.textContent = detailText;
    }
  };

  const setAllUnknown = () => {
    rows.forEach((row) => {
      row.status.className = `diagnostic-status ${STATUS_CONFIG.unknown.className}`;
      row.status.textContent = STATUS_CONFIG.unknown.label;
      row.detail.textContent = "";
    });
  };

  return {
    setStatus,
    setAllUnknown,
  };
}
