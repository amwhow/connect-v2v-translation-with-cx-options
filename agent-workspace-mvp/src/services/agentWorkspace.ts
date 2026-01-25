export type ContactAttributes = Record<string, string>;

export type ContactSummary = {
  contactId: string;
  instanceId: string;
  attributes: ContactAttributes;
};

export type AgentWorkspaceBridge = {
  isEmbedded: () => boolean;
  onActiveContact: (callback: (contact: ContactSummary | null) => void) => () => void;
  getActiveContact: () => Promise<ContactSummary | null>;
  onAgentState?: (callback: (state: string) => void) => () => void;
  getAudioStreams?: () => Promise<MediaStream[] | null>;
};

export const createAgentWorkspaceBridge = (): AgentWorkspaceBridge => {
  const win = window as Window & {
    AgentWorkspace?: AgentWorkspaceBridge;
  };

  if (win.AgentWorkspace) {
    return win.AgentWorkspace;
  }

  const fallback: AgentWorkspaceBridge = {
    isEmbedded: () => window.self !== window.top,
    onActiveContact: (callback) => {
      callback(null);
      return () => undefined;
    },
    getActiveContact: async () => null,
  };

  return fallback;
};
