export interface FeedConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface CategoryConfig {
  id: string;
  label: string;
  feeds: FeedConfig[];
  scorerPrompt: string;
  scoreThreshold: number;
  entityContext: string;
}
