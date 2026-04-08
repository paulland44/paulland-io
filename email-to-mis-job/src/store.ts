import type { Env, ClassifiedAttachment, R2Upload } from './types.js';

export async function uploadAttachments(
  env: Env,
  jobId: string,
  attachments: ClassifiedAttachment[]
): Promise<R2Upload[]> {
  const uploads: R2Upload[] = [];

  for (const att of attachments) {
    // Only upload artwork PDFs and binary files to R2
    // Text PDFs and text files are referenced in the description but not stored
    if (att.category === 'text-pdf' || att.category === 'text') continue;

    const key = `attachments/${jobId}/${att.filename}`;
    await env.R2_BUCKET.put(key, att.content, {
      httpMetadata: { contentType: att.mimeType },
      customMetadata: {
        category: att.category,
        originalSize: String(att.sizeBytes),
      },
    });

    uploads.push({
      filename: att.filename,
      r2Key: key,
      category: att.category,
    });
  }

  return uploads;
}
