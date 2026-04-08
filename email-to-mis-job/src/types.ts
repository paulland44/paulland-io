export interface Env {
  AI: Ai;
  R2_BUCKET: R2Bucket;
  PAULLAND_API_URL: string;
  PAULLAND_INTERNAL_API_KEY: string;
  TEST_SECRET: string;
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

export interface ExtractedJob {
  job_name: string;
  customer_match: CustomerMatch | null;
  description: string;
  due_date: string | null;
  print_process: string | null;
  substrate: string | null;
  quantity: string | null;
  is_reprint: boolean | null;
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
