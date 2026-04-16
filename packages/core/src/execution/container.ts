/**
 * ContainerExecutor — Cloudflare Container VM (Sandbox SDK).
 *
 * Stub implementation. Returns descriptive errors explaining the sandbox
 * isn't provisioned yet. When provisioned, delegates to @cloudflare/sandbox.
 *
 * Namespace: sandbox.*
 *   sandbox.exec("npm test", [])
 *   sandbox.writeFile("/workspace/app.ts", code)
 *   sandbox.gitCheckout("https://github.com/user/repo")
 *   sandbox.startProcess("node server.js")
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

const NOT_PROVISIONED = 'Sandbox container is not provisioned. Provision it from the Settings page.';

function stub(methodName: string) {
  return {
    description: `[Sandbox] ${methodName} — requires Container VM binding`,
    execute: async (): Promise<string> => `${methodName}: ${NOT_PROVISIONED}`,
  };
}

export function createContainerExecutor(): ExecutorProvider {
  return {
    name: 'sandbox',
    kind: 'sandbox',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'python', 'native_binary',
      'shell', 'npm', 'git',
      'fs_owned', 'net_outbound', 'net_inbound',
      'process_spawn', 'process_long', 'process_signal',
    ]),
    isAvailable: () => false,
    connect: async () => { throw new Error(NOT_PROVISIONED); },
    disconnect: async () => {},
    tools: {
      exec: stub('exec'),
      readFile: stub('readFile'),
      writeFile: stub('writeFile'),
      deleteFile: stub('deleteFile'),
      listFiles: stub('listFiles'),
      gitCheckout: stub('gitCheckout'),
      startProcess: stub('startProcess'),
      killProcess: stub('killProcess'),
    },
    types: `declare namespace sandbox {
  /** Execute a command in the Linux container (full bash, any language) */
  function exec(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<void>;
  function deleteFile(path: string): Promise<void>;
  function listFiles(path: string): Promise<string[]>;
  /** Clone a git repository */
  function gitCheckout(url: string, options?: { branch?: string; targetDir?: string }): Promise<void>;
  /** Start a long-running process (returns process handle) */
  function startProcess(command: string): Promise<{ id: string; pid: number }>;
  /** Kill a running process */
  function killProcess(processId: string, signal?: string): Promise<void>;
}`,
    positionalArgs: true,
  };
}
