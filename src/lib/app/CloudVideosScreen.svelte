<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import { api } from "$lib/api.js";
  import { getNativeCameraLayout } from "$lib/deviceLayout.js";

  // Cloud video playback, mirroring the decompiled app's cloud tab:
  //   - month calendar marks days with recordings (user/event_calendar)
  //   - day list via user/cloud_list with the app's timestamp arithmetic
  //   - playback/download via the signed URL from user/get_cloud_video_url

  export let devices = [];
  export let initialUid = null;
  export let onBack;

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  let uid = initialUid || null;
  $: if (!uid && devices.length) uid = devices[0].uid;
  let calYear = 0;
  let calMonth = 0; // 1-based
  let markedDays = new Set();
  let selectedDate = null; // { y, m, d }
  let videos = [];
  let page = 1;
  let total = 0;
  let loadingCalendar = false;
  let loadingList = false;
  let loadingMore = false;
  let busyUrl = false;
  let error = "";
  let track = 1;
  let signedUrl = "";
  let videoUrl = "";
  let videoName = "";

  $: activeDevice = devices.find((d) => d.uid === uid) || null;
  $: timeDiff = Number(activeDevice?.raw?.time_diff ?? activeDevice?.raw?.timeDiff ?? 0) || 0;
  $: summerTime = Number(activeDevice?.raw?.enable_dst ?? activeDevice?.raw?.enableDst ?? 0) === 1;

  function deviceNow() {
    return new Date(Date.now() + (timeDiff + (summerTime ? 3600 : 0)) * 1000);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function setError(message) {
    error = message;
  }

  async function loadCalendar() {
    if (!uid) return;
    loadingCalendar = true;
    error = "";
    try {
      const reply = await api("/api/cloud/calendar", {
        method: "POST",
        body: JSON.stringify({ uid, month: `${calYear}-${pad2(calMonth)}`, time_diff: timeDiff }),
      });
      const days = reply?.data?.days || [];
      markedDays = new Set(days.map(String));
    } catch (cause) {
      setError(cause.message || "Could not load the calendar.");
    } finally {
      loadingCalendar = false;
    }
  }

  // Mirrors the app's getTodayStartTime/chooseDate: device-local midnight,
  // corrected by time_diff + DST, sent with time_revised=true.
  function dayRange(y, m, d) {
    const utcMidnight = Date.UTC(y, m - 1, d) / 1000;
    const corrected = utcMidnight - timeDiff - (summerTime ? 3600 : 0);
    return [corrected, corrected + 86400];
  }

  async function loadDay(y, m, d, nextPage = 1) {
    if (!uid) return;
    loadingList = true;
    error = "";
    try {
      const [start, end] = dayRange(y, m, d);
      const reply = await api("/api/cloud/list", {
        method: "POST",
        body: JSON.stringify({ uid, start, end, page: nextPage, time_diff: timeDiff, summer_time: summerTime }),
      });
      const incoming = (reply.videos || []).filter((item) => item.status !== 1); // images only
      videos = nextPage === 1 ? incoming : [...videos, ...incoming];
      page = nextPage;
      total = reply.count?.total || videos.length;
    } catch (cause) {
      if (nextPage === 1) videos = [];
      setError(cause.message || "Could not load the video list.");
    } finally {
      loadingList = false;
      loadingMore = false;
    }
  }

  function selectDate(y, m, d) {
    selectedDate = { y, m, d };
    page = 1;
    videos = [];
    videoUrl = "";
    loadDay(y, m, d, 1);
  }

  function shiftMonth(delta) {
    const next = new Date(Date.UTC(calYear, calMonth - 1 + delta, 1));
    calYear = next.getUTCFullYear();
    calMonth = next.getUTCMonth() + 1;
    markedDays = new Set();
    loadCalendar();
  }

  function gridCells() {
    const first = new Date(Date.UTC(calYear, calMonth - 1, 1));
    const startDow = (first.getUTCDay() + 6) % 7; // Monday first
    const daysInMonth = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < startDow; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }

  function isSelected(d) {
    return selectedDate && selectedDate.y === calYear && selectedDate.m === calMonth && selectedDate.d === d;
  }

  // Two-sensor cameras record two video tracks in one mp4; offer them
  // separately (mirrors the app's split playback).
  $: twoSensor = Boolean(activeDevice && getNativeCameraLayout(activeDevice).showSecondaryStream);

  async function play(videoItem, startTrack = 1) {
    if (!uid) return;
    busyUrl = true;
    error = "";
    try {
      const reply = await api("/api/cloud/url", {
        method: "POST",
        body: JSON.stringify({
          uid,
          uuid: videoItem.uuid,
          bucketName: videoItem.bucketName,
          endpoint: videoItem.endpoint,
          cp: videoItem.cp,
          provider: videoItem.provider,
          image: videoItem.fileCloudPath,
        }),
      });
      const nextUrl = reply?.data?.video_url;
      if (!nextUrl) {
        setError(reply?.message || "The camera did not return a playback URL.");
        return;
      }
      signedUrl = nextUrl;
      videoName = `UBox_Cloud_${uid}_${videoItem.fileName}`;
      selectTrack(startTrack);
    } catch (cause) {
      setError(cause.message || "Could not get the playback URL.");
    } finally {
      busyUrl = false;
    }
  }

  function selectTrack(nextTrack) {
    if (!signedUrl) return;
    track = nextTrack;
    videoUrl = `/api/cloud/track?url=${encodeURIComponent(signedUrl)}&track=${nextTrack}`;
  }

  function trackName(fileName, n) {
    const base = fileName.replace(/\.mp4$/i, "");
    return `UBox_Cloud_${uid}_${base}_cam${n}.mp4`;
  }

  function downloadTrack(videoItem, n) {
    play(videoItem, n).then(() => {
      if (!signedUrl) return;
      const link = `/api/cloud/track?url=${encodeURIComponent(signedUrl)}&track=${n}&name=${encodeURIComponent(trackName(videoItem.fileName, n))}`;
      window.location.href = link;
    });
  }

  function download(videoItem) {
    play(videoItem).then(() => {
      if (!signedUrl) return;
      const link = `/api/cloud/download?url=${encodeURIComponent(signedUrl)}&name=${encodeURIComponent(`UBox_Cloud_${uid}_${videoItem.fileName}`)}`;
      window.location.href = link;
    });
  }

  function changeDevice(nextUid) {
    uid = nextUid;
    videos = [];
    markedDays = new Set();
    videoUrl = "";
    signedUrl = "";
    const next = devices.find((d) => d.uid === nextUid) || null;
    const td = Number(next?.raw?.time_diff ?? next?.raw?.timeDiff ?? 0) || 0;
    const st = Number(next?.raw?.enable_dst ?? next?.raw?.enableDst ?? 0) === 1;
    const now = new Date(Date.now() + (td + (st ? 3600 : 0)) * 1000);
    calYear = now.getUTCFullYear();
    calMonth = now.getUTCMonth() + 1;
    selectDate(calYear, calMonth, now.getUTCDate());
    loadCalendar();
  }

  $: if (uid && calYear === 0) {
    const now = deviceNow();
    calYear = now.getUTCFullYear();
    calMonth = now.getUTCMonth() + 1;
    selectDate(calYear, calMonth, now.getUTCDate());
    loadCalendar();
  }
</script>

<div class="stream-layout">
  <Card.Root>
    <Card.Header class="panel-head stream-head">
      <div>
        <Card.Title>Cloud Videos</Card.Title>
        <Card.Description>Recordings saved in the cloud for this camera.</Card.Description>
      </div>
      <div class="cloud-actions">
        <select class="cloud-device-select" bind:value={uid} onchange={() => changeDevice(uid)} aria-label="Camera">
          {#each devices as device}
            <option value={device.uid}>{device.name} ({device.uid})</option>
          {/each}
        </select>
        <Button variant="ghost" onclick={onBack}>Back</Button>
      </div>
    </Card.Header>

    <Card.Content>
      <div class="cloud-layout">
        <div class="cloud-calendar">
          <div class="cloud-calendar-head">
            <Button variant="outline" size="sm" onclick={() => shiftMonth(-1)} aria-label="Previous month">‹</Button>
            <span class="cloud-calendar-title">{MONTHS[calMonth - 1]} {calYear}</span>
            <Button variant="outline" size="sm" onclick={() => shiftMonth(1)} aria-label="Next month">›</Button>
          </div>
          <div class="cloud-calendar-grid">
            {#each WEEKDAYS as weekday}
              <div class="cloud-cal-weekday">{weekday}</div>
            {/each}
            {#each gridCells() as day}
              {#if day === null}
                <div class="cloud-cal-cell"></div>
              {:else}
                <button
                  type="button"
                  class="cloud-cal-cell"
                  class:marked={markedDays.has(String(day))}
                  class:selected={isSelected(day)}
                  onclick={() => selectDate(calYear, calMonth, day)}
                >
                  {day}
                </button>
              {/if}
            {/each}
          </div>
          <div class="cloud-hint">
            {#if loadingCalendar}
              Loading calendar…
            {:else}
              Days with recordings are marked. {markedDays.size === 0 ? "No recordings in this month." : ""}
            {/if}
          </div>
        </div>

        <div class="cloud-list">
          {#if videoUrl}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="cloud-player" controls autoplay playsinline src={videoUrl}></video>
            <div class="cloud-player-bar">
              <span class="cloud-hint">Now playing: {videoName}</span>
              {#if twoSensor}
                <div class="cloud-track-toggle">
                  <Button size="xs" variant={track === 1 ? "default" : "outline"} onclick={() => selectTrack(1)}>Cam 1</Button>
                  <Button size="xs" variant={track === 2 ? "default" : "outline"} onclick={() => selectTrack(2)}>Cam 2</Button>
                </div>
              {/if}
            </div>
          {/if}

          <div class="cloud-list-title">
            {selectedDate ? `${selectedDate.y}-${pad2(selectedDate.m)}-${pad2(selectedDate.d)}` : ""}
            <span class="cloud-hint">{total ? `${total} recording${total === 1 ? "" : "s"}` : ""}</span>
          </div>

          {#if error}
            <div class="cloud-error">{error}</div>
          {/if}

          {#if loadingList}
            <div class="cloud-hint">Loading recordings…</div>
          {:else if videos.length === 0}
            <div class="cloud-hint">{selectedDate ? "No recordings for this day." : "Select a day."}</div>
          {:else}
            <div class="cloud-videos">
              {#each videos as item}
                <div class="cloud-video-row">
                  {#if item.cloudImageUrl}
                    <img class="cloud-thumb" src={item.cloudImageUrl} alt="" loading="lazy" />
                  {/if}
                  <div class="cloud-video-info">
                    <div class="cloud-video-name">{item.recordTime || item.fileName}</div>
                    <div class="cloud-hint">
                      {item.duration ? `${item.duration}s` : ""}
                      {item.type ? ` · ${item.type}` : ""}
                    </div>
                  </div>
                  <div class="cloud-video-actions">
                    <Button size="sm" disabled={busyUrl} onclick={() => play(item)}>Play</Button>
                    {#if twoSensor}
                      <Button size="sm" variant="outline" disabled={busyUrl} onclick={() => downloadTrack(item, 1)}>Save Cam 1</Button>
                      <Button size="sm" variant="outline" disabled={busyUrl} onclick={() => downloadTrack(item, 2)}>Save Cam 2</Button>
                    {:else}
                      <Button size="sm" variant="outline" disabled={busyUrl} onclick={() => download(item)}>Save</Button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
            {#if videos.length < total}
              <div class="cloud-more">
                <Button variant="outline" disabled={loadingMore} onclick={() => loadDay(selectedDate.y, selectedDate.m, selectedDate.d, page + 1)}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </Card.Content>
  </Card.Root>
</div>

<style>
  .cloud-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cloud-device-select {
    max-width: 280px;
    height: 36px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--foreground);
    padding: 0 8px;
    font-size: 13px;
  }

  .cloud-layout {
    display: grid;
    grid-template-columns: minmax(220px, 300px) 1fr;
    gap: 18px;
  }

  .cloud-calendar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .cloud-calendar-title {
    font-size: 13px;
    font-weight: 700;
  }

  .cloud-calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 3px;
  }

  .cloud-cal-weekday {
    text-align: center;
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    padding: 2px 0;
  }

  .cloud-cal-cell {
    aspect-ratio: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: transparent;
    color: var(--foreground);
    font-size: 12px;
    cursor: pointer;
  }

  .cloud-cal-cell:hover {
    background: var(--accent);
  }

  .cloud-cal-cell.marked {
    background: color-mix(in oklch, var(--primary) 12%, transparent);
    border-color: var(--border);
    font-weight: 700;
  }

  .cloud-cal-cell.selected {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .cloud-list {
    display: grid;
    align-content: start;
    gap: 10px;
    min-width: 0;
  }

  .cloud-list-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: 14px;
    font-weight: 800;
  }

  .cloud-videos {
    display: grid;
    gap: 8px;
  }

  .cloud-video-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .cloud-thumb {
    width: 96px;
    height: 54px;
    object-fit: cover;
    border-radius: 6px;
    background: color-mix(in oklch, var(--background) 70%, black);
    flex-shrink: 0;
  }

  .cloud-video-info {
    display: grid;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .cloud-video-name {
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cloud-video-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .cloud-more {
    display: flex;
    justify-content: center;
  }

  .cloud-player {
    width: 100%;
    max-height: 320px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: color-mix(in oklch, var(--background) 70%, black);
  }

  .cloud-player-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .cloud-track-toggle {
    display: inline-flex;
    gap: 6px;
  }

  .cloud-hint {
    color: var(--muted-foreground);
    font-size: 12px;
  }

  .cloud-error {
    color: var(--destructive);
    font-size: 12px;
  }

  @media (max-width: 820px) {
    .cloud-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
