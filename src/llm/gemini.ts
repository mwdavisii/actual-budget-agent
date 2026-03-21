import { GoogleGenerativeAI, type Content, type FunctionDeclaration, type Part } from '@google/generative-ai';
import type { LLMProvider, LLMResponse, ChatMessage, ToolDefinition } from './types';

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async chat(opts: {
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<LLMResponse> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: opts.system,
      tools: [{
        functionDeclarations: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as FunctionDeclaration['parameters'],
        })),
      }],
      generationConfig: { maxOutputTokens: opts.maxTokens },
    });

    const history = this.convertHistory(opts.messages.slice(0, -1));
    const chat = model.startChat({ history });

    const lastMsg = opts.messages[opts.messages.length - 1];
    const parts = this.convertMessageToParts(lastMsg);
    const result = await chat.sendMessage(parts);
    const response = result.response;

    let text = '';
    const toolCalls: LLMResponse['toolCalls'] = [];

    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) {
          text += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            input: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }

    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'end',
    };
  }

  private convertHistory(messages: ChatMessage[]): Content[] {
    const result: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'user' && msg.toolResults) {
        result.push({
          role: 'function',
          parts: msg.toolResults.map((tr) => ({
            functionResponse: {
              name: tr.toolCallId,
              response: JSON.parse(tr.content),
            },
          })),
        });
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const parts: Part[] = [];
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.input } });
        }
        result.push({ role: 'model', parts });
      } else {
        result.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return result;
  }

  private convertMessageToParts(msg: ChatMessage): Part[] {
    if (msg.toolResults) {
      return msg.toolResults.map((tr) => ({
        functionResponse: {
          name: tr.toolCallId,
          response: JSON.parse(tr.content),
        },
      }));
    }
    return [{ text: msg.content }];
  }
}
