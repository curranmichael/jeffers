import { MediaType } from './vector.types';

/** Possible statuses for an ingested object. */
export type ObjectStatus = 'new' | 'pending' | 'processing' | 'fetched' | 'parsed' | 'chunking' | 'chunked' | 'chunking_failed' | 'embedding' | 'embedded' | 'embedding_failed' | 'error' | 'pdf_processed' | 'embedding_in_progress' | 'complete';

/** Represents a top-level object in the system (corresponds to 'objects' table). */
export interface JeffersObject {
  id: string; // UUID v4
  objectType: MediaType; // Standardized media types
  sourceUri: string | null;
  title: string | null;
  status: ObjectStatus;
  rawContentRef: string | null;
  parsedContentJson?: string | null; // Optional: JSON string of ReadabilityParsed
  cleanedText?: string | null; // Optional: Plain text cleaned for embedding
  errorInfo?: string | null; // Optional: Details of fetch/parse errors
  parsedAt?: string; // ISO 8601 timestamp
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
  // PDF-specific fields
  fileHash?: string | null; // SHA256 hash of the PDF file content
  originalFileName?: string | null; // Original name of the uploaded file
  fileSizeBytes?: number | null; // Size of the PDF file in bytes
  fileMimeType?: string | null; // Detected MIME type
  internalFilePath?: string | null; // Path to our stored copy in user_data/pdfs
  aiGeneratedMetadata?: string | null; // JSON blob for {title, summary, tags}
  // Object-level summary fields
  summary?: string | null; // High-level document summary
  propositionsJson?: string | null; // JSON array of key claims/facts
  tagsJson?: string | null; // JSON array of main topics/themes
  summaryGeneratedAt?: string | null; // ISO 8601 timestamp
  // WOM support fields
  lastAccessedAt?: string; // ISO 8601 timestamp
  childObjectIds?: string[]; // Array of child object IDs (for composite objects like tab groups)
  // Cognitive fields
  objectBio?: string; // Validated JSON (ObjectBioSchema) - temporal events and lifecycle
  objectRelationships?: string; // Validated JSON (ObjectRelationshipsSchema) - rich connections
}

/** Structure for object propositions */
export interface ObjectPropositions {
  main: string[];        // Key claims/facts
  supporting: string[];  // Supporting details
  facts?: string[];      // Specific data points (dates, numbers, etc.)
  actions?: string[];    // Actionable items (if any)
}

/** Represents the parsed content extracted by Mozilla Readability. */
export interface ReadabilityParsed {
  title: string;
  byline: string | null;
  dir: string | null; // Text direction
  content: string; // HTML content
  textContent: string; // Plain text content
  length: number; // Length of textContent
  excerpt: string | null;
  siteName: string | null;
}

/** Result of deleting objects. */
export interface DeleteResult {
  successful: string[];          // Successfully deleted object IDs
  failed: string[];             // Failed object IDs  
  notFound: string[];           // Object IDs that don't exist
  orphanedChunkIds?: string[];  // Chunk IDs that failed vector store deletion
  vectorError?: Error;          // Vector store errors (non-fatal)
  sqliteError?: Error;          // SQLite errors (fatal)
}