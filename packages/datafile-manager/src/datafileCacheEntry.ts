export interface DatafileCacheEntry {
  timestamp: number
  datafile: object
  lastModified?: string
}

export function deserializeObject(val: any): DeserializationResult<DatafileCacheEntry> {
  if (typeof val !== 'object' || val === null) {
    return { type: 'failure', error: new Error('Not an object') }
  }

  const obj: { [index: string]: any } = val

  const maybeTimestamp: any = obj.timestamp
  if (typeof maybeTimestamp !== 'number') {
    return { type: 'failure', error: new Error('Invalid timestamp') }
  }
  const timestamp: number = maybeTimestamp

  const maybeDatafile: any = obj.datafile
  if (typeof maybeDatafile !== 'object' || maybeDatafile === null) {
    return { type: 'failure', error: new Error('Invalid datafile') }
  }
  const datafile: object = maybeDatafile

  const maybeLastModified: any = obj.lastModified
  let lastModified: string | undefined = undefined
  if (typeof maybeLastModified === 'string') {
    lastModified = maybeLastModified
  }

  return {
    type: 'success',
    entry: {
      timestamp,
      datafile,
      lastModified,
    },
  }
}

export interface DeserializationFailure {
  type: 'failure'
  error: Error
}

export interface DeserializationSuccess<K> {
  type: 'success'
  entry: K
}

export type DeserializationResult<K> = DeserializationFailure | DeserializationSuccess<K>