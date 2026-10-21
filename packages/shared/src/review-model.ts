/** Model intent captured before asynchronous prompt preparation. Never inferred again at admission. */
export interface ReviewModelIntent {
  providerId: string;
  modelId: string;
  variant: string | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
