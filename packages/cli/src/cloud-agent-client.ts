import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { createCloudAgentConnectTicket } from './cloud-api.js';
import {
  asRecord,
  createUserUiMessage,
  type AgentClient,
  type AgentClientEvent,
  type AgentClientSendOptions,
  type AgentTurnResult,
} from './agent-client.js';

interface ActiveTurn {
  text: string;
  steps: number;
  toolCalls: AgentTurnResult['toolCalls'];
  toolById: Map<string, AgentTurnResult['toolCalls'][number]>;
  onEvent?: (event: AgentClientEvent) => void;
  resolve: (result: AgentTurnResult) => void;
  reject: (err: Error) => void;
}

/**
 * Thin protocol client for the OrchestratorAgent DO chat websocket.
 *
 * The DO is the source of truth for chat history and turn execution: each send
 * transmits only the new user message (the server reconciles it into its
 * canonical store and builds model context server-side), so the client never
 * mirrors history. History reads go over the HTTP projection in cloud-api.
 */
export class CloudAgentClient implements AgentClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(private readonly opts: { origin: string; token: string; name: string }) {}

  async send(prompt: string, opts: AgentClientSendOptions = {}): Promise<AgentTurnResult> {
    const text = prompt.trim();
    if (!text) throw new Error('prompt required');
    await this.ensureOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Cloud agent connection is not open.');

    const requestId = randomRequestId();
    return await new Promise<AgentTurnResult>((resolve, reject) => {
      this.activeTurns.set(requestId, {
        text: '',
        steps: 0,
        toolCalls: [],
        toolById: new Map(),
        onEvent: opts.onEvent,
        resolve,
        reject,
      });

      try {
        ws.send(JSON.stringify({
          id: requestId,
          init: {
            method: 'POST',
            body: JSON.stringify({
              messages: [createUserUiMessage(text)],
              trigger: 'submit-message',
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
            }),
          },
          type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
        }));
      } catch (err) {
        this.activeTurns.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Cancel in-flight turns: ask the DO to abort, resolve locally with the
   *  partial output so callers return to idle immediately. */
  stop(): void {
    const ws = this.ws;
    for (const [id, turn] of [...this.activeTurns]) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id }));
      }
      this.activeTurns.delete(id);
      turn.resolve({ text: turn.text, toolCalls: turn.toolCalls, steps: turn.steps });
    }
  }

  close(): void {
    this.rejectActive(new Error('Cloud agent connection closed.'));
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
  }

  private async ensureOpen(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return await this.connectPromise;
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    const { ticket } = await createCloudAgentConnectTicket(this.opts.origin, this.opts.token, this.opts.name);
    const url = new URL(`/agents/orchestrator-agent/${encodeURIComponent(this.opts.name)}`, this.opts.origin.replace(/\/+$/, ''));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);

    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.addEventListener('message', (event) => this.handleMessage(event));
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.rejectActive(new Error('Cloud agent connection closed.'));
    });
    ws.addEventListener('error', () => {
      this.rejectActive(new Error('Cloud agent connection failed.'));
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to cloud agent.')), 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not connect to cloud agent.'));
      }, { once: true });
    });
  }

  private handleMessage(event: MessageEvent): void {
    const payload = parseSocketJson(event.data);
    if (!payload) return;

    // Ack a resuming stream only when it is one of our own turns, so the DO
    // replays its chunks after a reconnect; other clients' streams are ignored.
    if (payload.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING && typeof payload.id === 'string') {
      if (this.activeTurns.has(payload.id)) {
        this.ws?.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: payload.id }));
      }
      return;
    }

    if (payload.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || typeof payload.id !== 'string') return;
    const active = this.activeTurns.get(payload.id);
    if (!active) return;
    if (payload.error) {
      this.activeTurns.delete(payload.id);
      active.reject(new Error(typeof payload.body === 'string' && payload.body ? payload.body : 'Cloud agent stream failed.'));
      return;
    }
    if (typeof payload.body === 'string' && payload.body.trim()) {
      this.applyChunk(active, payload.body);
    }
    if (payload.done) {
      this.activeTurns.delete(payload.id);
      active.resolve({ text: active.text, toolCalls: active.toolCalls, steps: active.steps });
    }
  }

  private applyChunk(active: ActiveTurn, body: string): void {
    let chunk: unknown;
    try { chunk = JSON.parse(body); }
    catch { return; }
    if (!isRecord(chunk) || typeof chunk.type !== 'string') return;
    switch (chunk.type) {
      case 'text-delta': {
        const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
        if (!delta) return;
        active.text += delta;
        active.onEvent?.({ type: 'text-delta', delta });
        return;
      }
      case 'tool-input-available': {
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : 'tool';
        const call = { name: toolName, args: chunk.input, result: undefined };
        active.toolCalls.push(call);
        if (typeof chunk.toolCallId === 'string') active.toolById.set(chunk.toolCallId, call);
        active.onEvent?.({ type: 'tool-call', toolName, args: asRecord(chunk.input) });
        return;
      }
      case 'tool-output-available':
      case 'tool-output-error': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : '';
        const call = active.toolById.get(toolCallId);
        const result = chunk.type === 'tool-output-error'
          ? String(chunk.errorText ?? 'tool error')
          : stringifyToolOutput(chunk.output);
        if (call) call.result = result;
        active.onEvent?.({ type: 'tool-result', toolName: call?.name ?? 'tool', result });
        return;
      }
      case 'finish-step': {
        active.steps += 1;
        active.onEvent?.({ type: 'step-finish', stepIndex: active.steps });
        return;
      }
    }
  }

  private rejectActive(error: Error): void {
    const active = [...this.activeTurns.values()];
    this.activeTurns.clear();
    for (const turn of active) turn.reject(error);
  }
}

function parseSocketJson(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : String(data);
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function randomRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
