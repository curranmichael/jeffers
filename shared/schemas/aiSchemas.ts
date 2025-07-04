import { z } from 'zod';

/**
 * Schema for AI-generated content from PDF processing
 */
// @claude please confirm that this is the contentschema we're sending to the AI for PDF parsing
// @claude bottom line is that we are going to need to define all of these things in the same location - for PDFs and URLs. We must do so without creating any new information. So we first need to identify and evaluate every place where we're currently defining such information. Then, we need to make an architectural decision about which of those places to maintain as the place to define such information. Then, we need to align the mechanisms that are used. Then, we need to make sure the routing is efficient and any deprecated/obsolete code and patterns are removed.
export const AiGeneratedContentSchema = z.object({
  title: z.string().min(1, "Title cannot be empty"),
  summary: z.string().min(1, "Summary cannot be empty"),
  tags: z.array(z.string()).min(1, "At least one tag is required"),
  propositions: z.array(z.object({
    type: z.enum(['main', 'supporting', 'action', 'fact']),
    content: z.string()
  })).optional()
});

export type AiGeneratedContent = z.infer<typeof AiGeneratedContentSchema>;

/**
 * Schema for object-level propositions
 */
export const ObjectPropositionsSchema = z.object({
  main: z.array(z.string()),
  supporting: z.array(z.string()),
  actions: z.array(z.string()).optional()
});

export type ObjectPropositions = z.infer<typeof ObjectPropositionsSchema>;

/**
 * Schema for parsed AI responses that might be wrapped in markdown code blocks
 */
export const AiResponseSchema = z.union([
  AiGeneratedContentSchema,
  z.string() // For cases where we need to extract from markdown
]);

/**
 * Parse and validate AI response, handling markdown code blocks
 */
export function parseAiResponse(response: unknown): AiGeneratedContent | null {
  // If it's already an object, try to validate directly
  if (typeof response === 'object' && response !== null) {
    const result = AiGeneratedContentSchema.safeParse(response);
    if (result.success) {
      return result.data;
    }
  }

  // If it's a string, try to extract JSON from markdown
  if (typeof response === 'string') {
    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        const result = AiGeneratedContentSchema.safeParse(parsed);
        if (result.success) {
          return result.data;
        }
      } catch {
        // JSON parse failed
      }
    }
    
    // Try direct JSON parse
    try {
      const parsed = JSON.parse(response);
      const result = AiGeneratedContentSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}