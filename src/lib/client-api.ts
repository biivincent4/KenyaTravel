export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public path: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: data ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.error || "The request could not be completed.",
      response.status,
      path,
    );
  return result as T;
}
