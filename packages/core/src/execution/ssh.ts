/**
 * SSHTunnelExecutor — user's personal machine via WebSocket bridge.
 *
 * Stub implementation. Returns descriptive errors explaining the daemon
 * isn't connected yet. When connected, delegates via WebSocket RPC to
 * the `proteus-daemon` running on the user's machine.
 *
 * Namespace: laptop.*
 *   laptop.exec("git status")
 *   laptop.readFile("/Users/me/project/src/main.ts")
 *   laptop.writeFile("/tmp/output.json", data)
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

const NOT_CONNECTED = 'No local machine connected. Run `proteus connect` on your machine to enable laptop.* APIs.';

function stub(methodName: string) {
  return {
    description: `[Laptop] ${methodName} — requires proteus-daemon connection`,
    execute: async (): Promise<string> => `${methodName}: ${NOT_CONNECTED}`,
  };
}

export function createSSHTunnelExecutor(): ExecutorProvider {
  return {
    name: 'laptop',
    kind: 'laptop',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'python', 'native_binary',
      'shell', 'npm', 'git', 'docker',
      'fs_owned', 'net_outbound', 'net_inbound',
      'process_spawn', 'process_long', 'process_signal', 'gpu',
    ]),
    isAvailable: () => false,
    connect: async () => { throw new Error(NOT_CONNECTED); },
    disconnect: async () => {},
    tools: {
      exec: stub('exec'),
      readFile: stub('readFile'),
      writeFile: stub('writeFile'),
      git: stub('git'),
    },
    types: `declare namespace laptop {
  /** Execute a command on the user's local machine */
  function exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Read a file from the user's local filesystem */
  function readFile(path: string): Promise<string>;
  /** Write a file to the user's local filesystem */
  function writeFile(path: string, content: string): Promise<void>;
  /** Run a git command on the user's machine */
  function git(command: string): Promise<string>;
}`,
    positionalArgs: true,
  };
}
