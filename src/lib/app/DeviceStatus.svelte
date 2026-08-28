<script>
  import { formatRelativeUtc } from "$lib/utils.js";
  import Battery from "@lucide/svelte/icons/battery";
  import BatteryCharging from "@lucide/svelte/icons/battery-charging";
  import BatteryLow from "@lucide/svelte/icons/battery-low";
  import BatteryWarning from "@lucide/svelte/icons/battery-warning";
  import Clock from "@lucide/svelte/icons/clock";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import WifiOff from "@lucide/svelte/icons/wifi-off";

  export let device = null;
  // Show the Online / Standby / Offline pill alongside the chips.
  export let showState = true;

  $: status = device?.status ?? null;

  function batteryIcon(s) {
    if (s.isCharging) return BatteryCharging;
    if (s.isLowPower || (s.battery ?? 100) <= 15) return BatteryWarning;
    if ((s.battery ?? 100) <= 40) return BatteryLow;
    return Battery;
  }

  function planLabel(s) {
    if (s.isLifetimePlan) return "Lifetime plan";
    if (s.planExpired || (s.planDaysRemaining != null && s.planDaysRemaining <= 0)) return "Plan expired";
    if (s.planDaysRemaining == null) return null;
    return `Plan: ${s.planDaysRemaining}d left`;
  }
</script>

{#if status}
  <span class="device-status">
    {#if showState}
      <span class="state" class:online={status.isOnline} class:standby={status.online === "standby"}>
        {status.online === "standby" ? "Standby" : status.isOnline ? "Online" : "Offline"}
      </span>
    {/if}

    {#if status.battery != null}
      {@const Icon = batteryIcon(status)}
      <span class="chip" class:warn={status.isLowPower || status.battery <= 15}>
        <Icon size={13} />{status.battery}%{status.isCharging ? " · charging" : ""}
      </span>
    {/if}

    {#if status.signal != null}
      {@const max = status.signalMax ?? 5}
      <span class="chip" class:warn={status.isOnline && status.signal <= 1}>
        {#if status.isOnline}
          <span class="bars" aria-hidden="true">
            {#each Array(max) as _, i}
              <span class="bar" class:on={i < status.signal} style={`height:${30 + (i / (max - 1)) * 70}%`}></span>
            {/each}
          </span>
          {status.isEsim ? "eSIM" : "Signal"} {status.signal}/{max}
        {:else}
          <WifiOff size={13} />No signal
        {/if}
      </span>
    {/if}

    {#if planLabel(status)}
      <span class="chip" class:warn={status.planExpiringSoon || status.planExpired}>
        {#if status.planExpiringSoon || status.planExpired}<TriangleAlert size={13} />{/if}
        {planLabel(status)}
      </span>
    {/if}

    {#if status.cloudStorage !== "none"}
      <span class="chip">Cloud {status.cloudStorage === "on" ? "on" : "available"}</span>
    {/if}

    {#if !status.isOnline && status.lastActiveUtc}
      <span class="chip"><Clock size={13} />Seen {formatRelativeUtc(status.lastActiveUtc)}</span>
    {/if}
  </span>
{/if}

<style>
  .device-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }

  .state::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
  }

  .state.online {
    color: #16a34a;
  }
  .state.standby {
    color: #d97706;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.7rem;
    line-height: 1.4;
    color: var(--muted-foreground);
    white-space: nowrap;
  }

  .chip.warn {
    color: #dc2626;
    border-color: color-mix(in srgb, #dc2626 40%, var(--border));
  }

  .bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 1.5px;
    height: 12px;
  }

  .bar {
    width: 3px;
    align-self: flex-end;
    background: currentColor;
    opacity: 0.25;
    border-radius: 1px;
  }

  .bar.on {
    opacity: 1;
  }
</style>
