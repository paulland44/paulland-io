import type { RawAttachment, ClassifiedAttachment, AttachmentCategory } from './types.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.csv', '.tsv', '.md']);
const DOC_EXTENSIONS = new Set(['.docx', '.doc', '.xlsx', '.xls']);
const BINARY_EXTENSIONS = new Set(['.ai', '.psd', '.indd', '.tiff', '.tif', '.jpg', '.jpeg', '.png', '.gif', '.zip', '.rar', '.7z', '.ard']);

const TEXT_PDF_PATTERNS = /\b(spec|brief|order|form|sheet|tech|data|info|instruction|requirement)\b/i;
const ARTWORK_PDF_PATTERNS = /\b(artwork|art|print|final|press|proof|design|layout|ready|visual)\b/i;

const ARTWORK_SIZE_THRESHOLD = 5 * 1024 * 1024;  // 5MB
const TEXT_SIZE_THRESHOLD = 500 * 1024;            // 500KB

// Patterns for email signature/inline images to exclude
const SIGNATURE_FILENAME_PATTERNS = /^image\d{3}\[|^CustomerInsight|^logo|^banner|^footer|^signature/i;

export function classifyAttachments(attachments: RawAttachment[]): ClassifiedAttachment[] {
  return attachments
    .filter((att) => {
      // Filter out inline/embedded images (email signatures, logos, tracking pixels)
      if (isSignatureImage(att)) {
        console.log(`[classify] Skipping signature/inline image: ${att.filename}`);
        return false;
      }
      return true;
    })
    .map((att) => {
      const sizeBytes = getByteLength(att.content);
      const category = classifySingle(att.filename, att.mimeType, sizeBytes);
      return { ...att, category, sizeBytes };
    });
}

function isSignatureImage(att: RawAttachment): boolean {
  // Inline images with a Content-ID are embedded in the email body (signatures, logos)
  if (att.disposition === 'inline' && att.contentId) return true;

  // Small inline images are almost always signature/tracking
  if (att.disposition === 'inline' && att.mimeType.startsWith('image/')) {
    const size = getByteLength(att.content);
    if (size < 100 * 1024) return true; // < 100KB inline image = signature
  }

  // Known signature filename patterns from Outlook/email clients
  if (att.mimeType.startsWith('image/') && SIGNATURE_FILENAME_PATTERNS.test(att.filename)) {
    return true;
  }

  return false;
}

function classifySingle(filename: string, mimeType: string, sizeBytes: number): AttachmentCategory {
  const ext = getExtension(filename);

  // Known text-extractable document types
  if (TEXT_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext)) {
    return 'text';
  }

  // Known binary/design types
  if (BINARY_EXTENSIONS.has(ext)) {
    return 'binary';
  }

  // PDF classification — heuristic
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    // Check filename patterns first
    if (TEXT_PDF_PATTERNS.test(filename)) return 'text-pdf';
    if (ARTWORK_PDF_PATTERNS.test(filename)) return 'artwork-pdf';

    // Large files are almost certainly artwork
    if (sizeBytes > ARTWORK_SIZE_THRESHOLD) return 'artwork-pdf';

    // Default: treat unknown PDFs as artwork (safer to upload than miss)
    // Small PDFs can be proofs, logos, or simple artwork — don't skip them
    return 'artwork-pdf';
  }

  // Anything else → binary
  return 'binary';
}

function getByteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === 'string') return content.length;
  if (content instanceof Uint8Array) return content.byteLength;
  return (content as ArrayBuffer).byteLength;
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return '';
  return filename.slice(dot).toLowerCase();
}
