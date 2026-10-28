import { storage } from './storage'
import type { Song } from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}

const TOKEN_KEY = 'zkaraver.token'

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const token = storage.get(TOKEN_KEY)
  if (token) headers['Authorization'] = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  if (!res.ok) {
    let code = 'internal'
    try {
      code = (await res.json()).error ?? code
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export function errorCode(e: unknown): string {
  return e instanceof ApiError ? e.code : 'internal'
}

let session: Promise<string> | null = null

/** Returns the anonymous user id, creating an identity on first visit. */
export function ensureSession(): Promise<string> {
  session ??= api<{ userId: string; token: string }>('POST', '/api/session', {
    token: storage.get(TOKEN_KEY) ?? '',
  }).then((r) => {
    storage.set(TOKEN_KEY, r.token)
    return r.userId
  })
  session.catch(() => (session = null))
  return session
}

export function userToken(): string {
  return storage.get(TOKEN_KEY) ?? ''
}

export type SongSort = 'artist' | 'title' | 'new' | 'popular'
export type ArtistSort = 'name' | 'count'
export interface Artist {
  name: string // "" = unknown artist
  songs: number
}

/**
 * artist: only that artist's songs ("" = unknown artist); folder: only songs in that
 * folder ("" = the top; with a query, anywhere below it). Omit either for all.
 */
export function searchSongs(q: string, offset: number, sort: SongSort = 'artist', artist?: string, folder?: string) {
  const p = new URLSearchParams({ q, offset: String(offset), limit: '50', sort })
  if (artist !== undefined) p.set('artist', artist)
  if (folder !== undefined) p.set('folder', folder)
  return api<{ items: Song[]; more: boolean }>('GET', `/api/songs?${p}`)
}

export interface Folder {
  name: string
  songs: number // in it and all its subfolders
}

/** Subfolders of a folder ("" = the top of the library); a query keeps folders with a match. */
export function listFolders(path: string, q: string) {
  return api<{ items: Folder[] }>('GET', `/api/folders?${new URLSearchParams({ path, q })}`)
}

export function listArtists(q: string, offset: number, sort: ArtistSort = 'name') {
  const p = new URLSearchParams({ q, offset: String(offset), limit: '100', sort })
  return api<{ items: Artist[]; more: boolean }>('GET', `/api/artists?${p}`)
}
