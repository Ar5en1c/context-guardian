import { createParser, type EventSourceMessage } from 'eventsource-parser';

export async function streamSSEResponse(
  upstreamResponse: Response,
  writable: WritableStream<Uint8Array>,
): Promise<void> {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    const writer = writable.getWriter();
    await writer.close();
    return;
  }

  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
  } catch (err) {
    const errorChunk = encoder.encode(
      `data: ${JSON.stringify({ error: err instanceof Error ? err.message : 'stream error' })}\n\n`
    );
    try {
      await writer.write(errorChunk);
    } catch {
      // writer may be closed
    }
  } finally {
    try {
      await writer.close();
    } catch {
      // ignore
    }
  }
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

export function createSSEHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Context-Guardian': 'streaming',
  };
}
