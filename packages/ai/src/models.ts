export const getOllamaBaseUrl = () =>
  (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");

export const getDefaultModel = () => process.env.OLLAMA_MODEL?.trim() || "llama3.2:latest";

export const isAiEnabled = () => process.env.OLLAMA_ENABLED?.toLowerCase() !== "false";

