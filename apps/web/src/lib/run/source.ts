/**
 * Where the player gets runs from. Today that's the static gallery: one JSON file per run.
 *
 * The seam for a live backend: a source yields the record as it grows. A static source yields
 * the finished record once. A live source (not built) would turn the pipeline's GenerateEvents
 * and the fix loop's IterationRecords, streamed over Server-Sent Events, into the same record
 * shape, yielding after each event, so the player and the timeline need no changes.
 */
import { asset } from '../base-path';
import type { GalleryIndex, RunRecord, SampleRecord } from '../gallery/types';
import { GALLERY_SCHEMA_VERSION } from '../gallery/types';

export interface RunSource {
  open(id: string, signal?: AbortSignal): AsyncIterable<RunRecord>;
}

async function getJson<T extends { schemaVersion: number }>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(asset(path), signal ? { signal } : {});
  if (!response.ok) throw new Error(`Couldn't load ${path} (HTTP ${response.status}).`);
  const data = (await response.json()) as T;
  if (data.schemaVersion !== GALLERY_SCHEMA_VERSION) {
    throw new Error(
      `${path} has schema version ${data.schemaVersion}; this site reads ${GALLERY_SCHEMA_VERSION}.`,
    );
  }
  return data;
}

export const staticRunSource: RunSource = {
  async *open(id, signal) {
    yield await getJson<RunRecord>(`gallery/${id}/run.json`, signal);
  },
};

export const loadGalleryIndex = (signal?: AbortSignal) =>
  getJson<GalleryIndex>('gallery/index.json', signal);
export const loadSample = (id: string, signal?: AbortSignal) =>
  getJson<SampleRecord>(`samples/${id}/sample.json`, signal);

/** URL of a file inside a run's or a sample's folder (images and heatmaps are relative to it). */
export const runFile = (id: string, path: string) => asset(`gallery/${id}/${path}`);
export const sampleFile = (id: string, path: string) => asset(`samples/${id}/${path}`);
