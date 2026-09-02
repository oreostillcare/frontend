import { Timestamp } from "firebase-admin/firestore";
import { vi } from "vitest";

export type StoredDocument = Record<string, unknown>;

export interface FakeDocumentReference {
  collectionName: string;
  id: string;
  create: (data: StoredDocument) => Promise<void>;
  delete: () => Promise<void>;
  get: () => Promise<FakeDocumentSnapshot>;
  set: (data: StoredDocument, options?: { merge?: boolean }) => Promise<void>;
  update: (data: StoredDocument) => Promise<void>;
}

export interface FakeDocumentSnapshot {
  data: () => StoredDocument | undefined;
  exists: boolean;
  id: string;
  ref: FakeDocumentReference;
}

interface WriteOperation {
  kind: "create" | "delete" | "set" | "update";
  reference: FakeDocumentReference;
  data?: StoredDocument;
  merge?: boolean;
}

function transformName(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const candidate = value as { _methodName?: unknown; constructor?: { name?: string } };
  return `${String(candidate._methodName ?? "")} ${String(candidate.constructor?.name ?? "")}`.toLowerCase();
}

function comparable(value: unknown) {
  if (value instanceof Timestamp) return value.toMillis();
  return value;
}

export function createFakeAdminFirestore() {
  const records = new Map<string, StoredDocument>();
  const references = new Map<string, FakeDocumentReference>();
  const batches: Array<ReturnType<typeof createBatch>> = [];
  const keyFor = (collectionName: string, id: string) => `${collectionName}/${id}`;

  const applyData = (current: StoredDocument, update: StoredDocument) => {
    const next = { ...current };
    for (const [field, value] of Object.entries(update)) {
      const name = transformName(value);
      if (name.includes("delete")) {
        delete next[field];
      } else if (name.includes("servertimestamp")) {
        next[field] = Timestamp.now();
      } else {
        next[field] = value;
      }
    }
    return next;
  };

  const applyOperation = async (operation: WriteOperation) => {
    const key = keyFor(operation.reference.collectionName, operation.reference.id);
    const current = records.get(key);
    if (operation.kind === "delete") {
      records.delete(key);
      return;
    }
    if (operation.kind === "create" && current) throw new Error(`Document already exists: ${key}`);
    if (operation.kind === "update" && !current) throw new Error(`Document does not exist: ${key}`);
    if (operation.kind === "set" && !operation.merge) {
      records.set(key, applyData({}, operation.data ?? {}));
      return;
    }
    records.set(key, applyData(current ?? {}, operation.data ?? {}));
  };

  const reference = (collectionName: string, id: string): FakeDocumentReference => {
    const key = keyFor(collectionName, id);
    const existing = references.get(key);
    if (existing) return existing;

    let created: FakeDocumentReference;
    created = {
      collectionName,
      id,
      create: vi.fn((data: StoredDocument) => applyOperation({ kind: "create", reference: created, data })),
      delete: vi.fn(() => applyOperation({ kind: "delete", reference: created })),
      get: vi.fn(async (): Promise<FakeDocumentSnapshot> => {
        const data = records.get(key);
        return { data: () => data, exists: data !== undefined, id, ref: created };
      }),
      set: vi.fn((data: StoredDocument, options?: { merge?: boolean }) =>
        applyOperation({ kind: "set", reference: created, data, merge: options?.merge }),
      ),
      update: vi.fn((data: StoredDocument) => applyOperation({ kind: "update", reference: created, data })),
    } satisfies FakeDocumentReference;
    references.set(key, created);
    return created;
  };

  const snapshotsFor = (collectionName: string) => {
    const snapshots: FakeDocumentSnapshot[] = [];
    for (const [key, data] of records) {
      const separator = key.indexOf("/");
      const storedCollection = key.slice(0, separator);
      const id = key.slice(separator + 1);
      if (storedCollection !== collectionName) continue;
      snapshots.push({ data: () => data, exists: true, id, ref: reference(collectionName, id) });
    }
    return snapshots;
  };

  const matches = (document: FakeDocumentSnapshot, field: string, operator: string, expected: unknown) => {
    const actualValue = comparable(document.data()?.[field]);
    const expectedValue = comparable(expected);
    if (operator === "==") return actualValue === expectedValue;
    if (operator === "in") return Array.isArray(expectedValue) && expectedValue.includes(actualValue);
    if (operator === "<=") return (actualValue as number) <= (expectedValue as number);
    if (operator === "<") return (actualValue as number) < (expectedValue as number);
    if (operator === ">=") return (actualValue as number) >= (expectedValue as number);
    if (operator === ">") return (actualValue as number) > (expectedValue as number);
    throw new Error(`Unsupported fake Firestore operator: ${operator}`);
  };

  const queryFor = (
    collectionName: string,
    filters: Array<{ field: string; operator: string; expected: unknown }> = [],
    maximum?: number,
  ) => {
    const get = vi.fn(async () => {
      const filtered = snapshotsFor(collectionName).filter((document) =>
        filters.every(({ field, operator, expected }) => matches(document, field, operator, expected)),
      );
      const docs = maximum === undefined ? filtered : filtered.slice(0, maximum);
      return { docs, empty: docs.length === 0 };
    });
    return {
      get,
      limit: vi.fn((value: number) => queryFor(collectionName, filters, value)),
      where: vi.fn((field: string, operator: string, expected: unknown) =>
        queryFor(collectionName, [...filters, { field, operator, expected }], maximum),
      ),
    };
  };

  const collection = vi.fn((collectionName: string) => ({
    doc: vi.fn((id: string) => reference(collectionName, id)),
    ...queryFor(collectionName),
  }));

  const createTransaction = () => {
    const operations: WriteOperation[] = [];
    return {
      operations,
      create: vi.fn((ref: FakeDocumentReference, data: StoredDocument) => {
        operations.push({ kind: "create", reference: ref, data });
      }),
      delete: vi.fn((ref: FakeDocumentReference) => {
        operations.push({ kind: "delete", reference: ref });
      }),
      get: vi.fn((ref: FakeDocumentReference) => ref.get()),
      set: vi.fn((ref: FakeDocumentReference, data: StoredDocument, options?: { merge?: boolean }) => {
        operations.push({ kind: "set", reference: ref, data, merge: options?.merge });
      }),
      update: vi.fn((ref: FakeDocumentReference, data: StoredDocument) => {
        operations.push({ kind: "update", reference: ref, data });
      }),
    };
  };

  const runTransaction = vi.fn(async (callback: (transaction: ReturnType<typeof createTransaction>) => unknown) => {
    const transaction = createTransaction();
    const result = await callback(transaction);
    for (const operation of transaction.operations) await applyOperation(operation);
    return result;
  });

  function createBatch() {
    const operations: WriteOperation[] = [];
    return {
      operations,
      commit: vi.fn(async () => {
        for (const operation of operations) await applyOperation(operation);
      }),
      create: vi.fn((ref: FakeDocumentReference, data: StoredDocument) => {
        operations.push({ kind: "create", reference: ref, data });
      }),
      delete: vi.fn((ref: FakeDocumentReference) => {
        operations.push({ kind: "delete", reference: ref });
      }),
      set: vi.fn((ref: FakeDocumentReference, data: StoredDocument, options?: { merge?: boolean }) => {
        operations.push({ kind: "set", reference: ref, data, merge: options?.merge });
      }),
      update: vi.fn((ref: FakeDocumentReference, data: StoredDocument) => {
        operations.push({ kind: "update", reference: ref, data });
      }),
    };
  }

  const batch = vi.fn(() => {
    const created = createBatch();
    batches.push(created);
    return created;
  });

  const adminDb = { batch, collection, runTransaction };

  const clear = () => {
    records.clear();
    references.clear();
    batches.length = 0;
    batch.mockClear();
    collection.mockClear();
    runTransaction.mockClear();
  };

  return {
    adminDb,
    api: adminDb,
    batch,
    batches,
    clear,
    collection,
    documents(collectionName: string) {
      return snapshotsFor(collectionName);
    },
    get(collectionName: string, id: string) {
      return records.get(keyFor(collectionName, id));
    },
    ref: reference,
    runTransaction,
    seed(collectionName: string, id: string, data: StoredDocument) {
      records.set(keyFor(collectionName, id), { ...data });
    },
  };
}
