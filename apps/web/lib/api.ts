import { serverUrl } from "./config";

interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

export async function jsonRequest<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
  const response = await fetch(serverUrl(path), {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
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
  const response = await fetch(serverUrl(path), {
    method: "POST",
    credentials: "include",
    body: formData,
    cache: "no-store"
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Upload failed (${response.status}): ${payload}`);
  }

  return (await response.json()) as T;
}