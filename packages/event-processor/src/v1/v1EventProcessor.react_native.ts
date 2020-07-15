/**
 * Copyright 2020, Optimizely
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  generateUUID,
  NotificationCenter,
  objectEntries,
} from '@optimizely/js-sdk-utils'
import {
  NetInfoState,
  addEventListener as addConnectionListener,
} from "@react-native-community/netinfo"
import { getLogger } from '@optimizely/js-sdk-logging'

import {
  getQueue,
  EventProcessor,
  ProcessableEvent,
  sendEventNotification,
  validateAndGetBatchSize,
  validateAndGetFlushInterval,
} from "../eventProcessor"
import { ReactNativeEventsStore } from '../reactNativeEventsStore'
import { EventQueue } from '../eventQueue'
import RequestTracker from '../requestTracker'
import { areEventContextsEqual } from '../events'
import { formatEvents } from './buildEventV1'
import {
  EventV1Request,
  EventDispatcher,
  EventDispatcherResponse,
} from '../eventDispatcher'

const logger = getLogger('ReactNativeEventProcessor')

const DEFAULT_MAX_QUEUE_SIZE = 10000
const PENDING_EVENTS_STORE_KEY = 'fs_optly_pending_events'
const EVENT_BUFFER_STORE_KEY = 'fs_optly_event_buffer'

/**
 * React Native Events Processor with Caching support for events when app is offline.
 */
export abstract class LogTierV1EventProcessor implements EventProcessor {
  // ? Is this really abstract? Are we extending it? 

  private dispatcher: EventDispatcher
  private queue: EventQueue<ProcessableEvent>
  private notificationCenter?: NotificationCenter
  private requestTracker: RequestTracker
  
  // ? What does Function | null = null mean?
  private unsubscribeNetInfo: Function | null = null
  private isInternetReachable: boolean = true
  private pendingEventsPromise: Promise<void> | null = null
  
  /**
   * This Stores Formatted events before dispatching. The events are removed after they are successfully dispatched.
   * Stored events are retried on every new event dispatch, when connection becomes available again or when SDK initializes the next time.
   // ? When SDK initializes the next time, we will have a new event store and a new pending
   // event store right? How will the previous events persist?

   */
  private pendingEventsStore: ReactNativeEventsStore<EventV1Request>
  
  /** 
   * This stores individual events generated from the SDK till they are part of the pending buffer.
   * The store is cleared right before the event is formatted to be dispatched.
   * This is to make sure that individual events are not lost when app closes before the buffer was flushed.
   */
  private eventBufferStore: ReactNativeEventsStore<ProcessableEvent>
  
  constructor({
    dispatcher,
    flushInterval = 30000,
    // ? Default batch size in SDKs is 10. Are we sure we want 3000?
    batchSize = 3000, 
    // ? optimizely-sdk/index.js only passes maxQueueSize when creating EP.
    // it should be passing batchSize instead
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    notificationCenter,
  }: {
    dispatcher: EventDispatcher
    flushInterval?: number
    batchSize?: number
    maxQueueSize?: number
    notificationCenter?: NotificationCenter
  }) {
    this.dispatcher = dispatcher
    this.notificationCenter = notificationCenter
    this.requestTracker = new RequestTracker()
    
    flushInterval = validateAndGetFlushInterval(flushInterval)
    batchSize = validateAndGetBatchSize(batchSize)
    this.queue = getQueue(batchSize, flushInterval, this.drainQueue.bind(this), areEventContextsEqual)
    this.pendingEventsStore = new ReactNativeEventsStore(maxQueueSize, PENDING_EVENTS_STORE_KEY)
    this.eventBufferStore = new ReactNativeEventsStore(maxQueueSize, EVENT_BUFFER_STORE_KEY)
  }

  async start(): Promise<void> {

    // ? Why not just keep a flag and console.log that eventproc is already running like
    // we do in other SDKs. Can use the queue.started flag.
    // we can avoid await this.processPendingEvents() and gettting from
    // eventbuffer store in this case. 
    // May be I am thinking in multi-threading mode.

    this.queue.start()
    this.unsubscribeNetInfo = addConnectionListener(this.connectionListener.bind(this))

    await this.processPendingEvents()
    // Process individual events pending from the buffer.
    const events: ProcessableEvent[] = await this.eventBufferStore.getEventsList()
    // ? getting events from eventBufferStore and process will add them again
    // with a different UUID in the event buffer store?
    events.forEach(this.process.bind(this))
  }
  
  // ? why only this method is private?
  private connectionListener(state: NetInfoState) {
    // What's the initial state of this.isInternetReachable? 
    // First if block won't be executed if the first time this callback is called
    // on intenet connection loss.
    if (this.isInternetReachable && !state.isInternetReachable) {
      this.isInternetReachable = false
      logger.debug('Internet connection lost')
      return
    }
    if (!this.isInternetReachable && state.isInternetReachable) {
      this.isInternetReachable = true
      logger.debug('Internet connection is restored, attempting to dispatch pending events')
      this.processPendingEvents()
    }
  }

  isSuccessResponse(status: number): boolean {
    return status >= 200 && status < 400
  }

  async drainQueue(buffer: ProcessableEvent[]): Promise<void> {
    // Retry pending failed events while draining queue
    await this.processPendingEvents()

    if (buffer.length === 0) {
      return
    }

    logger.debug('draining queue with %s events', buffer.length)

    const eventCacheKey = generateUUID()
    const formattedEvent = formatEvents(buffer)

    // Store formatted event before dispatching to be retried later in case of failure.
    await this.pendingEventsStore.set(eventCacheKey, formattedEvent)

    // ? 1. Just thinking. What if the app is closed at this point? We will resend the same events.
    // can the backend recgonize duplicates? 

    // ? 2. What if while we await above, more events are added to eventBufferStore, 
    // will also clear them below.

    // Clear buffer because the buffer has become a formatted event and is already stored in pending cache.
    await this.eventBufferStore.clear()

    return this.dispatchEvent(eventCacheKey, formattedEvent)
  }

  async processPendingEvents(): Promise<void> {
    logger.debug('Processing pending events from offline storage')
    // ? Why use a promise in this case? Why not a boolean flag?
    // Or are we using promise like a boolean here?
    if (!this.pendingEventsPromise){
      // Only process events if existing promise is not in progress
      this.pendingEventsPromise = this.getPendingEventsPromise()
    } else {
      logger.debug('Already processing pending events, returning the existing promise')
    }
    await this.pendingEventsPromise
    this.pendingEventsPromise = null
  }

  async getPendingEventsPromise(): Promise<void>{
    const formattedEvents: {[key: string]: any} = await this.pendingEventsStore.getEventsMap()
    const eventEntries = objectEntries(formattedEvents)
    logger.debug('Processing %s pending events', eventEntries.length)
    // Using for loop to be able to wait for previous dispatch to finish before moving on to the new one
    for (const [eventKey, event] of eventEntries) {
      await this.dispatchEvent(eventKey, event)
    }
  }

  async dispatchEvent(eventCacheKey: string, event: EventV1Request): Promise<void> {
    const requestPromise = new Promise<void>((resolve) => {
      this.dispatcher.dispatchEvent(event, async ({ statusCode }: EventDispatcherResponse) => {
        if (this.isSuccessResponse(statusCode)) {
          await this.pendingEventsStore.remove(eventCacheKey)
        } else {
          logger.warn('Failed to dispatch event, Response status Code: %s', statusCode)
        }
        resolve()
      })

      sendEventNotification(this.notificationCenter, event)
    })
    // Tracking all the requests to dispatch to make sure request is completed before fulfilling the `stop` promise
    this.requestTracker.trackRequest(requestPromise)
    return requestPromise
  }

  process(event: ProcessableEvent): void {
    // Adding events to buffer store. If app closes before dispatch, we can reprocess next time the app initializes
    this.eventBufferStore.set(generateUUID(), event)
    this.queue.enqueue(event)
  }

  stop(): Promise<void> {
    // ? Will this method reject Promise in any case? Because we are internally
    // cathing any errors. 
    this.unsubscribeNetInfo && this.unsubscribeNetInfo()
    // swallow - an error stopping this queue shouldn't prevent this from stopping
    try {
      this.queue.stop()
      return this.requestTracker.onRequestsComplete()
    } catch (e) {
      logger.error('Error stopping EventProcessor: "%s"', e.message, e)
    }
    return Promise.resolve()
  }
}
