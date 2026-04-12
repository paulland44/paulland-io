import type { Env, PromptData, ProcessingResult, ClassifiedAttachment, R2Upload } from './types.js';
import { parseEmail } from './parse-email.js';
import { classifyAttachments } from './classify.js';
import { uploadAttachments } from './store.js';
import { extractJob } from './extract-job.js';
import { createMisJob } from './create-job.js';

async function resolveEmailRoute(subject: string, env: Env): Promise<{ cleanSubject: string; connectionId: string | null; autoSubmit: boolean; prefix: string | null }> {
  // Check for PREFIX: pattern at start of subject
  const match = subject.match(/^([A-Za-z0-9]+):\s*/);
  if (!match) return { cleanSubject: subject, connectionId: null, autoSubmit: false, prefix: null };

  const prefix = match[1].toUpperCase();
  const cleanSubject = subject.slice(match[0].length).trim();

  // Query Supabase for a connection with this email_prefix
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const resp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/mis_connections?email_prefix=ilike.${encodeURIComponent(prefix)}&select=id,api_version,type,name&limit=1`,
        {
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Accept': 'application/json',
          },
        }
      );
      if (resp.ok) {
        const rows = await resp.json() as any[];
        if (rows.length > 0) {
          return { cleanSubject, connectionId: rows[0].id, autoSubmit: true, prefix };
        }
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] Supabase prefix lookup failed: ${err.message}`);
    }
  }

  // No match in DB — check if it's the legacy A:/AUTO: prefix
  if (prefix === 'A' || prefix === 'AUTO') {
    return { cleanSubject, connectionId: null, autoSubmit: true, prefix };
  }

  // Prefix didn't match any connection — might be part of the actual subject (e.g. "RE: Something")
  return { cleanSubject: subject, connectionId: null, autoSubmit: false, prefix: null };
}

async function processEmail(
  rawEmail: ReadableStream | ArrayBuffer,
  env: Env
): Promise<ProcessingResult> {
  const logs: string[] = [];
  const log = (msg: string) => {
    console.log(`[email-to-mis] ${msg}`);
    logs.push(msg);
  };

  // 1. Parse email
  log('Parsing email...');
  const parsed = await parseEmail(rawEmail);
  log(`From: ${parsed.from.name} <${parsed.from.address}>`);
  log(`Subject: ${parsed.subject}`);
  log(`Attachments: ${parsed.attachments.length}`);

  // 2. Classify attachments
  const classified = classifyAttachments(parsed.attachments);
  for (const att of classified) {
    log(`  ${att.filename}: ${att.category} (${(att.sizeBytes / 1024).toFixed(1)}KB)`);
  }

  // 3. Generate a job ID prefix for R2 storage
  const jobIdPrefix = `email-${Date.now()}`;

  // 4. Upload artwork/binary attachments to R2
  const artworkAndBinary = classified.filter(
    (a) => a.category === 'artwork-pdf' || a.category === 'binary'
  );
  let r2Uploads: R2Upload[] = [];
  if (artworkAndBinary.length > 0) {
    log(`Uploading ${artworkAndBinary.length} files to R2...`);
    try {
      r2Uploads = await uploadAttachments(env, jobIdPrefix, classified);
      log(`Uploaded ${r2Uploads.length} files to R2`);
    } catch (err: any) {
      log(`R2 upload failed (non-blocking): ${err.message}`);
    }
  }

  // 5. Build prompt data
  const textPdfs = classified.filter((a) => a.category === 'text-pdf');
  const textDocs = classified.filter((a) => a.category === 'text');
  const artworkPdfs = classified.filter((a) => a.category === 'artwork-pdf');
  const binaryFiles = classified.filter((a) => a.category === 'binary');

  // For v1, we note text PDFs and docs but don't extract their text
  const attachmentTexts = buildAttachmentNotes(textPdfs, textDocs);

  // Parse subject prefix for connection routing (e.g. "QA: Job Name" → route to QA connection)
  const { cleanSubject, connectionId: routedConnId, autoSubmit, prefix: routedPrefix } = await resolveEmailRoute(parsed.subject, env);
  if (routedPrefix) log(`Route prefix "${routedPrefix}" → connection ${routedConnId}, auto-submit: ${autoSubmit}`);

  const promptData: PromptData = {
    from_name: parsed.from.name,
    from_email: parsed.from.address,
    subject: cleanSubject,
    date: parsed.date,
    body_text: parsed.textBody || stripHtml(parsed.htmlBody),
    attachment_texts: attachmentTexts,
    artwork_filenames: artworkPdfs.map((a) => a.filename),
    other_filenames: binaryFiles.map((a) => a.filename),
  };

  // 6. Call Workers AI for structured extraction
  log('Calling Workers AI for job extraction...');
  const extracted = await extractJob(env, promptData);
  log(`Extracted job: ${extracted.job_name}`);
  if (extracted.customer_match) {
    log(`Customer: ${extracted.customer_match.partnerName} (${extracted.customer_match.confidence})`);
  } else {
    log('No customer match found');
  }

  // 7. Create job using routed connection (S2: creates project directly; WCP: creates Draft, optionally submits)
  // Pass classified attachments so S2 path can upload them as project assets
  log(autoSubmit ? 'Creating and submitting MIS job...' : 'Creating Draft MIS job...');
  const jobRecord = await createMisJob(env, extracted, r2Uploads, autoSubmit, routedConnId || undefined, classified);
  log(`Job created: ${JSON.stringify(jobRecord)}`);

  return { extracted, jobRecord, r2Uploads, logs };
}

function buildAttachmentNotes(
  textPdfs: ClassifiedAttachment[],
  textDocs: ClassifiedAttachment[]
): string {
  const notes: string[] = [];

  if (textPdfs.length > 0) {
    notes.push(
      `Text PDF attachments (content not extracted in v1): ${textPdfs.map((a) => a.filename).join(', ')}`
    );
  }
  if (textDocs.length > 0) {
    notes.push(
      `Document attachments (content not extracted in v1): ${textDocs.map((a) => a.filename).join(', ')}`
    );
  }

  return notes.join('\n') || 'None';
}

function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

// --- Worker entry points ---

export default {
  // Production email handler (Cloudflare Email Routing)
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[email-to-mis] Received email from ${message.from} to ${message.to}`);
    console.log(`[email-to-mis] Subject: ${message.headers.get('subject')}`);

    try {
      const result = await processEmail(message.raw, env);
      console.log(`[email-to-mis] Successfully created job: ${result.extracted.job_name}`);
    } catch (err: any) {
      console.error(`[email-to-mis] Failed to process email: ${err.message}`);
      console.error(err.stack);
    }
  },

  // HTTP test endpoint (for local dev since wrangler dev doesn't support email events)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'email-to-mis-job' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Test endpoint — POST /test with raw email content
    if (url.pathname === '/test' && request.method === 'POST') {
      // Verify test secret
      const secret = request.headers.get('X-Test-Secret');
      if (!secret || secret !== env.TEST_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      try {
        const contentType = request.headers.get('Content-Type') || '';
        let rawEmail: ArrayBuffer;

        if (contentType.includes('application/json')) {
          // Accept JSON with base64-encoded email
          const body = await request.json() as { email: string };
          rawEmail = base64ToArrayBuffer(body.email);
        } else {
          // Accept raw email content directly
          rawEmail = await request.arrayBuffer();
        }

        const result = await processEmail(rawEmail, env);

        return new Response(
          JSON.stringify({
            success: true,
            extracted: result.extracted,
            jobRecord: result.jobRecord,
            r2Uploads: result.r2Uploads,
            logs: result.logs,
          }, null, 2),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            success: false,
            error: err.message,
            stack: err.stack,
          }, null, 2),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
