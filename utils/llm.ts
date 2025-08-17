import { ChatOpenAI } from "@langchain/openai";
import { OpenAIEmbeddings } from "@langchain/openai";

/**
 * Minimal helper for creating ChatOpenAI instances with API key management
 * @param modelName - The model name (e.g., "gpt-5", "gpt-5-mini")
 * @param options - Configuration options including:
 *   - reasoning_effort: "minimal" | "low" | "medium" | "high" - Controls reasoning tokens
 *   - verbosity: "low" | "medium" | "high" - Controls output length
 */
export function createChatModel(modelName: string, options: any = {}) {
  const config: any = {
    modelName,
    openAIApiKey: process.env.OPENAI_API_KEY
  };
  
  if (options.temperature !== undefined) config.temperature = options.temperature;
  if (options.streaming !== undefined) config.streaming = options.streaming;
  
  // Initialize modelKwargs if we need to pass any model-specific parameters
  let modelKwargs: any = {};
  
  // Handle max_tokens - GPT-5 models need it in modelKwargs as max_completion_tokens
  if (options.max_tokens !== undefined) {
    modelKwargs.max_completion_tokens = options.max_tokens;
  }
  
  if (options.response_format !== undefined) {
    modelKwargs.response_format = options.response_format;
  }
  
  // Handle new GPT-5 reasoning parameters
  if (options.reasoning_effort !== undefined) {
    modelKwargs.reasoning_effort = options.reasoning_effort;
  }
  
  // Handle verbosity parameter
  if (options.verbosity !== undefined) {
    modelKwargs.verbosity = options.verbosity;
  }
  
  // Only set modelKwargs if we have parameters to pass
  if (Object.keys(modelKwargs).length > 0) {
    config.modelKwargs = modelKwargs;
  }
  
  return new ChatOpenAI(config);
}

/**
 * Minimal helper for creating OpenAIEmbeddings instances with API key management
 */
export function createEmbeddingModel(modelName: string = "text-embedding-3-small", options: any = {}) {
  return new OpenAIEmbeddings({
    model: modelName,
    openAIApiKey: process.env.OPENAI_API_KEY,
    ...options
  });
}