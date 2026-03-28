# WebCenter Pack API Reference

## Overview
WebCenter Pack is Esko's cloud-based packaging workflow management platform. This reference documents the External API for creating and managing jobs programmatically.

> **Note**: The API is currently in BETA. Endpoints may change. Swagger planned for release Nov 2025 (v2547).

## Authentication
- **Method**: Equipment Token (created in Global Admin > Equipment section)
- **Header**: `EskoCloud-Token: <token>`
- Token shown only once at creation — store securely
- Designed for system-to-system auth

## Configuration Parameters
| Parameter | Description | Example |
|-----------|-------------|---------|
| `REGION` | Organization region (`eu` or `us`) | `eu` |
| `ECAN` | S2 Account / Esko Cloud Account Number | `a-p-1000-2000-3000-4000` |
| `REPOID` | Repository identifier | `3nKzFgB9WbXPNj` |
| `EQUIPMENT_TOKEN` | Auth token from Global Admin | (secret) |

## Base URLs

| API Type | EU | US |
|----------|----|----|
| W2P API | `https://w2p.eu.esko.cloud` | `https://w2p.us.esko.cloud` |
| IAM API | `https://iam.eu.esko.cloud` | `https://iam.us.esko.cloud` |
| WebSocket | `wss://repo.eu.esko.cloud` | `wss://repo.us.esko.cloud` |

## Required Headers
```
EskoCloud-Token: <token>
Content-Type: application/json  (for PUT/POST requests)
```

---

## API Endpoints

### 1. Get Customers
- **Method**: GET
- **URL**: `https://iam.{region}.esko.cloud/rest/iam/organizations/{ecan}/partners?start=0&length=100&sortType=partnerName&filterValue=Customers`
- **Key Response Fields**: `partnerId` (used as `customerCode`), `partnerName`

### 2. Get Task Templates
- **Method**: GET
- **URL**: `https://w2p.{region}.esko.cloud/api/v1/{repoID}/Home/tasktemplates`
- **Response Structure**: `templates.system`, `templates.custom.global`, `templates.custom.customer`
- **Key Field**: Node ID (object key) → used as `taskTemplateNodeId`

### 3. Get Product Templates
- **Method**: GET
- **URL**: `https://w2p.{region}.esko.cloud/PACKPRODUCTEMPLATE/v0/{repoID}/Home/getallproducttemplates`
- **Response Structure**: Same as task templates
- **Key Fields**: Template name (object key), `productTypeDetails` (display name)

### 4. Get Preflight Profiles
- **Method**: GET
- **URL**: `https://w2p.{region}.esko.cloud/api/v0/{ecan}/preflightprofiles`
- **Key Response Fields**: `nodeId`, `name`

### 5. Create Job
- **Method**: PUT
- **URL**: `https://w2p.{region}.esko.cloud/api/v0/{ecan}/createjob`
- **Required Fields**:
  - `siteName` — typically "Home"
  - `customerCode` — partnerId from Customers API
  - `jobName` — descriptive name
  - `jobId` — unique ID you generate
  - `dueDate` — ISO 8601 (e.g., `"2025-10-30T23:59:59.000Z"`)
  - `tasks[]` — array of task objects
- **Task Object**:
  ```json
  {
    "taskTemplateNodeId": "<node-id>",
    "properties": {
      "dueDate": 1730332799000,
      "subject": "optional subject",
      "message": "optional instructions",
      "allowFiles": true,
      "fileType": ["PDF", "JPG"],
      "referencedocument": false
    },
    "assignee": [{ "id": "email@example.com" }]
  }
  ```
- **Optional Fields**: `productTemplates[]`, `description`, task properties

### 6. Get Job Details
- **Method**: GET
- **URL**: `https://w2p.{region}.esko.cloud/api/v0/{ecan}/getJobDetails/{jobId}`
- **Response Fields**: `jobId`, `name`, `status`, `phase`, `dueDate`, `creationDate`, `modificationDate`, `nodeId`, creator info, etc.

### 7. Edit Job (Update Status/Properties)
- **Method**: POST
- **URL**: `https://w2p.{region}.esko.cloud/api/v0/{repoID}/{jobID}/editjob`
- **Payload Options**:
  ```json
  {
    "status": { "status": "Active", "phase": "Prepress" },
    "products": {
      "addProductNodeIds": ["id1"],
      "removeProductNodeIds": ["id2"]
    },
    "dueDate": 1730332799000
  }
  ```

### 8. Download Job Assets
- **Method**: GET
- **URL**: `https://w2p.{region}.esko.cloud/api/v0/{repoID}/{jobID}/downloadjobassets`
- **Process**: 3-step (initiate → WebSocket progress → download ZIP)
- **Response**: `progressID`, `progressPath` (for WebSocket monitoring)

---

## Job Status Values
| Status | Description |
|--------|-------------|
| Created | Not yet started |
| Active | In progress |
| On Hold | Temporarily paused |
| Completed | Finished successfully |
| Cancelled | Cancelled |
| Failed | Error state |

## Job Phase Values
| Phase | Description |
|-------|-------------|
| Draft | Being prepared |
| Waiting For Files | Awaiting uploads |
| Files Arrived | Files received, ready for processing |
| Prepress | Files being prepared for production |
| Production | In active production |
| Delivered | Final deliverables provided |

## Date Formats
- **Job `dueDate`**: ISO 8601 — `"2025-10-30T23:59:59.000Z"`
- **Task `properties.dueDate`**: Unix timestamp in milliseconds — `1730332799000`

---

## Example Job Creation Payload
```json
{
  "siteName": "Home",
  "customerCode": "ACME-001",
  "jobName": "Acme Spring Product Label",
  "jobId": "MIS-ACME-001-0042",
  "dueDate": "2025-10-30T23:59:59.000Z",
  "description": "New product label for spring collection",
  "productTemplates": ["FlexibleLabel"],
  "tasks": [
    {
      "taskTemplateNodeId": "<node-id-from-templates-api>",
      "properties": {
        "dueDate": 1730332799000,
        "subject": "Upload Artwork",
        "message": "Please upload the final artwork files",
        "allowFiles": true,
        "fileType": ["PDF"],
        "referencedocument": false
      },
      "assignee": [
        { "id": "designer@acmecorp.com" }
      ]
    }
  ]
}
```

---

## Dev/Test Clusters
In addition to production EU/US clusters, dev/test environments use different domains:

| Cluster | Base URL |
|---------|----------|
| `future.dev.cloudi.city` | `https://w2p.future.dev.cloudi.city` |
| `next.dev.cloudi.city` | `https://w2p.next.dev.cloudi.city` |
| `qa-eu-1.test.cloudi.city` | `https://w2p.qa-eu-1.test.cloudi.city` |
| `qa-eu-2.test.cloudi.city` | `https://w2p.qa-eu-2.test.cloudi.city` |

IAM URLs follow the same pattern: `https://iam.{cluster}`

## Integration Notes
- Polling for status: recommend 30-60 second intervals minimum
- Use Job ID (not name) for lookups — more reliable
- Download URLs may be time-limited — download promptly
- ZIP files can be large (hundreds of MB to GB)
- Equipment Token has specific permissions/scopes — create separate tokens per integration
- **`description` field is required** in job creation payload — must be a string (empty string `""` is valid, `null` is not)
- **Esko gateway may block Cloudflare Worker IPs** — tokens work from direct curl but may fail when proxied through Cloudflare Workers. Workaround: proxy decrypts token server-side and forwards request.
- **Customer list**: Some test accounts may not have partners configured in IAM (`/iam/organizations/{ecan}/partners` returns 0 results). Customers may be configured differently on dev/test systems.
- **`getJobDetails` known issue**: May return `session.invalid` (401) or `not found` (404) even with valid tokens. The endpoint may require different identifiers (nodeId, jobName) than the custom jobId used during creation.
