# Agent Workspace V2V MVP (React)

This is a minimal React MVP for a **V2V translation app** intended to run inside **Amazon Connect Agent Workspace** (no embedded CCP iframe). The MVP is designed to boot cleanly, show live UI state, and provide a clear integration surface for Agent Workspace APIs, audio capture, and the AWS Transcribe/Translate/Polly pipeline.

## What works out of the box
- React UI with contact status and detected language display.
- Microphone capture for the agent.
- Mock transcription events to validate the UI pipeline.

## What requires Agent Workspace integration
To fully support **caller audio**, **live transcription**, and **Polly playback** into the call, you must connect to the Agent Workspace APIs that provide:
- Active contact lifecycle events.
- Contact attributes (language).
- Audio stream access for both agent + caller.

This MVP exposes a `window.AgentWorkspace` bridge you can inject from Agent Workspace to replace the fallback implementation.

## Development

```bash
npm install
npm run dev
```

## Where to integrate Agent Workspace APIs
- `src/services/agentWorkspace.ts` defines the bridge interface.
- `src/services/audioCapture.ts` handles microphone capture.
- Replace `src/services/mockPipeline.ts` with the real Transcribe/Translate/Polly pipeline once audio streams are available.

## Suggested next steps
1. Wire Agent Workspace contact events into `window.AgentWorkspace.onActiveContact`.
2. Provide a `getAudioStreams()` method that returns caller + agent audio streams when available.
3. Replace `startMockPipeline()` with a real audio pipeline.

---

This MVP is intentionally lean to keep integration friction low while giving you a stable React base to build on.
