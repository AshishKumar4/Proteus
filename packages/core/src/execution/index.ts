/**
 * Execution Layer — capability-based multi-executor routing.
 */

export type {
  ExecutorCapability,
  ExecutorKind,
  ExecutorProvider,
  ExecutorInfo,
  ExecutionRouter,
} from './types.js';

export { DefaultExecutionRouter } from './router.js';
export { createInlineExecutor, type InlineExecutorDeps } from './inline.js';
export { createNimbusExecutor, type NimbusStub } from './nimbus.js';
export { createContainerExecutor, type ContainerStub } from './container.js';
export { createSSHTunnelExecutor } from './ssh.js';
