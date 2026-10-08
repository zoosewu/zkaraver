<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import Marquee from '../components/Marquee.svelte'
  import { api } from '../lib/api'
  import { t } from '../lib/i18n'
  import { toast } from '../lib/toast.svelte'
  import { connectRoom } from '../lib/ws'
  import type { QueueItem, RoomState } from '../lib/types'

  let { roomId }: { roomId: string } = $props()

  const INTRO_MS = 5000
  // Alternate-track sync (see syncAlt): jump beyond JUMP_S, otherwise nudge the
  // track's speed by NUDGE until it is within NUDGE_STOP_S again.
  const JUMP_S = 1
  const NUDGE_START_S = 0.08
  const NUDGE_STOP_S = 0.02
  const NUDGE = 0.03

  type Phase = 'checking' | 'playing' | 'kicked' | 'superseded' | 'notFound'
  let phase = $state<Phase>('checking')
  let room = $state<RoomState | null>(null)
  let roomUrl = $state('')
  let video = $state<HTMLVideoElement>()

  // The item whose video is loaded, and whether its "up next" intro is showing.
  let loaded = $state<QueueItem | null>(null)
  let intro = $state<QueueItem | null>(null)

  // Primitive deriveds only notify on real changes, not on every snapshot.
  // First connected player is active; the others wait in line and play nothing.
  const position = $derived(room?.self?.position ?? -1)
  const active = $derived(position === 0)
  const currentId = $derived(active ? (room?.current?.id ?? null) : null)
  const paused = $derived(room?.player.paused ?? false)
  const volume = $derived(room?.player.volume ?? 100)
  const restartNonce = $derived(room?.player.restartNonce ?? 0)
  const showQR = $derived(room?.player.showQR ?? true)
  const vocal = $derived(room?.player.vocal ?? false)
  const rate = $derived((room?.player.rate ?? 100) / 100)
  const seekNonce = $derived(room?.player.seekNonce ?? 0)
  const key = $derived(active ? (room?.player.key ?? 0) : 0)
  // Keys of the current song the server has rendered (see server/internal/keys).
  const keyReady = $derived(key !== 0 && (room?.player.keysReady ?? []).includes(key))
  const upNext = $derived(room?.queue[0] ?? null)
  const qrSrc = $derived(`/api/rooms/${roomId}/qr.png`)

  // No start screen: connect right away. Browsers only allow sound and fullscreen
  // after a user gesture, so the first tap anywhere unlocks both (see unlock()).
  // Kiosk-mode browsers (see README) need no tap at all.
  onMount(async () => {
    try {
      const info = await api<{ url: string }>('GET', `/api/rooms/${roomId}`)
      roomUrl = info.url
      phase = 'playing'
    } catch {
      phase = 'notFound'
    }
  })

  // One ID per browser tab, kept in sessionStorage so reconnects and reloads
  // reclaim the same place in the player line (see Room.addPlayerLocked).
  function instanceId(): string {
    const key = 'zkaraver.playerInstance'
    try {
      let id = sessionStorage.getItem(key)
      if (!id) {
        id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        sessionStorage.setItem(key, id)
      }
      return id
    } catch {
      return '' // no storage: behave like before (queue on every connect)
    }
  }

  function reconnect() {
    room = null
    phase = 'playing'
    unlock()
  }

  $effect(() => {
    if (phase !== 'playing') return
    return connectRoom(`/api/rooms/${roomId}/player/ws?instance=${encodeURIComponent(instanceId())}`, {
      onState: (s) => (room = s),
      onTerminal: (reason) =>
        (phase = reason === 'kicked' ? 'kicked' : reason === 'superseded' ? 'superseded' : 'notFound'),
    })
  })

  // ---- fullscreen ----
  // Kiosk mode fills the screen without the Fullscreen API, so also compare sizes.
  const isFullscreen = () =>
    !!document.fullscreenElement || (innerWidth >= screen.width - 1 && innerHeight >= screen.height - 1)
  let fullscreen = $state(isFullscreen())
  $effect(() => {
    const update = () => (fullscreen = isFullscreen())
    document.addEventListener('fullscreenchange', update)
    addEventListener('resize', update)
    return () => {
      document.removeEventListener('fullscreenchange', update)
      removeEventListener('resize', update)
    }
  })

  // TV remotes send key events (arrows / OK), not clicks, so any key also unlocks.
  $effect(() => {
    if (phase !== 'playing') return
    addEventListener('keydown', unlock)
    return () => removeEventListener('keydown', unlock)
  })

  function unlock() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
    if (blocked) tryPlay()
    syncAlt()
  }

  // ---- key change ----
  // The server renders every queued song at ±1..±6 ahead of time; the TV plays the
  // rendered track (see altSrc). If a key is asked for before it is ready, the TV
  // says so briefly and keeps the original key, switching over once it arrives.
  let keyNotice = $state(0)
  $effect(() => {
    const k = key
    if (!loaded || k === 0 || untrack(() => vocal || keyReady)) return
    keyNotice = k
    const timer = setTimeout(() => (keyNotice = 0), 3000)
    return () => {
      clearTimeout(timer)
      keyNotice = 0
    }
  })

  // ---- keep the screen awake ----
  // The Wake Lock API needs HTTPS (or localhost). Elsewhere, fall back to a tiny
  // muted looping video, which browsers treat as active playback.
  let wakeFallback = $state(!('wakeLock' in navigator))
  $effect(() => {
    if (phase !== 'playing' || wakeFallback) return
    let lock: WakeLockSentinel | null = null
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      navigator.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => (wakeFallback = true))
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      lock?.release()
    }
  })

  // ---- playback ----

  // New current song: show the intro card, then load the video.
  $effect(() => {
    const id = currentId
    if (phase !== 'playing') return
    if (id === null) {
      loaded = null
      intro = null
      return
    }
    if (untrack(() => loaded?.id) === id) return
    const item = untrack(() => room!.current!)
    loaded = null
    intro = item
    const timer = setTimeout(() => {
      intro = null
      loaded = item
    }, INTRO_MS)
    return () => clearTimeout(timer)
  })

  $effect(() => {
    if (!video || !loaded) return
    if (paused) video.pause()
    else tryPlay()
  })

  $effect(() => {
    const v = volume / 100
    if (video) video.volume = v
    for (const el of tracks.values()) el.volume = v
  })

  let lastNonce: number | null = null
  $effect(() => {
    const n = restartNonce
    if (lastNonce !== null && n !== lastNonce && video && loaded) {
      video.currentTime = 0
      tryPlay()
    }
    lastNonce = n
  })

  // Speed: the browser time-stretches and keeps the pitch (preservesPitch is on by
  // default). A new src resets playbackRate, so re-apply when the song changes.
  $effect(() => {
    void loaded
    const r = rate
    if (video) {
      video.defaultPlaybackRate = r
      video.playbackRate = r
    }
    for (const el of tracks.values()) el.playbackRate = r
  })

  // Relative seek (±3 s from the admin page). The original-vocal track follows
  // through the video's "seeked" event.
  let lastSeek: number | null = null
  $effect(() => {
    const n = seekNonce
    if (lastSeek !== null && n !== lastSeek && video && loaded) {
      const delta = untrack(() => room?.player.seekDelta ?? 0)
      const end = Number.isFinite(video.duration) ? video.duration - 0.5 : Infinity
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), end)
    }
    lastSeek = n
  })

  // Autoplay can still be refused (no gesture yet); a tap anywhere resumes.
  let blocked = $state(false)
  function tryPlay() {
    video
      ?.play()
      .then(() => (blocked = false))
      .catch((e: DOMException) => {
        if (e.name === 'NotAllowedError') blocked = true
      })
  }

  // ---- the video element ----
  // One <video> for the whole session. TVs have very few hardware decoders and may
  // not free a removed element's decoder in time for the next song, so songs only
  // swap its source, and between songs it is emptied to release the decoder.
  let videoStalled = false
  let retried = false

  $effect(() => {
    const v = video
    const item = loaded
    if (!v) return
    untrack(() => {
      if (!item) {
        releaseVideo()
        return
      }
      retried = false
      videoStalled = false
      v.src = `/media/${item.songId}`
      v.defaultPlaybackRate = rate // a new source resets playbackRate to this
      v.playbackRate = rate
      if (paused) v.pause()
      else tryPlay()
    })
  })

  function releaseVideo() {
    if (!video?.getAttribute('src')) return
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  onDestroy(releaseVideo)

  function videoError() {
    const item = loaded
    if (!item || !video?.getAttribute('src')) return // an emptied player, not a song
    const err = video.error
    dbg.error = err ? `${err.code} ${err.message}` : 'unknown'
    // One retry (a TV may still be releasing the previous decoder) before giving up.
    if (!retried) {
      retried = true
      const at = video.currentTime
      video.src = `/media/${item.songId}?retry=${Date.now()}`
      video.addEventListener('loadedmetadata', () => (video!.currentTime = at), { once: true })
      tryPlay()
      return
    }
    report(true)
  }

  // ---- diagnostics: add ?debug to the player URL ----
  const debug = new URLSearchParams(location.search).has('debug')
  const dbg = $state({ drift: 0, jumps: 0, stalls: 0, buffered: 0, error: '' })

  // ---- alternate audio: the karaoke video plays muted under another track ----
  // Used for original vocals (audio from the original-vocal file, never key-shifted)
  // and for key changes (audio rendered at another key by the server).
  // Files are assumed to share a timeline and follow the video's clock.
  //
  // Switching hands over without a gap: the new track loads and starts playing
  // muted, in sync, while the current sound continues; only once it is actually
  // playing does it become audible and the previous one go away. Going back to
  // the video's own sound is instant, since that is always in sync.
  let audioHost = $state<HTMLDivElement>()
  const tracks = new Map<string, HTMLAudioElement>()
  let audible = $state('') // src heard now; '' = the video's own sound
  let altFailed = $state('') // src that failed to load: keep the video's sound

  const altSrc = $derived.by(() => {
    if (!loaded) return ''
    if (vocal && loaded.hasOriginal) return `/media/${loaded.songId}/original`
    return keyReady ? `/media/${loaded.songId}/key/${key}` : ''
  })
  const altTarget = $derived(altSrc === altFailed ? '' : altSrc)

  $effect(() => {
    const want = altTarget
    void audioHost
    untrack(() => switchTo(want))
  })

  function switchTo(want: string) {
    for (const src of [...tracks.keys()]) if (src !== want && src !== audible) dropTrack(src)
    if (want === '') {
      makeAudible('')
      return
    }
    if (!tracks.has(want) && audioHost) addTrack(want)
    syncAlt()
  }

  function addTrack(src: string) {
    const el = document.createElement('audio')
    el.preload = 'auto'
    el.muted = true // until it takes over
    el.volume = volume / 100
    el.playbackRate = rate
    const takeOver = () => {
      if (src === altTarget && audible !== src) makeAudible(src)
    }
    el.addEventListener('loadedmetadata', syncAlt)
    el.addEventListener('playing', takeOver)
    // While the video is paused nothing plays; take over as soon as it could.
    el.addEventListener('canplay', () => {
      if (!video || video.paused) takeOver()
    })
    el.addEventListener('error', () => {
      altFailed = src
      if (audible === src) makeAudible('')
      dropTrack(src)
    })
    el.src = src
    tracks.set(src, el)
    audioHost!.append(el)
  }

  function makeAudible(src: string) {
    const previous = audible
    if (src) tracks.get(src)!.muted = false
    audible = src
    if (video) video.muted = src !== ''
    if (previous && previous !== src) dropTrack(previous)
  }

  function dropTrack(src: string) {
    const el = tracks.get(src)
    if (!el) return
    tracks.delete(src)
    el.pause()
    el.removeAttribute('src')
    el.load() // stop downloading
    el.remove()
  }

  onDestroy(() => {
    for (const src of [...tracks.keys()]) dropTrack(src)
  })

  // Keeping tracks on the video's clock. Small drift is corrected by playing the
  // track slightly faster or slower (inaudible, pitch is kept); only a large gap,
  // e.g. after the video stalled or was seeked, is closed with a jump. While the
  // video buffers, the tracks wait for it instead of running ahead.
  function syncAlt() {
    const v = video
    if (v && debug) {
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0
      dbg.buffered = Math.max(0, end - v.currentTime)
    }
    for (const el of tracks.values()) {
      if (!v || v.paused || v.ended || videoStalled) {
        if (!el.paused) el.pause()
        continue
      }
      const drift = el.currentTime - v.currentTime // > 0: the track is ahead
      if (audible && tracks.get(audible) === el) dbg.drift = drift
      if (Math.abs(drift) > JUMP_S) {
        el.currentTime = v.currentTime
        el.playbackRate = rate
        if (!el.muted) dbg.jumps++
      } else if (Math.abs(drift) > NUDGE_START_S) {
        el.playbackRate = rate * (drift > 0 ? 1 - NUDGE : 1 + NUDGE)
      } else if (Math.abs(drift) < NUDGE_STOP_S) {
        el.playbackRate = rate
      }
      if (el.paused) el.play().catch(() => {})
    }
  }

  $effect(() => {
    if (video) video.muted = audible !== ''
  })

  function report(failed: boolean) {
    const item = loaded
    const secret = room?.self?.secret
    if (!item || !secret) return
    if (failed) toast(t('player.playError'), 'error')
    api('POST', `/api/rooms/${roomId}/player/ended`, { playerSecret: secret, itemId: item.id, failed }).catch(() => {})
  }
</script>

{#if phase === 'checking'}
  <main class="center-screen"><p class="muted">{t('common.loading')}</p></main>
{:else if phase === 'notFound'}
  <main class="center-screen"><h2>{t('room.notFound')}</h2></main>
{:else if phase === 'superseded'}
  <main class="center-screen">
    <div class="narrow">
      <h2>{t('player.superseded')}</h2>
      <button class="primary" onclick={reconnect}>{t('player.useThisTab')}</button>
    </div>
  </main>
{:else if phase === 'kicked'}
  <main class="center-screen">
    <div class="narrow">
      <h2>{t('player.kicked')}</h2>
      <button class="primary" onclick={reconnect}>{t('player.reconnect')}</button>
    </div>
  </main>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="stage" onclick={unlock}>
    <!-- Alternate audio tracks live here (see addTrack); audio needs no layout. -->
    <div bind:this={audioHost} hidden></div>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      class:hidden={!loaded}
      autoplay
      playsinline
      onended={() => {
        syncAlt()
        if (loaded) report(false)
      }}
      onerror={videoError}
      onplay={syncAlt}
      onpause={syncAlt}
      onseeked={syncAlt}
      ontimeupdate={syncAlt}
      onwaiting={() => {
        videoStalled = true
        if (loaded) dbg.stalls++
        syncAlt()
      }}
      onplaying={() => {
        videoStalled = false
        syncAlt()
      }}
    ></video>
    {#if room && !active}
      <div class="idle">
        <h1>{room.settings.name}</h1>
        <p class="idle-hint">{t('player.waiting', { n: position })}</p>
        <p class="url">{t('player.waitingHint')}</p>
      </div>
    {:else}

      {#if intro}
        <div class="intro">
          <div class="kicker">{t('player.upNext')}</div>
          <div class="intro-title">{intro.title}</div>
          <div class="intro-artist">{intro.artist}</div>
          <div class="intro-singer">{t('player.singer', { name: intro.nickname })}</div>
        </div>
      {:else if !room?.current}
        <div class="idle">
          <h1>{room?.settings.name ?? ''}</h1>
          <img src={qrSrc} alt="QR code" width="320" height="320" />
          <p class="idle-hint">{t('player.idleTitle')}</p>
          <p class="url">{roomUrl}</p>
        </div>
      {/if}

      {#if loaded && blocked}
        <button class="primary start resume" onclick={tryPlay}>▶ {t('player.start')}</button>
      {/if}

      {#if loaded && showQR}
        <aside class="overlay">
          <img src={qrSrc} alt="QR code" width="120" height="120" />
          {#if upNext}
            <div class="next">
              <div class="kicker">{t('player.comingUp')}</div>
              <Marquee text={upNext.title} />
              <div class="ellipsis small">{upNext.nickname}</div>
            </div>
          {/if}
        </aside>
      {/if}
    {/if}

    {#if !fullscreen}
      <div class="tap-hint">{t('player.tapForFullscreen')}</div>
    {/if}
    {#if keyNotice}
      <div class="key-notice">{t('player.keyNotReady', { n: keyNotice > 0 ? `+${keyNotice}` : `${keyNotice}` })}</div>
    {/if}
    {#if key !== 0}
      <div class="key-badge">
        {t('player.key', { n: key > 0 ? `+${key}` : `${key}` })}{#if vocal && loaded?.hasOriginal}{t('room.keyVocal')}{/if}
      </div>
    {/if}

    {#if debug}
      <div class="debug">
        drift {(dbg.drift * 1000).toFixed(0)} ms · jumps {dbg.jumps} · stalls {dbg.stalls} · buffer {dbg.buffered.toFixed(1)} s{#if audible} · {audible}{/if}{#if dbg.error}<br />error {dbg.error}{/if}
      </div>
    {/if}
    {#if wakeFallback}
      <video class="nosleep" src="/nosleep.mp4" muted loop autoplay playsinline aria-hidden="true"></video>
    {/if}
  </div>
{/if}

<style>
  .start {
    display: grid;
    gap: 6px;
    padding: 24px 36px;
    font-size: 1.5rem;
    border-radius: 18px;
  }
  .resume {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    cursor: pointer;
  }
  .tap-hint {
    position: absolute;
    top: 2vh;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 0.8vh 2vw;
    border-radius: 99px;
    font-size: 2.2vh;
    pointer-events: none;
  }
  .key-notice {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.75);
    border: 1px solid rgba(255, 255, 255, 0.25);
    padding: 1.6vh 3vw;
    border-radius: 16px;
    font-size: 3vh;
    pointer-events: none;
  }
  .key-badge {
    position: absolute;
    top: 2vh;
    right: 2vw;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid var(--accent);
    color: #fff;
    padding: 0.6vh 1.4vw;
    border-radius: 99px;
    font-size: 2.4vh;
    pointer-events: none;
  }
  .nosleep {
    position: absolute;
    width: 2px;
    height: 2px;
    opacity: 0.01;
    pointer-events: none;
    bottom: 0;
    left: 0;
  }
  .stage {
    position: fixed;
    inset: 0;
    background: #000;
    color: #fff;
    cursor: none;
    overflow: hidden;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  video.hidden {
    display: none;
  }
  .debug {
    position: absolute;
    right: 1vw;
    bottom: 1vh;
    background: rgba(0, 0, 0, 0.7);
    padding: 0.5vh 1vw;
    border-radius: 8px;
    font: 1.6vh monospace;
    pointer-events: none;
  }
  .intro,
  .idle {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    text-align: center;
    gap: 1.5vh;
    padding: 5vw;
    background: radial-gradient(ellipse at center, #2a1630 0%, #000 75%);
  }
  .kicker {
    color: var(--accent);
    font-size: 2.2vh;
    letter-spacing: 0.2em;
  }
  .intro-title {
    font-size: 8vh;
    font-weight: 700;
    line-height: 1.15;
  }
  .intro-artist {
    font-size: 4vh;
    color: #ccc;
  }
  .intro-singer {
    font-size: 4vh;
    margin-top: 3vh;
    color: var(--accent);
  }
  .idle h1 {
    font-size: 6vh;
  }
  .idle img {
    width: 40vh;
    height: 40vh;
    background: #fff;
    border-radius: 2vh;
    padding: 1.5vh;
  }
  .idle-hint {
    font-size: 3.5vh;
    margin: 0;
  }
  .url {
    font-size: 2.2vh;
    color: #aaa;
    margin: 0;
  }
  /* Middle of the left edge: karaoke lyrics sit along the bottom, so keep clear of them. */
  .overlay {
    position: absolute;
    left: 2vw;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1.5vh;
    width: 22vw;
  }
  .overlay img {
    width: 14vh;
    height: 14vh;
    background: #fff;
    padding: 0.8vh;
    border-radius: 1vh;
    opacity: 0.92;
  }
  .next {
    background: rgba(0, 0, 0, 0.6);
    padding: 1vh 1.5vw;
    border-radius: 1vh;
    font-size: 2.4vh;
    min-width: 0;
    max-width: 100%;
  }
  .next .small {
    font-size: 2vh;
    color: #bbb;
  }
</style>
