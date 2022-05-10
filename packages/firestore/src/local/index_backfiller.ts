/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  IndexOffset,
  indexOffsetComparator,
  newIndexOffsetFromDocument
} from "../model/field_index";
import {debugAssert} from "../util/assert";
import {AsyncQueue, DelayedOperation, TimerId} from "../util/async_queue";
import {logDebug} from "../util/log";

import {LocalDocumentsResult} from "./local_documents_view";
import {ignoreIfPrimaryLeaseLoss, LocalStore} from "./local_store";
import {Persistence, Scheduler} from "./persistence";
import {PersistencePromise} from "./persistence_promise";
import {PersistenceTransaction} from "./persistence_transaction";
import {isIndexedDbTransactionError} from "./simple_db";


const LOG_TAG = 'IndexBackiller';

/** How long we wait to try running index backfill after SDK initialization. */
const INITIAL_BACKFILL_DELAY_MS = 15;

/** Minimum amount of time between backfill checks, after the first one. */
const REGULAR_BACKFILL_DELAY_MS = 1;

/** The maximum number of documents to process each time backfill() is called. */
const MAX_DOCUMENTS_TO_PROCESS = 50;

export class IndexBackfillerScheduler implements Scheduler {

  private task: DelayedOperation<void> | null;

  constructor(
    private readonly asyncQueue: AsyncQueue,
    private readonly localStore: LocalStore,
    private readonly persistence: Persistence,
  ) {
    this.task = null;
  }

  start(): void {
    debugAssert(
      this.task === null,
      'Cannot start an already started IndexBackfillerScheduler'
    );
    this.schedule(INITIAL_BACKFILL_DELAY_MS);
  }

  stop(): void {
    if (this.task) {
      this.task.cancel();
      this.task = null;
    }
  }

  get started(): boolean {
    return this.task !== null;
  }

  private schedule(delay: number): void {
    debugAssert(
      this.task === null,
      'Cannot schedule IndexBackiller while a task is pending'
    );
    logDebug(LOG_TAG,`Scheduled in ${delay}ms`);
    this.task = this.asyncQueue.enqueueAfterDelay(
      TimerId.IndexBackfill,
      delay,
      async () => {
        this.task = null;
        try {
          const documentsProcessed = await this.backfill();
          logDebug(LOG_TAG, `Documents written: ${documentsProcessed}`);
        } catch (e) {
          if (isIndexedDbTransactionError(e)) {
            logDebug(
              LOG_TAG,
              'Ignoring IndexedDB error during index backfill: ',
              e
            );
          } else {
            await ignoreIfPrimaryLeaseLoss(e);
          }
        }
        await this.schedule(REGULAR_BACKFILL_DELAY_MS);
      }
    );
  }

  private async backfill(): Promise<number> {
    return this.persistence.runTransaction(
      'Backfill Indexes',
      'readwrite-primary',
      this.writeIndexEntries
    );
  }

  /** Writes index entries until the cap is reached. Returns the number of documents processed. */
  private writeIndexEntries(transation: PersistenceTransaction): PersistencePromise<number> {
    const processedCollectionGroups = new Set<string>();
    let documentsRemaining = MAX_DOCUMENTS_TO_PROCESS;
    let continueLoop = true;
    return PersistencePromise.whileLoop(
      () => continueLoop === true && documentsRemaining > 0,
      () => {
        return this.localStore.indexManager.getNextCollectionGroupToUpdate(transation)
          .next((collectionGroup: string | null) => {
            if (collectionGroup === null || processedCollectionGroups.has(collectionGroup)) {
              continueLoop = false;
            } else {
              logDebug(LOG_TAG, `Processing collection: ${collectionGroup}`);
              return this.writeEntriesForCollectionGroup(transation, collectionGroup, documentsRemaining)
                .next(documentsProcessed => {
                  documentsRemaining -= documentsProcessed;
                  processedCollectionGroups.add(collectionGroup);
                });
            }
          });
      }
    ).next(() => MAX_DOCUMENTS_TO_PROCESS - documentsRemaining);
  }

  /**
   * Writes entries for the provided collection group. Returns the number of documents processed.
   */
  private writeEntriesForCollectionGroup(
    transaction: PersistenceTransaction,
    collectionGroup: string,
    documentsRemainingUnderCap: number
  ): PersistencePromise<number> {
    // Use the earliest offset of all field indexes to query the local cache.
    return this.localStore.indexManager.getMinOffsetFromCollectionGroup(transaction, collectionGroup)
      .next(existingOffset => this.localStore.localDocuments
        .getNextDocuments(transaction, collectionGroup, existingOffset, documentsRemainingUnderCap)
        .next(nextBatch => this.localStore.indexManager.updateIndexEntries(transaction, nextBatch.documents)
          .next(() => this.getNewOffset(existingOffset, nextBatch))
          .next(newOffset => {
            logDebug(LOG_TAG, `Updating offset: ${newOffset}`);
            this.localStore.indexManager.updateCollectionGroup(transaction, collectionGroup, newOffset);
            return nextBatch.documents.size;
          })
        )
      );
  }

  /** Returns the next offset based on the provided documents. */
  private getNewOffset(
    existingOffset: IndexOffset,
    lookupResult: LocalDocumentsResult
  ): IndexOffset {
    let maxOffset: IndexOffset = existingOffset;
    lookupResult.documents.forEach((key, document) => {
      const newOffset: IndexOffset = newIndexOffsetFromDocument(document);
      if (indexOffsetComparator(newOffset, maxOffset) > 0) {
        maxOffset = newOffset;
      }
    });
    return new IndexOffset(
      maxOffset.readTime,
      maxOffset.documentKey,
      Math.max(lookupResult.batchId, existingOffset.largestBatchId)
    );
  }
}

