import type { Env, ExtractedJob, R2Upload, ClassifiedAttachment } from './types.js';

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
  const dueDateIso = safeDateIso(extracted.due_date);
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

function safeDateIso(raw: string | null | undefined, fallbackDays = 7): string {
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(Date.now() + fallbackDays * 86400000).toISOString();
}

async function buildS2Payload(jobId: string, extracted: ExtractedJob, env: Env, apiUrl: string, connectionId: string): Promise<any> {
  const dueDateIso = safeDateIso(extracted.due_date);

  const properties: any = {
    MISId: 'MyMIS',
    jobId,
    projectName: extracted.job_name,
    description: extracted.description || '',
    dueDate: dueDateIso,
    status: { type: 'ProjectStatus', status: 'Created' },
  };

  // Customer reference — S2 requires valid node IDs, not legacy partner codes
  // If we have a legacy partnerId (like "DFG"), look up the S2 customer by name
  const custId = extracted.customer_match?.partnerId;
  const custName = extracted.customer_match?.partnerName;
  let s2CustomerRef: string | null = null;

  if (custId && custId.includes('-') && custId.length > 20) {
    // Already an S2 node ID
    s2CustomerRef = custId;
  } else if (custId || custName) {
    // Legacy partnerId — look up S2 customer by name match
    const searchTerm = custId || custName || '';
    try {
      const custResp = await fetch(
        `${apiUrl}/mis/customers`,
        { headers: { 'Accept': 'application/json', 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY, 'X-MIS-Connection-Id': connectionId } }
      );
      if (custResp.ok) {
        const custData = await custResp.json() as any;
        const customers = custData?.items || custData?.data || (Array.isArray(custData) ? custData : []);
        const match = customers.find((c: any) => {
          const name = (c.name || c.partnerName || '').toLowerCase();
          const id = (c.partnerId || '').toLowerCase();
          const term = searchTerm.toLowerCase();
          return name === term || id === term || name.includes(term) || term.includes(name);
        });
        if (match) {
          s2CustomerRef = match.id || match.nodeId;
          console.log(`[email-to-mis] Matched S2 customer: "${searchTerm}" → ${match.name} (${s2CustomerRef})`);
        }
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] Customer lookup failed: ${err.message}`);
    }
  }

  if (s2CustomerRef) {
    properties.customers = [{ ref: s2CustomerRef, type: 'Reference' }];
  }
  // Note: if no customer found, omit customers field entirely — the "no customer"
  // path in createMisJob will create a Draft instead of submitting to S2

  // Attributes
  const attrs: Record<string, string> = {};
  if (extracted.project_type) attrs.projectType = extracted.project_type;
  else attrs.projectType = 'Prepress'; // default
  if (Object.keys(attrs).length) {
    properties.attributes = { string: attrs };
  }

  // Barcodes
  if (extracted.barcodes?.length) {
    // Map AI-extracted encoding names to S2 API enum values
    const ENCODING_MAP: Record<string, string> = {
      'EAN-13': 'EAN_13', 'EAN-8': 'EAN_8', 'UPC-A': 'UPC_A', 'UPC-E': 'UPC_E',
      'Code128': 'Code128', 'Code39': 'Code39', 'GS1-128': 'GS1-128',
      'GS1-QR': 'GS1-QR', 'QR': 'QR', 'QR Code': 'QR',
      'GS1-DataMatrix': 'GS1-DataMatrix', 'DataMatrix': 'DATAMATRIX',
      'ITF-14': 'ITF_14', 'GS1-DataBar': 'GS1-DataBar-Omnidirectional',
    };
    properties['Job-Barcodes'] = extracted.barcodes.map(b => {
      const enc = ENCODING_MAP[b.encoding] || b.encoding?.replace(/-/g, '_') || '';
      const bc: any = {
        encoding: enc,
        value: Array.isArray(b.value) ? b.value.filter(v => v && v !== 'null') : (b.value && b.value !== 'null' ? [b.value] : []),
      };
      const det = b.encodingDetails;
      if (det && det !== 'null' && det !== enc) bc.encodingDetails = det;
      return bc;
    });
  }

  return { properties };
}

async function uploadAssetsToS2(
  env: Env,
  projectNodeId: string,
  connectionId: string,
  attachments: ClassifiedAttachment[],
  r2Uploads: R2Upload[]
): Promise<{ uploaded: string[]; failed: string[] }> {
  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
    'X-MIS-Connection-Id': connectionId,
  };
  const uploaded: string[] = [];
  const failed: string[] = [];

  for (const upload of r2Uploads) {
    const att = attachments.find(a => a.filename === upload.filename);
    if (!att) { failed.push(upload.filename); continue; }

    // Warn for large files (>10MB)
    if (att.sizeBytes > 10 * 1024 * 1024) {
      console.warn(`[email-to-mis] Large file: ${upload.filename} (${(att.sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
    }

    try {
      // Step 1: Create asset reference in the project
      const createResp = await fetch(`${apiUrl}/mis/projects/${projectNodeId}/assets`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ relUrl: `Input/${upload.filename}` }),
      });
      if (!createResp.ok) {
        const err = await createResp.text().catch(() => '');
        console.warn(`[email-to-mis] Failed to create asset ref for ${upload.filename}: ${createResp.status} ${err.slice(0, 200)}`);
        failed.push(upload.filename);
        continue;
      }
      const assetResult = await createResp.json() as any;
      const assetId = assetResult?.id;
      if (!assetId) {
        console.warn(`[email-to-mis] No asset ID returned for ${upload.filename}`);
        failed.push(upload.filename);
        continue;
      }

      // Step 2: Upload file content to the asset
      let content: ArrayBuffer | Uint8Array;
      if (att.content instanceof ArrayBuffer) {
        content = att.content;
      } else if (att.content instanceof Uint8Array) {
        content = att.content;
      } else {
        content = new TextEncoder().encode(att.content as string);
      }

      const uploadResp = await fetch(`${apiUrl}/mis/assets/${assetId}/content`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': att.mimeType || 'application/octet-stream' },
        body: content,
      });
      if (uploadResp.ok) {
        console.log(`[email-to-mis] Uploaded ${upload.filename} to S2 asset ${assetId}`);
        uploaded.push(upload.filename);
      } else {
        const err = await uploadResp.text().catch(() => '');
        console.warn(`[email-to-mis] Failed to upload content for ${upload.filename}: ${uploadResp.status} ${err.slice(0, 200)}`);
        failed.push(upload.filename);
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] Asset upload error for ${upload.filename}: ${err.message}`);
      failed.push(upload.filename);
    }
  }

  return { uploaded, failed };
}

async function cleanupR2(env: Env, r2Uploads: R2Upload[], uploadedFiles: string[]): Promise<void> {
  for (const upload of r2Uploads) {
    if (!uploadedFiles.includes(upload.filename)) continue; // Only delete successfully uploaded files
    try {
      await env.R2_BUCKET.delete(upload.r2Key);
      console.log(`[email-to-mis] Deleted R2 file: ${upload.r2Key}`);
    } catch (err: any) {
      console.warn(`[email-to-mis] Failed to delete R2 file ${upload.r2Key}: ${err.message}`);
    }
  }
}

export async function createMisJob(
  env: Env,
  extracted: ExtractedJob,
  r2Uploads: R2Upload[],
  autoSubmit = false,
  overrideConnectionId?: string,
  attachments?: ClassifiedAttachment[]
): Promise<any> {
  const jobId = generateJobId();
  const description = buildDescription(extracted, r2Uploads);
  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const connectionId = overrideConnectionId || env.DEFAULT_MIS_CONNECTION_ID || DEFAULT_WCP_CONNECTION_ID;

  // Determine api_version by looking up the connection from Supabase
  let apiVersion = env.DEFAULT_MIS_API_VERSION || 'legacy';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const connResp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/mis_connections?id=eq.${connectionId}&select=api_version,type,name&limit=1`,
        {
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Accept': 'application/json',
          },
        }
      );
      if (connResp.ok) {
        const rows = await connResp.json() as any[];
        if (rows.length > 0 && rows[0].api_version) {
          apiVersion = rows[0].api_version;
          console.log(`[email-to-mis] Connection ${rows[0].name}: api_version=${apiVersion}`);
        }
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] Failed to look up connection: ${err.message}`);
    }
  }
  const isS2 = apiVersion === 's2';

  if (isS2) {
    const s2Payload = await buildS2Payload(jobId, extracted, env, apiUrl, connectionId);
    s2Payload.properties.description = description;

    // If no customer was resolved (neither S2 node ID nor name match), skip S2 submission
    const hasCustomer = !!(s2Payload.properties.customers?.length);
    if (!hasCustomer) {
      console.log('[email-to-mis] No customer matched — creating Draft (customer required for S2 submission)');
      const draftRecord = {
        job_id: jobId,
        job_name: extracted.job_name,
        customer_code: '',
        customer_name: '',
        status: 'Draft',
        phase: 'Action Needed',
        due_date: extracted.due_date || null,
        description: '⚠️ Customer not identified — please select a customer and submit manually.\n\n' + description,
        connection_id: connectionId,
        connection_name: '',
        solution: 's2',
        cluster: '',
        payload: s2Payload,
        wcp_response: { note: 'Customer not matched from email. Assign a customer in the form and submit.' },
      };

      const draftResp = await fetch(`${apiUrl}/mis/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY },
        body: JSON.stringify(draftRecord),
      });
      return draftResp.ok ? await draftResp.json() : draftRecord;
    }

    // S2: create project directly via API proxy
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
      console.warn(`[email-to-mis] S2 project creation failed (${projectResp.status}): ${respText.slice(0, 300)}`);
      console.warn('[email-to-mis] Falling back to Draft job record');
      // Fall back to storing as Draft (can be submitted manually later)
      const fallbackRecord = {
        job_id: jobId,
        job_name: extracted.job_name,
        customer_code: extracted.customer_match?.partnerId || '',
        customer_name: extracted.customer_match?.partnerName || '',
        status: 'Draft',
        phase: 'Intake',
        due_date: extracted.due_date || null,
        description,
        connection_id: connectionId,
        connection_name: '',
        solution: 's2',
        cluster: '',
        payload: s2Payload,
        wcp_response: { error: `S2 creation failed: ${projectResp.status}`, detail: respText.slice(0, 500) },
      };

      const fallbackResp = await fetch(`${apiUrl}/mis/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY },
        body: JSON.stringify(fallbackRecord),
      });

      return fallbackResp.ok ? await fallbackResp.json() : fallbackRecord;
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

    // Upload attachments to S2 project as assets, then clean up R2
    if (projectResult?.id && attachments?.length && r2Uploads.length) {
      console.log(`[email-to-mis] Uploading ${r2Uploads.length} attachments to S2 project ${projectResult.id}...`);
      const { uploaded, failed } = await uploadAssetsToS2(env, projectResult.id, connectionId, attachments, r2Uploads);
      if (uploaded.length) {
        console.log(`[email-to-mis] Uploaded ${uploaded.length} assets to S2. Cleaning up R2...`);
        await cleanupR2(env, r2Uploads, uploaded);
      }
      if (failed.length) {
        console.warn(`[email-to-mis] Failed to upload ${failed.length} assets: ${failed.join(', ')} (kept in R2)`);
      }
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

  const createdJob = await response.json();

  // Auto-submit WCP job if requested (A: prefix in subject)
  if (autoSubmit && !isS2) {
    console.log(`[email-to-mis] Auto-submitting WCP job ${jobId}...`);
    try {
      const submitResp = await fetch(`${apiUrl}/mis/create-job`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
          'X-MIS-Connection-Id': connectionId,
        },
        body: JSON.stringify(wcpPayload),
      });
      const submitText = await submitResp.text();
      let submitResult: any;
      try { submitResult = JSON.parse(submitText); } catch { submitResult = { rawResponse: submitText.slice(0, 500) }; }

      if (submitResp.ok) {
        // Update job record to Created status
        const jobDbId = Array.isArray(createdJob) ? (createdJob[0] as any)?.id : (createdJob as any)?.id;
        if (jobDbId) {
          await fetch(`${apiUrl}/mis/jobs/${jobDbId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY },
            body: JSON.stringify({ status: 'Created', wcp_response: submitResult }),
          });
        }
        console.log(`[email-to-mis] WCP job ${jobId} auto-submitted successfully`);
      } else {
        console.warn(`[email-to-mis] WCP auto-submit failed (${submitResp.status}): ${submitText.slice(0, 300)}`);
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] WCP auto-submit error: ${err.message}`);
    }
  }

  return createdJob;
}
