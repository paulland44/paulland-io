import PostalMime from 'postal-mime';
import type { ParsedEmail, RawAttachment } from './types.js';

export async function parseEmail(raw: ReadableStream | ArrayBuffer): Promise<ParsedEmail> {
  const rawBytes = raw instanceof ReadableStream ? await streamToArrayBuffer(raw) : raw;
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBytes);

  const from = parsed.from ?? { address: '', name: '' };

  const attachments: RawAttachment[] = (parsed.attachments ?? []).map((att) => ({
    filename: att.filename || 'unnamed',
    mimeType: att.mimeType || 'application/octet-stream',
    content: att.content,
  }));

  return {
    from: { address: from.address ?? '', name: from.name ?? '' },
    subject: parsed.subject || '',
    date: parsed.date || new Date().toISOString(),
    textBody: parsed.text || '',
    htmlBody: parsed.html || '',
    attachments,
  };
}

async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
