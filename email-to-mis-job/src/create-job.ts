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
  if (extracted.packaging_type) specs.push(`Packaging: ${extracted.packaging_type}`);
  if (extracted.print_process) specs.push(`Print process: ${extracted.print_process}`);
  if (extracted.substrate) specs.push(`Substrate: ${extracted.substrate}`);
  if (extracted.substrate_weight) specs.push(`Substrate weight: ${extracted.substrate_weight}`);
  if (extracted.quantity) specs.push(`Quantity: ${extracted.quantity}`);
  if (extracted.dimensions) {
    const d = extracted.dimensions;
    specs.push(`Dimensions: ${d.width || '?'}x${d.height || '?'}${d.depth ? 'x' + d.depth : ''} ${d.unit || 'mm'}`);
  }
  if (extracted.num_colours) specs.push(`Colours: ${extracted.num_colours}`);
  if (extracted.colour_specs?.length) specs.push(`Colour specs: ${extracted.colour_specs.join(', ')}`);
  if (extracted.finishing?.length) specs.push(`Finishing: ${extracted.finishing.join(', ')}`);
  if (extracted.bleed) specs.push(`Bleed: ${extracted.bleed}`);
  if (extracted.is_reprint !== null) specs.push(`Reprint: ${extracted.is_reprint ? 'Yes' : 'No'}`);
  if (extracted.order_reference) specs.push(`Order ref: ${extracted.order_reference}`);
  if (extracted.request_type && extracted.request_type !== 'new_job') {
    const labels: Record<string, string> = { change_request: 'Change Request', new_artwork: 'New Artwork Submission', reprint: 'Reprint/Repeat Order' };
    specs.push(`Request type: ${labels[extracted.request_type] || extracted.request_type}`);
  }

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

// S2 barcode enum tables. encoding must be one of these values; encodingDetails
// must be a member of the encoding's detail list (or omitted). The AI extractor
// sometimes stuffs the barcode value into encodingDetails — without this gate,
// S2 rejects the whole project with schema_validation_error on Job-Barcodes.
const BARCODE_ENCODING_MAP: Record<string, string> = {
  'EAN-13': 'EAN_13', 'EAN-8': 'EAN_8', 'UPC-A': 'UPC_A', 'UPC-E': 'UPC_E',
  'Code128': 'Code128', 'Code39': 'Code39', 'GS1-128': 'GS1-128',
  'GS1-QR': 'GS1-QR', 'QR': 'QR', 'QR Code': 'QR',
  'GS1-DataMatrix': 'GS1-DataMatrix', 'DataMatrix': 'DATAMATRIX',
  'ITF-14': 'ITF_14', 'GS1-DataBar': 'GS1-DataBar-Omnidirectional',
};

const BARCODE_ENCODING_DETAILS: Record<string, string[]> = {
  EAN_13: ['EAN_13_Standard', 'EAN_13_Swissmedic', 'EAN_13_Iceland_Foods'],
  EAN_8: ['EAN_8_Standard', 'EAN_8_Marks_Spencer', 'EAN_8_M+S_7'],
  UPC_A: ['UPC_A_Standard', 'UPC_A_NDC_HRI'],
  Code128: ['Code128_Standard', 'Code128_HIBC'],
  Code39: ['Code39_Standard', 'Code39_HIBC', 'Code39_CIP'],
  Code93: ['Code39_Code32'],
  QR: ['QR_1','QR_2','QR_3','QR_4','QR_5','QR_6','QR_7','QR_8','QR_9','QR_10'],
  'GS1-QR': ['QR_1','QR_2','QR_3','QR_4','QR_5','QR_6','QR_7','QR_8','QR_9','QR_10'],
  DATAMATRIX: ['DM_10_by_10','DM_12_by_12','DM_14_by_14','DM_16_by_16','DM_18_by_18','DM_20_by_20','DM_22_by_22','DM_24_by_24','DM_26_by_26','DM_32_by_32'],
  'GS1-DataMatrix': ['DM_10_by_10','DM_12_by_12','DM_14_by_14','DM_16_by_16','DM_18_by_18','DM_20_by_20','DM_22_by_22','DM_24_by_24','DM_26_by_26','DM_32_by_32'],
};

function mapBarcode(b: any): any | null {
  const enc = BARCODE_ENCODING_MAP[b.encoding] || b.encoding?.replace(/-/g, '_') || '';
  if (!enc) return null;
  const value = Array.isArray(b.value)
    ? b.value.filter((v: any) => v && v !== 'null')
    : (b.value && b.value !== 'null' ? [b.value] : []);
  if (!value.length) return null;
  const bc: any = { encoding: enc, value };
  const det = b.encodingDetails;
  const validDetails = BARCODE_ENCODING_DETAILS[enc];
  // Only include encodingDetails if it's one of the valid enum values for this
  // encoding — and never if it duplicates the barcode value or the encoding name.
  if (
    det && det !== 'null' && det !== enc &&
    !value.includes(det) &&
    validDetails && validDetails.includes(det)
  ) {
    bc.encodingDetails = det;
  }
  return bc;
}

async function buildS2Payload(jobId: string, extracted: ExtractedJob, env: Env, apiUrl: string, connectionId: string): Promise<any> {
  const dueDateIso = safeDateIso(extracted.due_date);

  const properties: any = {
    MISId: 'MyMIS',
    jobId,
    projectName: `${extracted.job_name} ${jobId}`,
    description: extracted.description || '',
    dueDate: dueDateIso,
    status: { type: 'ProjectStatus', status: 'Created' },
  };

  // Customer reference — S2 requires valid node IDs, not legacy partner codes
  // Use searchValue API to find the matching S2 customer efficiently
  const custId = extracted.customer_match?.partnerId;
  const custName = extracted.customer_match?.partnerName;
  let s2CustomerRef: string | null = null;

  if (custId && custId.includes('-') && custId.length > 20) {
    // Already an S2 node ID
    s2CustomerRef = custId;
  } else if (custId || custName) {
    // Use S2 searchValue API — searches partnerName and partnerID server-side
    const headers = { 'Accept': 'application/json', 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY, 'X-MIS-Connection-Id': connectionId };
    const searchTerms = [custId, custName].filter(Boolean) as string[];

    for (const term of searchTerms) {
      try {
        const custResp = await fetch(
          `${apiUrl}/mis/customers?searchValue=${encodeURIComponent(term)}`,
          { headers }
        );
        if (custResp.ok) {
          const custData = await custResp.json() as any;
          const items = custData?.items || custData?.data || (Array.isArray(custData) ? custData : []);
          // Verify the result actually matches the search term (S2 may return all customers on no match)
          const termLower = term.toLowerCase();
          const match = items.find((c: any) => {
            const name = (c.name || '').toLowerCase();
            return name === termLower || name.includes(termLower) || termLower.includes(name);
          });
          if (match) {
            s2CustomerRef = match.id || match.nodeId;
            console.log(`[email-to-mis] Matched S2 customer via searchValue "${term}" → ${match.name} (${s2CustomerRef})`);
            // Also fetch detail to get partnerName for verification
            try {
              const detailResp = await fetch(`${apiUrl}/mis/customers/${s2CustomerRef}`, { headers });
              if (detailResp.ok) {
                const detail = await detailResp.json() as any;
                if (detail.partnerName) {
                  const pnLower = detail.partnerName.toLowerCase();
                  if (pnLower.includes(termLower) || termLower.includes(pnLower)) {
                    console.log(`[email-to-mis] Confirmed via partnerName: ${detail.partnerName}`);
                  }
                }
              }
            } catch {}
            break;
          } else if (items.length > 0) {
            console.log(`[email-to-mis] searchValue "${term}" returned ${items.length} results but none matched by name`);
          }
        }
      } catch (err: any) {
        console.warn(`[email-to-mis] Customer search failed for "${term}": ${err.message}`);
      }
    }
  }

  if (s2CustomerRef) {
    properties.customers = [{ ref: s2CustomerRef, type: 'Reference' }];
  }
  // Note: if no customer found, omit customers field entirely — the "no customer"
  // path in createMisJob will create a Draft instead of submitting to S2

  // Attributes — map all extracted packaging specs (S2 requires all values as strings)
  const attrs: Record<string, string> = {};
  const setAttr = (key: string, val: any) => { if (val != null && val !== '') attrs[key] = String(val); };
  setAttr('projectType', extracted.project_type || 'Prepress');
  setAttr('packagingType', extracted.packaging_type);
  if (extracted.dimensions) {
    const d = extracted.dimensions;
    setAttr('dimensions', `${d.width || '?'}x${d.height || '?'}${d.depth ? 'x' + d.depth : ''} ${d.unit || 'mm'}`);
  }
  setAttr('numColours', extracted.num_colours);
  if (extracted.colour_specs?.length) setAttr('colourSpecs', extracted.colour_specs.join(', '));
  if (extracted.finishing?.length) setAttr('finishing', extracted.finishing.join(', '));
  setAttr('substrateWeight', extracted.substrate_weight);
  setAttr('substrate', extracted.substrate);
  setAttr('bleed', extracted.bleed);
  setAttr('printProcess', extracted.print_process);
  setAttr('quantity', extracted.quantity);
  setAttr('requestType', extracted.request_type);
  if (Object.keys(attrs).length) {
    properties.attributes = { string: attrs };
  }

  // General IDs — order reference
  if (extracted.order_reference) {
    properties.generalIDs = { PrintBuyerReference: extracted.order_reference };
  }

  // Barcodes
  if (extracted.barcodes?.length) {
    const mapped = extracted.barcodes.map(mapBarcode).filter(Boolean);
    if (mapped.length) properties['Job-Barcodes'] = mapped;
  }

  return { properties };
}

async function uploadAssetsToS2(
  env: Env,
  projectNodeId: string,
  connectionId: string,
  attachments: ClassifiedAttachment[],
  r2Uploads: R2Upload[]
): Promise<{ uploaded: string[]; failed: string[]; assetIds: string[] }> {
  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
    'X-MIS-Connection-Id': connectionId,
  };
  const uploaded: string[] = [];
  const failed: string[] = [];
  const assetIds: string[] = [];

  for (const upload of r2Uploads) {
    const att = attachments.find(a => a.filename === upload.filename);
    if (!att) { failed.push(upload.filename); continue; }

    // Warn for large files (>10MB)
    if (att.sizeBytes > 10 * 1024 * 1024) {
      console.warn(`[email-to-mis] Large file: ${upload.filename} (${(att.sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
    }

    try {
      // Step 1: Create asset placeholder — returns { id, contentUri, contentId, version }
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
      const contentUri = assetResult?.contentUri;
      const contentId = assetResult?.contentId;
      const contentVersion = assetResult?.version;
      if (!assetId) {
        console.warn(`[email-to-mis] No asset ID returned for ${upload.filename}`);
        failed.push(upload.filename);
        continue;
      }

      // Resolve file content to binary
      let content: ArrayBuffer | Uint8Array;
      if (att.content instanceof ArrayBuffer) {
        content = att.content;
      } else if (att.content instanceof Uint8Array) {
        content = att.content;
      } else {
        content = new TextEncoder().encode(att.content as string);
      }

      // Step 2: Upload binary content
      let uploadOk = false;
      if (contentUri && contentId) {
        // 3-step flow: PUT directly to pre-signed URL (no auth needed)
        const uploadResp = await fetch(contentUri, {
          method: 'PUT',
          headers: { 'Content-Type': att.mimeType || 'application/octet-stream' },
          body: content,
        });
        if (uploadResp.ok) {
          console.log(`[email-to-mis] Uploaded ${upload.filename} to pre-signed URL`);

          // Step 3: Finalize upload
          const qs = `contentId=${encodeURIComponent(contentId)}&version=${encodeURIComponent(contentVersion)}&status=completed`;
          const finalizeResp = await fetch(`${apiUrl}/mis/assets/${assetId}/contentUploadStatus?${qs}`, {
            method: 'POST',
            headers,
          });
          if (finalizeResp.ok) {
            console.log(`[email-to-mis] Finalized upload for ${upload.filename}`);
            uploadOk = true;
          } else {
            const err = await finalizeResp.text().catch(() => '');
            console.warn(`[email-to-mis] Failed to finalize upload for ${upload.filename}: ${finalizeResp.status} ${err.slice(0, 200)}`);
          }
        } else {
          const err = await uploadResp.text().catch(() => '');
          console.warn(`[email-to-mis] Failed to upload to pre-signed URL for ${upload.filename}: ${uploadResp.status} ${err.slice(0, 200)}`);
        }
      } else {
        // Fallback: legacy single-step upload via proxy (for older S2 versions without contentUri)
        const uploadResp = await fetch(`${apiUrl}/mis/assets/${assetId}/content`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': att.mimeType || 'application/octet-stream' },
          body: content,
        });
        if (uploadResp.ok) {
          console.log(`[email-to-mis] Uploaded ${upload.filename} via legacy flow`);
          uploadOk = true;
        } else {
          const err = await uploadResp.text().catch(() => '');
          console.warn(`[email-to-mis] Failed to upload content for ${upload.filename}: ${uploadResp.status} ${err.slice(0, 200)}`);
        }
      }

      if (uploadOk) {
        uploaded.push(upload.filename);
        if (assetId) assetIds.push(assetId);
      } else {
        failed.push(upload.filename);
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] Asset upload error for ${upload.filename}: ${err.message}`);
      failed.push(upload.filename);
    }
  }

  return { uploaded, failed, assetIds };
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

// ─── AE Path ────────────────────────────────────────────────

// Minimal payload accepted by the /api/mis/create-job AE proxy (maps to
// /ws/JobCreation GET params server-side). Keep this lean — full spec lands
// on the WCP project later via the enrichment poller.
function buildAePayload(jobId: string, extracted: ExtractedJob): any {
  const payload: any = {
    jobName: extracted.job_name,
    jobId,
    jobPartId: `${jobId}-01`,
    customerCode: extracted.customer_match?.partnerId || '',
    description: extracted.description?.slice(0, 500) || extracted.job_name,
    category: extracted.request_type === 'reprint' ? 'Reprint' : 'Production',
  };
  if (extracted.print_process) payload.customField1 = extracted.print_process;
  return payload;
}

// Full S2 properties the poller will POST to /mis/projects once AE has
// provisioned the WCP project. Matches the upsert key on
// { MISId, jobId, jobPartId } — see functions/api/[[path]].js for the proxy.
function buildEnrichmentPayload(
  jobId: string,
  extracted: ExtractedJob,
  r2Uploads: R2Upload[],
  emailMeta?: EmailMeta
): any {
  const dueDateIso = safeDateIso(extracted.due_date);
  const description = buildDescription(extracted, r2Uploads);

  const attrs: Record<string, string> = {};
  const setAttr = (key: string, val: any) => {
    if (val != null && val !== '') attrs[key] = String(val);
  };
  setAttr('projectType', extracted.project_type || 'Prepress');
  setAttr('packagingType', extracted.packaging_type);
  if (extracted.dimensions) {
    const d = extracted.dimensions;
    setAttr('dimensions', `${d.width || '?'}x${d.height || '?'}${d.depth ? 'x' + d.depth : ''} ${d.unit || 'mm'}`);
  }
  setAttr('numColours', extracted.num_colours);
  if (extracted.colour_specs?.length) setAttr('colourSpecs', extracted.colour_specs.join(', '));
  if (extracted.finishing?.length) setAttr('finishing', extracted.finishing.join(', '));
  setAttr('substrate', extracted.substrate);
  setAttr('substrateWeight', extracted.substrate_weight);
  setAttr('bleed', extracted.bleed);
  setAttr('printProcess', extracted.print_process);
  setAttr('quantity', extracted.quantity);
  setAttr('isReprint', extracted.is_reprint === null ? null : (extracted.is_reprint ? 'Yes' : 'No'));
  setAttr('requestType', extracted.request_type);
  if (emailMeta) {
    setAttr('sourceEmail', emailMeta.from);
    setAttr('sourceEmailSubject', emailMeta.subject);
    setAttr('sourceEmailDate', emailMeta.date);
  }
  if (extracted.task_assignee?.email) setAttr('taskAssignee', extracted.task_assignee.email);

  const generalIDs: Record<string, string> = {};
  if (extracted.order_reference) generalIDs.PrintBuyerReference = extracted.order_reference;
  else if (emailMeta?.from) generalIDs.PrintBuyerReference = emailMeta.from;
  if (emailMeta?.subject) generalIDs.Project = emailMeta.subject;

  const properties: any = {
    MISId: 'MyMIS',
    jobId,
    jobPartId: `${jobId}-01`,
    description,
    dueDate: dueDateIso,
  };
  if (Object.keys(attrs).length) properties.attributes = { string: attrs };
  if (Object.keys(generalIDs).length) properties.generalIDs = generalIDs;

  // Barcodes — mirror the mapping used by buildS2Payload so barcodes
  // extracted from the email land on the enriched WCP project too.
  if (extracted.barcodes?.length) {
    const mapped = extracted.barcodes.map(mapBarcode).filter(Boolean);
    if (mapped.length) properties['Job-Barcodes'] = mapped;
  }

  return { properties };
}

// Retry backoff schedule for the enrichment poller (minutes). After the
// last entry is exhausted the row transitions to Enrichment-Failed.
const AE_ENRICHMENT_BACKOFF_MIN = [2, 5, 10, 30, 60, 120, 120, 120, 120, 120, 120, 120];

async function createAeJob(
  env: Env,
  apiUrl: string,
  connectionId: string,
  connectionName: string,
  jobId: string,
  extracted: ExtractedJob,
  r2Uploads: R2Upload[],
  attachments: ClassifiedAttachment[],
  emailMeta: EmailMeta | undefined,
  description: string
): Promise<any> {
  const aePayload = buildAePayload(jobId, extracted);
  const enrichmentPayload = buildEnrichmentPayload(jobId, extracted, r2Uploads, emailMeta);

  // Pair each R2 upload with the mime/category from the classified attachments
  // so the poller can re-fetch the bytes and re-upload to the S2 project.
  const pendingAttachments = r2Uploads.map((u) => {
    const cls = attachments.find((a) => a.filename === u.filename);
    return {
      key: u.r2Key,
      filename: u.filename,
      mime: cls?.mimeType || 'application/octet-stream',
      category: u.category,
    };
  });

  console.log(`[email-to-mis] Submitting job ${jobId} to AE (${connectionName || connectionId})...`);
  const aeResp = await fetch(`${apiUrl}/mis/create-job`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
      'X-MIS-Connection-Id': connectionId,
    },
    body: JSON.stringify(aePayload),
  });
  const aeText = await aeResp.text();
  let aeResponse: any;
  try { aeResponse = JSON.parse(aeText); } catch { aeResponse = { rawResponse: aeText.slice(0, 800) }; }

  const aeSucceeded = aeResp.ok && aeResponse?.ae_success !== false;

  const jobRecord: any = {
    job_id: jobId,
    job_name: extracted.job_name,
    customer_code: extracted.customer_match?.partnerId || '',
    customer_name: extracted.customer_match?.partnerName || '',
    status: aeSucceeded ? 'AE-Submitted' : 'AE-Failed',
    phase: aeSucceeded ? 'Awaiting WCP' : 'AE Error',
    due_date: extracted.due_date || null,
    description,
    connection_id: connectionId,
    connection_name: connectionName,
    solution: 'ae',
    cluster: '',
    payload: aePayload,
    wcp_response: aeResponse,
  };
  if (aeSucceeded) {
    jobRecord.enrichment_payload = enrichmentPayload;
    jobRecord.pending_attachments = pendingAttachments;
    jobRecord.enrichment_attempts = 0;
    // Due now — the fire-and-forget trigger below picks it up in seconds.
    // If the trigger is lost, the */2 enrichment cron catches it next tick.
    jobRecord.enrichment_next_at = new Date().toISOString();
  }

  const dbResp = await fetch(`${apiUrl}/mis/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
    },
    body: JSON.stringify(jobRecord),
  });
  const storedJob = dbResp.ok ? await dbResp.json() : jobRecord;

  if (!aeSucceeded) {
    console.warn(`[email-to-mis] AE creation failed for ${jobId}: HTTP ${aeResp.status} — ${JSON.stringify(aeResponse).slice(0, 300)}`);
  } else {
    console.log(`[email-to-mis] AE job ${jobId} submitted; enrichment scheduled now`);
    // Fire-and-forget: kick the enrichment poller on the capture-worker so
    // the row is picked up within seconds instead of waiting on the next
    // cron tick. Any failure is non-blocking — the cron is the safety net.
    try {
      await fetch('https://capture-worker.paul-land.workers.dev/trigger-enrichment', {
        method: 'POST',
      });
    } catch (err: any) {
      console.warn(`[email-to-mis] Enrichment trigger failed (non-blocking): ${err.message}`);
    }
  }

  return storedJob;
}

// ─── Workflow Launch ────────────────────────────────────────

interface WorkflowRule {
  request_type: string;
  template_id: string;
  template_name?: string;
  description?: string;
}

interface WorkflowRules {
  rules?: WorkflowRule[];
  default_template_id?: string | null;
}

async function launchWorkflowIfMatched(
  env: Env,
  projectNodeId: string,
  connectionId: string,
  requestType: string | null,
  uploadedAssetIds: string[],
  jobSupabaseId: string
): Promise<string | null> {
  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY,
    'X-MIS-Connection-Id': connectionId,
  };

  // Fetch connection to get workflow_rules
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.log('[email-to-mis] No Supabase config — skipping workflow launch');
    return null;
  }

  let workflowRules: WorkflowRules | null = null;
  try {
    const connResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/mis_connections?id=eq.${connectionId}&select=workflow_rules&limit=1`,
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
      workflowRules = rows?.[0]?.workflow_rules || null;
    }
  } catch (err: any) {
    console.warn(`[email-to-mis] Failed to fetch workflow_rules: ${err.message}`);
    return null;
  }

  if (!workflowRules?.rules?.length && !workflowRules?.default_template_id) {
    console.log('[email-to-mis] No workflow rules configured on this connection — skipping');
    return null;
  }

  // Match request_type against rules
  const reqType = requestType || 'new_job';
  let templateId: string | null = null;
  let templateName = '';

  if (workflowRules.rules?.length) {
    const match = workflowRules.rules.find(r => r.request_type === reqType);
    if (match) {
      templateId = match.template_id;
      templateName = match.template_name || match.template_id;
      console.log(`[email-to-mis] Workflow rule matched: ${reqType} → ${templateName} (${templateId})`);
    }
  }

  if (!templateId && workflowRules.default_template_id) {
    templateId = workflowRules.default_template_id;
    templateName = 'default';
    console.log(`[email-to-mis] Using default workflow template: ${templateId}`);
  }

  if (!templateId) {
    console.log(`[email-to-mis] No workflow rule matched for request_type="${reqType}" — skipping`);
    return null;
  }

  // Launch the workflow
  try {
    const launchResp = await fetch(`${apiUrl}/mis/workflow-templates/${templateId}/launch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: projectNodeId, inputs: uploadedAssetIds }),
    });
    if (!launchResp.ok) {
      const err = await launchResp.text().catch(() => '');
      console.warn(`[email-to-mis] Workflow launch failed (${launchResp.status}): ${err.slice(0, 300)}`);
      return null;
    }
    const launchResult = await launchResp.json() as any;
    const instanceId = launchResult?.id || null;
    console.log(`[email-to-mis] Workflow launched: ${templateName} → instance ${instanceId}`);

    // Update job record with workflow_instance_id
    if (instanceId && jobSupabaseId) {
      try {
        await fetch(`${apiUrl}/mis/jobs/${jobSupabaseId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Internal-API-Key': env.PAULLAND_INTERNAL_API_KEY },
          body: JSON.stringify({ workflow_instance_id: instanceId }),
        });
      } catch {}
    }

    return instanceId;
  } catch (err: any) {
    console.warn(`[email-to-mis] Workflow launch error: ${err.message}`);
    return null;
  }
}

export interface EmailMeta {
  from: string;
  subject: string;
  date: string;
}

export async function createMisJob(
  env: Env,
  extracted: ExtractedJob,
  r2Uploads: R2Upload[],
  autoSubmit = false,
  overrideConnectionId?: string,
  attachments?: ClassifiedAttachment[],
  emailMeta?: EmailMeta
): Promise<any> {
  const jobId = generateJobId();
  const description = buildDescription(extracted, r2Uploads);
  const apiUrl = env.PAULLAND_API_URL || 'https://paulland.io/api';
  const connectionId = overrideConnectionId || env.DEFAULT_MIS_CONNECTION_ID || DEFAULT_WCP_CONNECTION_ID;

  // Determine connection type (ae / wcp) and api_version (legacy / s2) from Supabase
  let apiVersion = env.DEFAULT_MIS_API_VERSION || 'legacy';
  let connectionType = 'wcp';
  let connectionName = '';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const connResp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/mis_connections?id=eq.${connectionId}&select=api_version,type,name,cluster&limit=1`,
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
        if (rows.length > 0) {
          if (rows[0].api_version) apiVersion = rows[0].api_version;
          if (rows[0].type) connectionType = rows[0].type;
          connectionName = rows[0].name || '';
          console.log(`[email-to-mis] Connection ${connectionName}: type=${connectionType}, api_version=${apiVersion}`);
        }
      }
    } catch (err: any) {
      console.warn(`[email-to-mis] Failed to look up connection: ${err.message}`);
    }
  }
  const isAe = connectionType === 'ae';
  const isS2 = apiVersion === 's2';

  // ─── AE path ──────────────────────────────────────────────
  // Send a minimal job to Automation Engine. AE provisions the WCP project
  // (preserving our jobId / jobPartId), and the capture-worker's enrichment
  // poller later upserts the full property set via S2 POST /projects.
  if (isAe) {
    return await createAeJob(
      env,
      apiUrl,
      connectionId,
      connectionName,
      jobId,
      extracted,
      r2Uploads,
      attachments || [],
      emailMeta,
      description
    );
  }

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
    let uploadedAssetIds: string[] = [];
    if (projectResult?.id && attachments?.length && r2Uploads.length) {
      console.log(`[email-to-mis] Uploading ${r2Uploads.length} attachments to S2 project ${projectResult.id}...`);
      const { uploaded, failed, assetIds } = await uploadAssetsToS2(env, projectResult.id, connectionId, attachments, r2Uploads);
      uploadedAssetIds = assetIds;
      if (uploaded.length) {
        console.log(`[email-to-mis] Uploaded ${uploaded.length} assets to S2. Cleaning up R2...`);
        await cleanupR2(env, r2Uploads, uploaded);
      }
      if (failed.length) {
        console.warn(`[email-to-mis] Failed to upload ${failed.length} assets: ${failed.join(', ')} (kept in R2)`);
      }
    }

    // Launch workflow if rules match the request type
    const storedJob = storeResp.ok ? await storeResp.json() : jobRecord;
    const jobSupabaseId = (Array.isArray(storedJob) ? storedJob[0]?.id : storedJob?.id) || '';
    if (projectResult?.id) {
      try {
        await launchWorkflowIfMatched(env, projectResult.id, connectionId, extracted.request_type, uploadedAssetIds, jobSupabaseId);
      } catch (err: any) {
        console.warn(`[email-to-mis] Workflow launch error (non-blocking): ${err.message}`);
      }
    }

    return storedJob;
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
