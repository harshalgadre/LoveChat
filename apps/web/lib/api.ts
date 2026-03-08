import { serverUrl } from "./config";
import { getSessionToken } from "./sessionToken";

interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

export async function jsonRequest<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
  const sessionToken = getSessionToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  const response = await fetch(serverUrl(path), {
    method: options.method ?? "GET",
    credentials: "include",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    throw new Error(`Request failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return (await response.json()) as T;
}

export async function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  const sessionToken = getSessionToken();
  const headers: Record<string, string> = {};
  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  const response = await fetch(serverUrl(path), {
    method: "POST",
    credentials: "include",
    headers,
    body: formData,
    cache: "no-store"
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Upload failed (${response.status}): ${payload}`);
  }

  return (await response.json()) as T;
}
