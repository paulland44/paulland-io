export interface Env {
  AI: Ai;
  R2_BUCKET: R2Bucket;
  PAULLAND_API_URL: string;
  PAULLAND_INTERNAL_API_KEY: string;
  TEST_SECRET: string;
  DEFAULT_MIS_CONNECTION_ID?: string;
  DEFAULT_MIS_API_VERSION?: string; // 'legacy' | 's2' (deprecated, use email_prefix on connections)
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

export interface ParsedEmail {
  from: { address: string; name: string };
  subject: string;
  date: string;
  textBody: string;
  htmlBody: string;
  attachments: RawAttachment[];
}

export interface RawAttachment {
  filename: string;
  mimeType: string;
  content: ArrayBuffer | Uint8Array | string;
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
}

export type AttachmentCategory = 'text-pdf' | 'artwork-pdf' | 'text' | 'binary';

export interface ClassifiedAttachment {
  filename: string;
  mimeType: string;
  content: ArrayBuffer | Uint8Array | string;
  category: AttachmentCategory;
  sizeBytes: number;
}

export interface R2Upload {
  filename: string;
  r2Key: string;
  category: AttachmentCategory;
}

export interface CustomerMatch {
  partnerId: string;
  partnerName: string;
  matched_text: string;
  matched_in: 'subject' | 'body' | 'sender_domain';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface TaskAssignee {
  email: string;
  source: 'third_party' | 'sender' | null;
  reasoning: string;
}

export interface BarcodeSpec {
  encoding: string;
  encodingDetails: string;
  value: string[];
}

export interface Dimensions {
  width: number | null;
  height: number | null;
  depth: number | null;
  unit: string; // mm, cm, in
}

export interface ExtractedJob {
  job_name: string;
  customer_match: CustomerMatch | null;
  description: string;
  due_date: string | null;
  print_process: string | null;
  substrate: string | null;
  quantity: string | null;
  is_reprint: boolean | null;
  task_assignee: TaskAssignee | null;
  project_type: string | null; // Prepress | Production
  barcodes: BarcodeSpec[] | null;
  // Enriched packaging fields
  packaging_type: string | null; // Label, FoldingCarton, FlexiblePackaging, CorrugatedBox, Sleeve, Pouch
  dimensions: Dimensions | null;
  num_colours: string | null; // e.g. "4" or "CMYK + 2 spot"
  colour_specs: string[] | null; // e.g. ["CMYK", "Pantone 485C"]
  finishing: string[] | null; // e.g. ["Matt lamination", "Spot UV varnish"]
  substrate_weight: string | null; // e.g. "300gsm"
  bleed: string | null; // e.g. "3mm"
  order_reference: string | null; // PO number or order ref
}

export interface PromptData {
  from_name: string;
  from_email: string;
  subject: string;
  date: string;
  body_text: string;
  attachment_texts: string;
  artwork_filenames: string[];
  other_filenames: string[];
}

export interface ProcessingResult {
  extracted: ExtractedJob;
  jobRecord: any;
  r2Uploads: R2Upload[];
  logs: string[];
}
