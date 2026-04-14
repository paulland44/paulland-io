import type { Env, ExtractedJob, PromptData } from './types.js';

const CUSTOMER_LIST = [
  { partnerId: 'DFG', partnerName: 'Dancing Fish Granola Co.' },
  { partnerId: 'FVB', partnerName: 'Frontier Valley Brewing Co.' },
  { partnerId: 'HaFi', partnerName: 'Happy Fish' },
  { partnerId: 'TPP', partnerName: 'The Packaging Place' },
  { partnerId: 'Toqe Inc.', partnerName: 'Toqe Inc.' },
  { partnerId: 'KKREM', partnerName: 'Krispy Kreme' },
  { partnerId: 'CPGCLI', partnerName: 'CPG Client' },
  { partnerId: 'Mozart', partnerName: 'Mozart' },
  { partnerId: 'Pinmark', partnerName: 'Pinmark' },
  { partnerId: 'PKG', partnerName: 'PK Graphics' },
  { partnerId: 'Quint', partnerName: 'Quint Co' },
  { partnerId: 'SACUGRA', partnerName: 'SACU Graphics Inc.' },
  { partnerId: 'Beneco', partnerName: 'Beneco' },
  { partnerId: 'XMARS', partnerName: 'Xtreme Mars' },
  { partnerId: 'VPG_ESKO', partnerName: 'Victory Path Games' },
  { partnerId: 'BELK', partnerName: 'BELK' },
  { partnerId: 'L343', partnerName: 'Lowes' },
  { partnerId: 'NCLOT', partnerName: 'North Carolina Lottery Commission' },
  { partnerId: 'WELK', partnerName: 'WELK' },
  { partnerId: 'Efle', partnerName: 'Esko_frle' },
  { partnerId: 'FREMO', partnerName: 'Frying Nemo' },
  { partnerId: 'Thai Tanic', partnerName: 'Thai Tanic' },
];

function buildExtractionPrompt(data: PromptData, customerList?: Array<{ partnerId: string; partnerName: string }>): string {
  const customers = customerList?.length ? customerList : CUSTOMER_LIST;
  const customerListJson = JSON.stringify(customers, null, 2);

  return `You are a job intake assistant at a packaging converter. Extract structured job information from the following email.

CUSTOMER MATCHING RULES:
You must identify the customer from the list below. Follow this priority order:
1. SUBJECT LINE FIRST — Scan the subject for a customer name match. This is your primary signal.
2. EMAIL BODY SECOND — Only if no match found in the subject, scan the body text.
3. SENDER DOMAIN THIRD — Only as a last resort, check if the sender's email domain relates to a customer.

Apply FUZZY matching at each stage. You must tolerate:
- Misspellings (e.g. "Krispy Kream" → Krispy Kreme, "Dancng Fish" → Dancing Fish Granola Co.)
- Shortened names (e.g. "DFG" → Dancing Fish Granola Co., "Frontier" → Frontier Valley Brewing Co.)
- Partial matches (e.g. "Victory Path" → Victory Path Games, "NC Lottery" → North Carolina Lottery Commission)
- Missing suffixes (e.g. "Dancing Fish Granola" → Dancing Fish Granola Co.)
- Abbreviations (e.g. "PK" → PK Graphics, "CPG" → CPG Client)
- Case differences (e.g. "krispy kreme" → Krispy Kreme)

If no customer can be matched even with fuzzy logic, set customer_match to null.

CUSTOMER LIST:
${customerListJson}

EMAIL METADATA:
- From: ${data.from_name} <${data.from_email}>
- Subject: ${data.subject}
- Date: ${data.date}

EMAIL BODY:
${data.body_text}

ATTACHMENT CONTENTS (text extracted from spec sheets, briefs, forms):
${data.attachment_texts || 'None'}

ARTWORK FILES (stored in R2, not readable — reference these in the job description):
${data.artwork_filenames.length > 0 ? data.artwork_filenames.join(', ') : 'None'}

OTHER ATTACHMENTS (stored in R2, not readable):
${data.other_filenames.length > 0 ? data.other_filenames.join(', ') : 'None'}

TASK ASSIGNEE RULES:
Determine who should receive the file upload task. Look for these patterns:
1. The sender mentions a third party to contact for files (e.g. "reach out to my agency at studio@designco.com", "contact our designer at jane@artwork.com", "get the files from bob@printer.com"). In this case, use that email address.
2. The sender asks to be notified where to upload files themselves (e.g. "let me know where I can upload", "send me the upload link", "I'll upload the artwork", "where should I send the files"). In this case, use the SENDER'S email address (${data.from_email}).
3. If neither pattern is found, set task_assignee to null.

Extract the following as JSON. Use null for any field you cannot determine:

{
  "job_name": "Short descriptive job name derived from the email",
  "customer_match": {
    "partnerId": "The partnerId from the customer list that best matches",
    "partnerName": "The matching partner name",
    "matched_text": "The exact text in the email that triggered the match",
    "matched_in": "subject | body | sender_domain",
    "confidence": "high | medium | low",
    "reasoning": "Brief explanation. If fuzzy matching was used, explain what was corrected"
  },
  "description": "Detailed job description compiled from all available information. Include substrate, dimensions, quantities, colours, finishing, and any other specs mentioned. Note any attached files.",
  "due_date": "ISO 8601 date if mentioned, otherwise null",
  "print_process": "Flexo | Litho | Digital | Gravure | null",
  "substrate": "Substrate type if mentioned",
  "quantity": "Quantity if mentioned",
  "is_reprint": true/false or null,
  "task_assignee": {
    "email": "The email address to assign the upload task to",
    "source": "third_party | sender | null",
    "reasoning": "Brief explanation of why this person was chosen"
  },
  "project_type": "Prepress | Production | null (Prepress if job involves artwork/design/proofing, Production if it involves printing/manufacturing)",
  "packaging_type": "Label | FoldingCarton | FlexiblePackaging | CorrugatedBox | Sleeve | Pouch | null",
  "dimensions": { "width": 100, "height": 80, "depth": null, "unit": "mm" },
  "num_colours": "Number of colours or description like 'CMYK + 2 spot' or null",
  "colour_specs": ["CMYK", "Pantone 485C", "Pantone 300C"],
  "finishing": ["Matt lamination", "Spot UV varnish", "Embossing", "Hot foil"],
  "substrate_weight": "Weight like '300gsm' or '12pt' or null",
  "bleed": "Bleed specification like '3mm' or null",
  "order_reference": "PO number, order reference, or purchase order if mentioned, otherwise null",
  "barcodes": [
    {
      "encoding": "GS1-QR | EAN-13 | UPC-A | Code128 | GS1-128 | GS1-DataMatrix | GS1-DataBar | ITF-14 | QR Code",
      "encodingDetails": "Specific variant or parameters if mentioned",
      "value": ["The barcode value/data"]
    }
  ]
}

Notes:
- dimensions: extract width, height, and optionally depth. Use mm if not specified. Set to null if no dimensions mentioned.
- colour_specs: list individual colours/inks mentioned (e.g. CMYK, specific Pantone numbers). Set to null if not mentioned.
- finishing: list all finishing processes mentioned (lamination, varnish, UV, embossing, foiling, die-cutting). Set to null if not mentioned.
- packaging_type: infer from context — "label" for self-adhesive/roll-fed, "FoldingCarton" for boxes/cartons, "FlexiblePackaging" for pouches/wrappers.
- barcodes: array of barcode specs if mentioned. Set to null if no barcodes mentioned.

Respond ONLY with valid JSON. No markdown, no explanation.`;
}

export async function extractJob(env: Env, data: PromptData, customerList?: Array<{ partnerId: string; partnerName: string }>): Promise<ExtractedJob> {
  const prompt = buildExtractionPrompt(data, customerList);

  const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
    messages: [
      { role: 'system', content: 'You extract structured data from emails. Respond only with valid JSON.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 1000,
    temperature: 0.1,
  });

  const raw = (response as any).response as string;
  return parseExtraction(raw);
}

function parseExtraction(raw: string): ExtractedJob {
  // Try direct JSON parse first
  try {
    return validateExtraction(JSON.parse(raw));
  } catch {
    // LLM sometimes wraps in markdown code fences
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return validateExtraction(JSON.parse(jsonMatch[1].trim()));
      } catch { /* fall through */ }
    }

    // Try to find a JSON object in the response
    const braceMatch = raw.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return validateExtraction(JSON.parse(braceMatch[0]));
      } catch { /* fall through */ }
    }
  }

  // Last resort: return a minimal extraction
  return {
    job_name: 'Unknown Job',
    customer_match: null,
    description: `LLM extraction failed. Raw email content should be reviewed manually.\n\nRaw LLM response:\n${raw}`,
    due_date: null,
    print_process: null,
    substrate: null,
    quantity: null,
    is_reprint: null,
    task_assignee: null,
    project_type: null,
    barcodes: null,
    packaging_type: null,
    dimensions: null,
    num_colours: null,
    colour_specs: null,
    finishing: null,
    substrate_weight: null,
    bleed: null,
    order_reference: null,
  };
}

function validateExtraction(obj: any): ExtractedJob {
  return {
    job_name: obj.job_name || 'Unknown Job',
    customer_match: obj.customer_match || null,
    description: obj.description || '',
    due_date: obj.due_date || null,
    print_process: obj.print_process || null,
    substrate: obj.substrate || null,
    quantity: obj.quantity || null,
    is_reprint: obj.is_reprint ?? null,
    task_assignee: obj.task_assignee?.email ? obj.task_assignee : null,
    project_type: obj.project_type || null,
    barcodes: Array.isArray(obj.barcodes) && obj.barcodes.length > 0
      ? obj.barcodes.filter((b: any) => b.encoding || b.value?.length)
      : null,
    packaging_type: obj.packaging_type || null,
    dimensions: obj.dimensions?.width || obj.dimensions?.height ? obj.dimensions : null,
    num_colours: obj.num_colours ? String(obj.num_colours) : null,
    colour_specs: Array.isArray(obj.colour_specs) && obj.colour_specs.length > 0 ? obj.colour_specs : null,
    finishing: Array.isArray(obj.finishing) && obj.finishing.length > 0 ? obj.finishing : null,
    substrate_weight: obj.substrate_weight || null,
    bleed: obj.bleed || null,
    order_reference: obj.order_reference || null,
  };
}
