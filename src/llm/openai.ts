import OpenAI from 'openai';
import type { LLMProvider, LLMResponse, ChatMessage, ToolDefinition } from './types';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(opts: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<LLMResponse> {
    const messages = this.convertMessages(opts.system, opts.messages);
    const tools: OpenAI.ChatCompletionTool[] = opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts.maxTokens,
      messages,
      tools,
    });

    const choice = response.choices[0];
    const text = choice.message.content ?? '';
    const toolCalls = (choice.message.tool_calls ?? [])
      .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));

    return {
      text,
      toolCalls,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end',
    };
  }

  private convertMessages(system: string, messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
    ];

    for (const msg of messages) {
      if (msg.role === 'user' && msg.toolResults) {
        for (const tr of msg.toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.content,
          });
        }
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }
}
