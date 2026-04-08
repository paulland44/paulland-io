import type { Env, ExtractedJob, R2Upload } from './types.js';

const WCP_CONNECTION_ID = '49178064-6e4e-45b3-b7eb-f066b445d323';
const WCP_CONNECTION_NAME = 'Production-Demo-PALA';

function generateJobId(): string {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  // Use time-based suffix (HHMM + random) to avoid collisions across invocations
  const hhmm = now.toISOString().slice(11, 16).replace(':', '');
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `EMAIL-${dateStamp}-${hhmm}${rand}`;
}

function buildDescription(extracted: ExtractedJob, r2Uploads: R2Upload[]): string {
  const parts: string[] = [];

  if (extracted.description) {
    parts.push(extracted.description);
  }

  // Add spec details not already in the description
  const specs: string[] = [];
  if (extracted.print_process) specs.push(`Print process: ${extracted.print_process}`);
  if (extracted.substrate) specs.push(`Substrate: ${extracted.substrate}`);
  if (extracted.quantity) specs.push(`Quantity: ${extracted.quantity}`);
  if (extracted.is_reprint !== null) specs.push(`Reprint: ${extracted.is_reprint ? 'Yes' : 'No'}`);

  if (specs.length > 0) {
    parts.push('\n--- Extracted Specs ---');
    parts.push(specs.join('\n'));
  }

  // Reference stored files
  const artworkFiles = r2Uploads.filter((u) => u.category === 'artwork-pdf');
  const otherFiles = r2Uploads.filter((u) => u.category === 'binary');

  if (artworkFiles.length > 0) {
    parts.push('\n--- Artwork Files (R2) ---');
    parts.push(artworkFiles.map((f) => `- ${f.filename} [${f.r2Key}]`).join('\n'));
  }

  if (otherFiles.length > 0) {
    parts.push('\n--- Other Attachments (R2) ---');
    parts.push(otherFiles.map((f) => `- ${f.filename} [${f.r2Key}]`).join('\n'));
  }

  // Customer match info
  if (extracted.customer_match) {
    const cm = extracted.customer_match;
    parts.push(`\n--- Customer Match ---`);
    parts.push(`Matched: "${cm.matched_text}" → ${cm.partnerName} (${cm.partnerId})`);
    parts.push(`Source: ${cm.matched_in} | Confidence: ${cm.confidence}`);
    if (cm.reasoning) parts.push(`Reasoning: ${cm.reasoning}`);
  }

  parts.push('\n[Created automatically from inbound email]');

  return parts.join('\n');
}

// Upload Task template from the WCP Production-Demo-PALA connection
const WCP_TASK_TEMPLATE_NODE_ID = '4mLnEgcoirDkEG-3afcnB4KT4';
const DEFAULT_ASSIGNEE = 'land.paul@pm.me';

function buildWcpPayload(jobId: string, extracted: ExtractedJob): any {
  // Ensure due date is always a full ISO timestamp (WCP rejects date-only strings)
  const rawDueDate = extracted.due_date || new Date(Date.now() + 7 * 86400000).toISOString();
  const dueDateIso = new Date(rawDueDate).toISOString(); // normalise to full ISO with Z
  const dueDateMs = new Date(dueDateIso).getTime();

  const payload: any = {
    siteName: 'Home',
    customerCode: extracted.customer_match?.partnerId || '',
    jobName: extracted.job_name,
    jobId: jobId,
    dueDate: dueDateIso,
    tasks: [
      {
        taskTemplateNodeId: WCP_TASK_TEMPLATE_NODE_ID,
        properties: {
          dueDate: dueDateMs,
          allowFiles: true,
        },
        assignee: [{ id: DEFAULT_ASSIGNEE }],
      },
    ],
  };

  if (extracted.description) {
    payload.description = extracted.description;
  }

  return payload;
}

export async function createMisJob(
  env: Env,
  extracted: ExtractedJob,
  r2Uploads: R2Upload[]
): Promise<any> {
  const jobId = generateJobId();
  const description = buildDescription(extracted, r2Uploads);
  const wcpPayload = buildWcpPayload(jobId, extracted);

  const jobRecord = {
    job_id: jobId,
    job_name: extracted.job_name,
    customer_code: extracted.customer_match?.partnerId || '',
    customer_name: extracted.customer_match?.partnerName || '',
    status: 'Draft',
    phase: 'Intake',
    due_date: extracted.due_date || null,
    description: description,
    connection_id: WCP_CONNECTION_ID,
    connection_name: WCP_CONNECTION_NAME,
    solution: 'wcp',
    cluster: 'eu',
    payload: wcpPayload,
    wcp_response: null,
  };

  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const response = await fetch(`${apiUrl}/mis/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
    },
    body: JSON.stringify(jobRecord),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create MIS job: ${response.status} ${errorText}`);
  }

  return response.json();
}
