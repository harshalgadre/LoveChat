export const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

export function serverUrl(path: string): string {
  return `${SERVER_URL}${path}`;
}

export function wsServerUrl(token: string): string {
  const httpUrl = new URL(SERVER_URL);
  const protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${httpUrl.host}/chat?token=${encodeURIComponent(token)}`;
}