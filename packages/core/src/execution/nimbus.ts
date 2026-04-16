/**
 * NimbusExecutor — DO-based bash environment with npm/node/git/vite.
 *
 * Stub implementation. Returns descriptive errors explaining Nimbus
 * isn't connected yet. When connected, delegates to a NimbusSession DO
 * via RPC.
 *
 * Namespace: nimbus.*
 *   nimbus.exec("npm install express")
 *   nimbus.node("const fs = require('fs'); ...")
 *   nimbus.git("clone https://github.com/user/repo")
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

const NOT_CONNECTED = 'Nimbus environment is not connected. Provision it from the Settings page.';

function stub(methodName: string) {
  return {
    description: `[Nimbus] ${methodName} — requires NimbusSession DO binding`,
    execute: async (): Promise<string> => `${methodName}: ${NOT_CONNECTED}`,
  };
}

export function createNimbusExecutor(): ExecutorProvider {
  return {
    name: 'nimbus',
    kind: 'nimbus',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'shell', 'npm', 'git',
      'fs_owned', 'net_outbound', 'net_inbound', 'process_spawn', 'process_long',
    ]),
    isAvailable: () => false,
    connect: async () => { throw new Error(NOT_CONNECTED); },
    disconnect: async () => {},
    tools: {
      exec: stub('exec'),
      readFile: stub('readFile'),
      writeFile: stub('writeFile'),
      node: stub('node'),
      npm: stub('npm'),
      git: stub('git'),
    },
    types: `declare namespace nimbus {
  /** Run a shell command in the Nimbus environment (60+ POSIX commands + npm/node/git) */
  function exec(command: string): Promise<string>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  /** Execute a Node.js script with full require() support */
  function node(code: string): Promise<string>;
  /** Run npm commands (install, run, test, build, start) */
  function npm(command: string): Promise<string>;
  /** Run git commands (clone, commit, push, pull, branch, etc.) */
  function git(command: string): Promise<string>;
}`,
    positionalArgs: true,
  };
}
