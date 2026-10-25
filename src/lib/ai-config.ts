import { AppError } from "./validation";

export type AIProvider = "openai" | "azure";
export type AIConfiguration = {
  provider: AIProvider;
  label: "OpenAI" | "Azure OpenAI";
  url: string;
  model: string;
  headers: Record<string, string>;
};
export function aiConfiguration(): AIConfiguration {
  const provider = process.env.AI_PROVIDER || "openai";
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.OPENAI_MODEL?.trim();
    if (!key || !model)
      throw new AppError(
        "AI is not connected yet. Set OPENAI_API_KEY and OPENAI_MODEL for AI_PROVIDER=openai, or explicitly select and configure AI_PROVIDER=azure. Curated trips and agency enquiries remain available.",
        503,
      );
    return {
      provider,
      label: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      model,
      headers: { Authorization: `Bearer ${key}` },
    };
  }
  if (provider !== "azure")
    throw new AppError(
      "AI_PROVIDER must be openai or azure. AI is unavailable until the server configuration is corrected; no provider fallback is performed.",
      503,
    );
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const key = process.env.AZURE_OPENAI_API_KEY?.trim();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
  if (!endpoint || !key || !deployment)
    throw new AppError(
      "Azure AI is not connected yet. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT for AI_PROVIDER=azure. Curated trips and agency enquiries remain available.",
      503,
    );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AppError(
      "AZURE_OPENAI_ENDPOINT must be a valid HTTPS Azure resource origin.",
      503,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9][a-z0-9-]*\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(
      url.hostname,
    )
  )
    throw new AppError(
      "AZURE_OPENAI_ENDPOINT must be an HTTPS Azure resource origin without a path, query or credentials. Custom gateways and private IP URLs are not supported by this MVP.",
      503,
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(deployment))
    throw new AppError(
      "AZURE_OPENAI_DEPLOYMENT must be the valid Azure deployment name, not a model endpoint URL.",
      503,
    );
  return {
    provider,
    label: "Azure OpenAI",
    url: `${url.origin}/openai/v1/chat/completions`,
    model: deployment,
    headers: { "api-key": key },
  };
}
export function aiStatus(): {
  ready: boolean;
  provider: AIProvider | null;
  label: string;
} {
  try {
    const config = aiConfiguration();
    return { ready: true, provider: config.provider, label: config.label };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const selected = process.env.AI_PROVIDER || "openai";
    return {
      ready: false,
      provider: selected === "openai" || selected === "azure" ? selected : null,
      label:
        selected === "azure"
          ? "Azure OpenAI"
          : selected === "openai"
            ? "OpenAI"
            : "AI provider",
    };
  }
}
