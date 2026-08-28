export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed: ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

export function flattenDevices(reply) {
  const data = reply?.data || {};
  const fromItems = (data.items || []).map((item) => ({
    uid: item.device_uid,
    name: item.device_name || item.ps_name || item.device_uid,
    owner: item.is_owner,
    source: "items",
    raw: item,
    devFunc: numberField(item.dev_func),
    ptzSupport: computePtzSupport(item),
    ptzPermission: hasPtzPermission(item),
  }));
  const firmwareByModel = new Map((data.firmware_ver || []).map((entry) => [String(entry.model_num), entry.version]));
  const fromInfos = (data.infos || []).map((info) => ({
    uid: info.device_uid,
    name: info.device_name || info.ps_name || info.device_uid,
    owner: info.is_owner,
    source: "infos",
    raw: info,
    devFunc: numberField(info.dev_func),
    ptzSupport: computePtzSupport(info),
    ptzPermission: hasPtzPermission(info),
    modelNum: info.model_num ? String(info.model_num) : null,
    latestFirmware: firmwareByModel.get(String(info.model_num)) || null,
    status: computeDeviceStatus(info),
  }));

  const merged = new Map();
  for (const device of [...fromItems, ...fromInfos]) {
    if (!device.uid) continue;
    merged.set(device.uid, { ...(merged.get(device.uid) || {}), ...device });
  }
  return [...merged.values()];
}

// Normalise the health/connectivity fields the app surfaces per device.
// Pulls from info.dynamic_info (battery, signal, online state) and
// info.card_info (cellular data plan).
function computeDeviceStatus(info) {
  const dynamic = info?.dynamic_info || {};
  const card = info?.card_info || {};

  const onlineCode = String(dynamic.online_state ?? "");
  const online = onlineCode === "2" ? "online" : onlineCode === "1" ? "standby" : "offline";

  const hasBattery = dynamic.battery != null;
  const batteryLevel = hasBattery ? Math.max(0, Math.min(100, Number(dynamic.battery))) : null;

  // The app renders the 4G/LTE indicator as 5 bars; `signal` is the filled count.
  const signalMax = 5;
  const hasSignal = dynamic.signal != null;
  const signalLevel = hasSignal ? Math.max(0, Math.min(signalMax, Number(dynamic.signal))) : null;

  const expireUtc = Number(card.expire_utc) || null;
  const planDaysRemaining =
    card.traffic_remain_day != null
      ? Number(card.traffic_remain_day)
      : expireUtc
        ? Math.round((expireUtc * 1000 - Date.now()) / 86400000)
        : null;

  return {
    online,
    isOnline: online === "online",
    lastActiveUtc: Number(dynamic.latest_active_utc) || null,
    battery: batteryLevel,
    isCharging: Boolean(dynamic.is_battery_charging),
    isLowPower: Boolean(dynamic.is_low_power),
    signal: signalLevel,
    signalMax,
    hasSim: Boolean(card.icc_id || card.icc_id_1 || card.esim_eid),
    isEsim: Boolean(card.using_card_is_esim || card.is_ubia_esim),
    planDaysRemaining,
    planExpiringSoon: card.card_pkg_expire_status === "soon_to_expire" || card.card_pkg_expire_status === "expired",
    planExpired: card.card_pkg_expire_status === "expired" || card.card_pkg_flow_status === "exhausted",
    isLifetimePlan: Boolean(card.is_lifetime_plan),
    cloudStorage: info?.has_cloud_storage ? (info?.is_cloud_storage_opened ? "on" : "available") : "none",
  };
}

function numberField(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0;
}

// dev_func bit 18 -> two-axis, bit 2 -> single-axis (app DeviceUtil).
function computePtzSupport(item) {
  const value = numberField(item?.dev_func);
  const hasBit = (index) => ((value >>> index) & 1) === 1;
  if (hasBit(18)) return "ptz2";
  if (hasBit(2)) return "ptz1";
  return "none";
}

// Owner or permissions containing "1" (app PermissionUtil).
function hasPtzPermission(item) {
  if (Number(item?.is_owner ?? item?.owner ?? 0) === 1) return true;
  const permissions = item?.permissions;
  return permissions == null || String(permissions).includes("1");
}
