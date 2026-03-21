import type { LLMProvider } from './types';
export type { LLMProvider, LLMResponse, ChatMessage, ToolDefinition, ToolCall, ToolResult } from './types';

export type LLMProviderName = 'anthropic' | 'openai' | 'gemini';

const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
};

export function createLLMProvider(provider: LLMProviderName, apiKey: string, model?: string): LLMProvider {
  const resolvedModel = model ?? DEFAULT_MODELS[provider];

  switch (provider) {
    case 'anthropic': {
      const { AnthropicProvider } = require('./anthropic') as typeof import('./anthropic');
      return new AnthropicProvider(apiKey, resolvedModel);
    }
    case 'openai': {
      const { OpenAIProvider } = require('./openai') as typeof import('./openai');
      return new OpenAIProvider(apiKey, resolvedModel);
    }
    case 'gemini': {
      const { GeminiProvider } = require('./gemini') as typeof import('./gemini');
      return new GeminiProvider(apiKey, resolvedModel);
    }
    default:
      throw new Error(`Unknown LLM provider: ${provider}. Must be one of: anthropic, openai, gemini`);
  }
}
