/** Represents a notebook record in the database. */
export interface NotebookRecord {
  id: string; // UUID
  title: string;
  description: string | null;
  objectId: string; // Link to the corresponding JeffersObject
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
  // TSTP fields (aggregated from objects)
  summary?: string | null;
  tagsJson?: string | null;  // JSON string of string[]
  propositionsJson?: string | null;  // JSON string of propositions
  tstpGeneratedAt?: string | null;  // ISO timestamp
}

/** Extended notebook type with last accessed timestamp. */
export type RecentNotebook = NotebookRecord & {
  lastAccessed: string; // ISO 8601 timestamp
};