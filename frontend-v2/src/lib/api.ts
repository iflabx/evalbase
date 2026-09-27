const PROJECT_ID = "project_demo";

export type Collection = {
  id: string;
  name: string;
  description: string;
  isUnfiled: boolean;
  fileCount: number;
  updatedAt: string;
  createdAt: string;
};

export type CollectionFile = {
  id: string;
  fileName: string;
  format: string;
  size: number;
  uploadedAt: string;
  status: string;
  sourceName: string | null;
  recordCount: number | null;
};

type CollectionPage = {
  collections: Collection[];
  pagination: { total: number; limit: number; offset: number };
};

type CollectionDetail = {
  collection: Collection;
  files: CollectionFile[];
  pagination: { total: number; limit: number; offset: number };
};

type Session = { csrfToken: string };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.code ?? `http_${response.status}`);
  }
  return response.json() as Promise<T>;
}

let ownerSession: Promise<string> | undefined;

export function ensureOwnerSession(): Promise<string> {
  ownerSession ??= (async () => {
    const current = await fetch("/api/session", { credentials: "include" });
    if (current.ok) {
      const session = (await current.json()) as Session;
      return session.csrfToken;
    }
    const session = await requestJson<Session>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return session.csrfToken;
  })().catch((error) => {
    ownerSession = undefined;
    throw error;
  });
  return ownerSession;
}

function queryString(filters: Record<string, string> = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  return query.size ? `?${query}` : "";
}

export const api = {
  collections(filters: Record<string, string> = {}) {
    return ensureOwnerSession().then(() =>
      requestJson<CollectionPage>(`/api/projects/${PROJECT_ID}/collections${queryString(filters)}`),
    );
  },
  collection(collectionId: string) {
    return ensureOwnerSession().then(() =>
      requestJson<CollectionDetail>(`/api/projects/${PROJECT_ID}/collections/${collectionId}`),
    );
  },
  createCollection(input: { name: string; description: string }) {
    return ensureOwnerSession().then((csrfToken) =>
      requestJson<{ collection: Collection }>(`/api/projects/${PROJECT_ID}/collections`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(input),
      }),
    );
  },
  renameCollection(collectionId: string, name: string) {
    return ensureOwnerSession().then((csrfToken) => {
      return requestJson<{ collection: Collection }>(
        `/api/projects/${PROJECT_ID}/collections/${collectionId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ name }),
        },
      );
    });
  },
};
