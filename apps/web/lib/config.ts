const isProd = process.env.NODE_ENV === "production";
const configuredServerUrl = process.env.NEXT_PUBLIC_SERVER_URL?.trim();

export const SERVER_URL =
  configuredServerUrl && configuredServerUrl.length > 0
    ? configuredServerUrl
    : isProd
      ? ""
      : "http://localhost:4000";

export function serverUrl(path: string): string {
  if (!SERVER_URL) {
    throw new Error(
      "NEXT_PUBLIC_SERVER_URL is missing in production. Set it in frontend host env and redeploy."
    );
  }
  return `${SERVER_URL}${path}`;
}

export function wsServerUrl(token: string): string {
  if (!SERVER_URL) {
    throw new Error(
      "NEXT_PUBLIC_SERVER_URL is missing in production. Set it in frontend host env and redeploy."
    );
  }
  const httpUrl = new URL(SERVER_URL);
  const protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${httpUrl.host}/chat?token=${encodeURIComponent(token)}`;
}
