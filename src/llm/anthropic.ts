import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResponse, ChatMessage, ToolDefinition } from './types';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(opts: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<LLMResponse> {
    const messages = this.convertMessages(opts.messages);
    const tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools,
      messages,
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('\n');

    const toolCalls = response.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const tu = b as Anthropic.ToolUseBlock;
        return { id: tu.id, name: tu.name, input: tu.input as Record<string, unknown> };
      });

    return {
      text,
      toolCalls,
      finishReason: response.stop_reason === 'tool_use' ? 'tool_use' : 'end',
    };
  }

  private convertMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'user' && msg.toolResults) {
        result.push({
          role: 'user',
          content: msg.toolResults.map((tr) => ({
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: tr.content,
          })),
        });
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        for (const tc of msg.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        result.push({ role: 'assistant', content: blocks });
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }
}
