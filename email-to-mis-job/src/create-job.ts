import type { Env, ExtractedJob, R2Upload } from './types.js';

const DEFAULT_WCP_CONNECTION_ID = '49178064-6e4e-45b3-b7eb-f066b445d323';
const DEFAULT_WCP_CONNECTION_NAME = 'Production-Demo-PALA';

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

  // Task assignee info
  if (extracted.task_assignee) {
    const ta = extracted.task_assignee;
    parts.push(`\n--- Task Assignee ---`);
    parts.push(`Email: ${ta.email}`);
    parts.push(`Source: ${ta.source === 'third_party' ? 'Third party (design agency / external contact)' : ta.source === 'sender' ? 'Requester (sender wants upload link)' : 'Default'}`);
    if (ta.reasoning) parts.push(`Reasoning: ${ta.reasoning}`);
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

  // Determine task assignee: extracted from email or fallback to default
  const assigneeEmail = extracted.task_assignee?.email || DEFAULT_ASSIGNEE;
  const assigneeSource = extracted.task_assignee?.source || 'default';

  // Build task subject/message based on assignee source
  let taskSubject = `Upload files for: ${extracted.job_name}`;
  let taskMessage = extracted.description || 'Please upload the required files for this job.';
  if (assigneeSource === 'third_party') {
    taskSubject = `Artwork requested: ${extracted.job_name}`;
    taskMessage = `You have been identified as the contact for artwork/files for this job. Please upload the required files.\n\n${extracted.description || ''}`;
  } else if (assigneeSource === 'sender') {
    taskSubject = `Upload your files: ${extracted.job_name}`;
    taskMessage = `As requested, please use this task to upload your files for the job.\n\n${extracted.description || ''}`;
  }

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
          subject: taskSubject,
          message: taskMessage,
        },
        assignee: [{ id: assigneeEmail }],
      },
    ],
  };

  if (extracted.description) {
    payload.description = extracted.description;
  }

  return payload;
}

function buildS2Payload(jobId: string, extracted: ExtractedJob): any {
  const rawDueDate = extracted.due_date || new Date(Date.now() + 7 * 86400000).toISOString();
  const dueDateIso = new Date(rawDueDate).toISOString();

  const properties: any = {
    MISId: 'MyMIS',
    jobId,
    projectName: extracted.job_name,
    description: extracted.description || '',
    dueDate: dueDateIso,
    status: { type: 'ProjectStatus', status: 'Created' },
  };

  // Customer reference (S2 uses nodeId — partnerId won't work; store as-is for now)
  if (extracted.customer_match?.partnerId) {
    properties.customers = [{ ref: extracted.customer_match.partnerId, type: 'Reference' }];
  }

  // Attributes
  const attrs: Record<string, string> = {};
  if (extracted.project_type) attrs.projectType = extracted.project_type;
  else attrs.projectType = 'Prepress'; // default
  if (Object.keys(attrs).length) {
    properties.attributes = { string: attrs };
  }

  // Barcodes
  if (extracted.barcodes?.length) {
    properties['Job-Barcodes'] = extracted.barcodes.map(b => ({
      encoding: b.encoding || '',
      encodingDetails: b.encodingDetails || '',
      value: Array.isArray(b.value) ? b.value : [b.value],
    }));
  }

  return { properties };
}

export async function createMisJob(
  env: Env,
  extracted: ExtractedJob,
  r2Uploads: R2Upload[]
): Promise<any> {
  const jobId = generateJobId();
  const description = buildDescription(extracted, r2Uploads);
  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const connectionId = env.DEFAULT_MIS_CONNECTION_ID || DEFAULT_WCP_CONNECTION_ID;
  const apiVersion = env.DEFAULT_MIS_API_VERSION || 'legacy';
  const isS2 = apiVersion === 's2';

  if (isS2) {
    // S2: create project directly via API proxy
    const s2Payload = buildS2Payload(jobId, extracted);
    // Add description with full context (specs, file refs, customer match)
    s2Payload.properties.description = description;

    const projectResp = await fetch(`${apiUrl}/mis/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
        'X-MIS-Connection-Id': connectionId,
      },
      body: JSON.stringify(s2Payload),
    });

    let projectResult: any;
    const respText = await projectResp.text();
    try { projectResult = JSON.parse(respText); } catch { projectResult = { rawResponse: respText.slice(0, 500) }; }

    if (!projectResp.ok) {
      throw new Error(`Failed to create S2 project: ${projectResp.status} ${respText.slice(0, 300)}`);
    }

    // Store job record in Supabase for monitoring
    const jobRecord = {
      job_id: jobId,
      job_name: extracted.job_name,
      customer_code: extracted.customer_match?.partnerId || '',
      customer_name: extracted.customer_match?.partnerName || '',
      status: 'Created',
      phase: 'Intake',
      due_date: extracted.due_date || null,
      description,
      connection_id: connectionId,
      connection_name: '',
      solution: 's2',
      cluster: '',
      payload: s2Payload,
      wcp_response: projectResult,
      project_node_id: projectResult?.id || null,
    };

    const storeResp = await fetch(`${apiUrl}/mis/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
      },
      body: JSON.stringify(jobRecord),
    });

    if (!storeResp.ok) {
      console.warn('S2 project created but failed to store job record:', await storeResp.text());
    }

    return storeResp.ok ? await storeResp.json() : jobRecord;
  }

  // Legacy WCP: create draft job record
  const wcpPayload = buildWcpPayload(jobId, extracted);

  const jobRecord = {
    job_id: jobId,
    job_name: extracted.job_name,
    customer_code: extracted.customer_match?.partnerId || '',
    customer_name: extracted.customer_match?.partnerName || '',
    status: 'Draft',
    phase: 'Intake',
    due_date: extracted.due_date || null,
    description,
    connection_id: connectionId,
    connection_name: connectionId === DEFAULT_WCP_CONNECTION_ID ? DEFAULT_WCP_CONNECTION_NAME : '',
    solution: 'wcp',
    cluster: 'eu',
    payload: wcpPayload,
    wcp_response: null,
  };

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
