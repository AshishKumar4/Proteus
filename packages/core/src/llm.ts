/**
 * LLM wrapper using Vercel AI SDK — shared between CF and CLI backends.
 *
 * Both backends use createOpenAICompatible from @ai-sdk/openai-compatible.
 * The caller provides the base URL, auth headers, and model name.
 * No hardcoded credentials anywhere.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import type { StepResult, ToolSet } from 'ai';
import type { LLM } from './types/primitives.js';

export interface LLMProviderConfig {
  /** Display name for the provider (e.g., 'workers-ai', 'anthropic') */
  name: string;
  /** Base URL for the OpenAI-compatible API */
  baseURL: string;
  /** Auth headers (e.g., { 'cf-aig-authorization': 'Bearer ...' }) */
  headers: Record<string, string>;
  /** Model identifier (e.g., '@cf/moonshotai/kimi-k2.5') */
  model: string;
  /** Max tokens for completions (default: 2048) */
  maxTokens?: number;
}

/**
 * Create an LLM backed by the Vercel AI SDK.
 * Works with any OpenAI-compatible endpoint:
 * - Cloudflare Workers AI (via AI Gateway)
 * - OpenAI direct
 * - Anthropic (via proxy)
 * - Any OpenAI-compatible provider
 */
export function createVercelAILLM(config: LLMProviderConfig): LLM {
  const provider = createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    headers: config.headers,
  });

  const model = provider.chatModel(config.model);
  const maxOutputTokens = config.maxTokens ?? 2048;

  return {
    async *stream(opts) {
      const result = streamText({
        model,
        system: opts.system,
        messages: opts.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        maxOutputTokens,
      });
      for await (const chunk of result.textStream) {
        yield chunk;
      }
    },

    async complete(prompt) {
      const { text } = await generateText({
        model,
        prompt,
        maxOutputTokens,
      });
      return text.trim();
    },
  };
}

/**
 * Collect text from a generateText result.
 *
 * Some models (e.g. Kimi K2.5) end on a tool-call step with no trailing text.
 * AI SDK v6 only puts text from the final step into result.text, so it's empty.
 *
 * Strategy:
 * 1. Use result.text if non-empty (happy path)
 * 2. Gather text fragments from all steps
 * 3. If still empty, synthesize a summary from tool call results
 */
export function collectStepText(result: { text: string; steps: StepResult<ToolSet>[] }): string {
  if (result.text) return result.text;

  const textParts: string[] = [];
  for (const step of result.steps) {
    if (step.text) textParts.push(step.text);
  }
  if (textParts.length > 0) return textParts.join('\n\n');

  // No text in any step — synthesize from tool results
  const toolSummaries: string[] = [];
  for (const step of result.steps) {
    for (const tr of step.toolResults) {
      const output = (tr as any).output ?? (tr as any).result ?? '';
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      toolSummaries.push(`[${tr.toolName}] ${text.slice(0, 500)}`);
    }
  }
  return toolSummaries.length > 0
    ? toolSummaries.join('\n')
    : '(no response)';
}
