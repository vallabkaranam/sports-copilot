export type ProgramFeedSlotId = 'program-a' | 'program-b' | 'program-c';

export type StoredProgramFeed = {
  slotId: ProgramFeedSlotId;
  fileName: string;
  fileSize: number;
  updatedAt: string;
  blob: Blob;
};

export type ProgramFeedSlot = {
  id: ProgramFeedSlotId;
  label: string;
  tone: string;
  source: 'preset' | 'upload';
  presetUrl?: string;
  presetFileName?: string;
};

const DATABASE_NAME = 'and-one-feed-library';
const DATABASE_VERSION = 1;
const STORE_NAME = 'program-feeds';

function supportsIndexedDb() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!supportsIndexedDb()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }

    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'slotId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  runner: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
) {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);

        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));

        runner(store, resolve, reject);
      }),
  );
}

export async function listStoredProgramFeeds(): Promise<StoredProgramFeed[]> {
  if (!supportsIndexedDb()) {
    return [];
  }

  return runTransaction<StoredProgramFeed[]>('readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result as StoredProgramFeed[]) ?? []);
    request.onerror = () => reject(request.error);
  }).catch(() => []);
}

export async function saveProgramFeed(
  slotId: ProgramFeedSlotId,
  file: File,
): Promise<StoredProgramFeed | null> {
  if (!supportsIndexedDb()) {
    return null;
  }

  const record: StoredProgramFeed = {
    slotId,
    fileName: file.name,
    fileSize: file.size,
    updatedAt: new Date().toISOString(),
    blob: file,
  };

  return runTransaction<StoredProgramFeed>('readwrite', (store, resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve(record);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
}

export async function clearProgramFeed(slotId: ProgramFeedSlotId): Promise<void> {
  if (!supportsIndexedDb()) {
    return;
  }

  await runTransaction<void>('readwrite', (store, resolve, reject) => {
    const request = store.delete(slotId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).catch(() => undefined);
}
