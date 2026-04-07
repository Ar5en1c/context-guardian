import { createParser, type EventSourceMessage } from 'eventsource-parser';

export function createSSEHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Context-Guardian': 'streaming',
  };
}

export function synthesizeSSEStream(jsonResponse: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const data = jsonResponse as {
    id?: string;
    model?: string;
    choices?: Array<{
      index?: number;
      message?: { role?: string; content?: string };
      finish_reason?: string;
    }>;
    usage?: Record<string, unknown>;
  };

  const id = data.id || 'chatcmpl-guardian';
  const model = data.model || 'unknown';
  const content = data.choices?.[0]?.message?.content || '';
  const finishReason = data.choices?.[0]?.finish_reason || 'stop';

  return new ReadableStream({
    start(controller) {
      // Role chunk
      const roleChunk = {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

      // Content chunks (split into ~20-char pieces to simulate streaming)
      const chunkSize = 20;
      for (let i = 0; i < content.length; i += chunkSize) {
        const piece = content.slice(i, i + chunkSize);
        const contentChunk = {
          id,
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
      }

      // Final chunk
      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

export function synthesizeAnthropicSSEStream(jsonResponse: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const data = jsonResponse as {
    id?: string;
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const id = data.id || 'msg_guardian';
  const model = data.model || 'unknown';
  const textBlocks = (data.content || []).filter((b) => b.type === 'text' && b.text);
  const fullText = textBlocks.map((b) => b.text || '').join('');
  const stopReason = data.stop_reason || 'end_turn';
  const usage = data.usage || { input_tokens: 0, output_tokens: 0 };

  return new ReadableStream({
    start(controller) {
      const emit = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };

      emit('message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens || 0, output_tokens: 0 } },
      });

      emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

      const chunkSize = 20;
      for (let i = 0; i < fullText.length; i += chunkSize) {
        const piece = fullText.slice(i, i + chunkSize);
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      }

      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output_tokens || 0 } });
      emit('message_stop', { type: 'message_stop' });
      controller.close();
    },
  });
}

export function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
  onDone: () => void,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === '[DONE]') {
        onDone();
        return;
      }
      onEvent(event.data);
    },
  });

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      onDone();
    }
  })();
}
